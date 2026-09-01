#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { createDatabase, DEFAULT_DB_PATH } = require('../src/db/db');
const { seasonKey } = require('../src/domain/seasons');
const shikimori = require('../src/services/shikimori');

const ANILIST_URL = 'https://graphql.anilist.co';
const SEASON_QUERY = `
  query ($season: MediaSeason, $year: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage currentPage }
      media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC) {
        id
        idMal
        title { romaji english native }
        nextAiringEpisode { airingAt episode }
        episodes
        averageScore
        coverImage { large }
        genres
        status
      }
    }
  }
`;

function toAnilistSeason(s) {
  return String(s).toUpperCase();
}

async function fetchAnilistSeason(season, year) {
  const normalized = String(season).toLowerCase();
  const anilistSeason = toAnilistSeason(normalized);
  const records = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    console.log(`[AniListFallback] Fetching ${anilistSeason} ${year} page ${page}`);
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: SEASON_QUERY, variables: { season: anilistSeason, year, page } })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`AniList ${res.status} ${txt.slice(0,200)}`);
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const pageData = json.data.Page;
    for (const m of pageData.media) {
      if (!m.idMal) continue;
      const statusMap = { 'FINISHED': 'Finished Airing', 'RELEASING': 'Currently Airing', 'NOT_YET_RELEASED': 'Not yet aired', 'CANCELLED': 'Cancelled' };
      records.push({
        mal_id: m.idMal,
        anilist_id: m.id,
        title_en: m.title.english || m.title.romaji || null,
        title_jp: m.title.native || m.title.romaji || null,
        poster_url: m.coverImage?.large || null,
        score_anilist: m.averageScore || null,
        episodes_total: m.episodes || null,
        genres: JSON.stringify(m.genres || []),
        airing_status: statusMap[m.status] || null,
        next_ep_num: m.nextAiringEpisode?.episode || null,
        next_ep_at: m.nextAiringEpisode?.airingAt || null,
        season: seasonKey(year, normalized)
      });
    }
    hasNext = pageData.pageInfo.hasNextPage;
    page++;
  }
  console.log(`[AniListFallback] Fetched ${records.length} for ${normalized} ${year}`);
  return records;
}

async function main() {
  const args = process.argv.slice(2);
  // allow custom list: node seed-anilist-fallback.js 2025 fall 2026 winter etc as pairs, or default to 4 seasons
  let targets = [];
  if (args.length >= 2) {
    for (let i = 0; i < args.length; i += 2) {
      const year = parseInt(args[i], 10);
      const season = args[i+1];
      if (year && season) targets.push({ year, season: season.toLowerCase() });
    }
  } else {
    targets = [
      { year: 2025, season: 'fall' },
      { year: 2025, season: 'winter' },
      { year: 2026, season: 'fall' },
      { year: 2026, season: 'winter' },
    ];
  }

  console.log(`[FallbackSeed] Targets: ${targets.map(t => `${t.season} ${t.year}`).join(', ')}`);
  const repository = createDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
  repository.init();

  for (const { year, season } of targets) {
    console.log(`\n=== Seeding ${season} ${year} via AniList fallback ===`);
    try {
      const records = await fetchAnilistSeason(season, year);
      // Optionally fetch Shikimori for RU titles - do in batch but limited
      const malIds = records.map(r => r.mal_id);
      console.log(`[Shikimori] Fetching RU data for ${malIds.length} entries (this will take ~${Math.ceil(malIds.length*0.7)}s)...`);
      const shiki = await shikimori.fetchBatch(malIds);
      const shikiMap = shiki.records;

      let inserted = 0;
      let preserved = 0;
      function choose(candidates, existing) {
        const v = candidates.find(x => x !== undefined && x !== null && x !== '');
        if (v !== undefined) return v;
        if (existing !== undefined && existing !== null) preserved++;
        return existing ?? null;
      }

      repository.transaction(() => {
        for (const rec of records) {
          const existing = repository.getAnimeByMalId(rec.mal_id) || {};
          const sh = shikiMap.get(rec.mal_id) || {};
          const merged = {
            mal_id: rec.mal_id,
            title_en: choose([rec.title_en], existing.title_en),
            title_jp: choose([rec.title_jp], existing.title_jp),
            title_ru: choose([sh.title_ru], existing.title_ru),
            synopsis_en: choose([], existing.synopsis_en),
            synopsis_ru: choose([sh.synopsis_ru], existing.synopsis_ru),
            poster_url: choose([rec.poster_url], existing.poster_url),
            score_mal: choose([], existing.score_mal),
            score_anilist: choose([rec.score_anilist], existing.score_anilist),
            score_shiki: choose([sh.score_shiki], existing.score_shiki),
            episodes_total: choose([rec.episodes_total], existing.episodes_total),
            season: rec.season,
            airing_status: choose([rec.airing_status], existing.airing_status),
            airing_day: choose([], existing.airing_day),
            next_ep_num: choose([rec.next_ep_num], existing.next_ep_num),
            next_ep_at: choose([rec.next_ep_at], existing.next_ep_at),
            anilist_id: choose([rec.anilist_id], existing.anilist_id),
            genres: choose([rec.genres], existing.genres),
            related: choose([], existing.related)
          };
          repository.upsertAnime(merged);
          inserted++;
        }
      });
      console.log(`[Done] ${season} ${year}: upserted ${inserted}, preservedFields ~${preserved}, shiki complete=${shiki.complete} errors=${shiki.errors.length}`);
    } catch (e) {
      console.error(`[Failed] ${season} ${year}:`, e.message);
    }
  }

  // summary
  const bySeason = repository.db.prepare('SELECT season, COUNT(*) as c FROM anime GROUP BY season ORDER BY season').all();
  console.log('\n=== DB summary ===');
  console.log(JSON.stringify(bySeason, null, 2));
  repository.close();
}

main().catch(e => { console.error(e); process.exit(1); });
