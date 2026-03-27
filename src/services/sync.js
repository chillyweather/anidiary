const jikan = require('./jikan');
const anilist = require('./anilist');
const shikimori = require('./shikimori');
const { upsertAnime, getAnimeByMalId } = require('../db/db');

function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  let season;
  if (month >= 1 && month <= 3) season = 'winter';
  else if (month >= 4 && month <= 6) season = 'spring';
  else if (month >= 7 && month <= 9) season = 'summer';
  else season = 'fall';
  return { year, season };
}

async function syncSeason(year, season) {
  const normalizedSeason = String(season || '').toLowerCase();
  console.log(`[Sync] Starting sync for ${normalizedSeason} ${year}`);
  
  const jikanAnime = await jikan.fetchSeason(year, normalizedSeason);
  if (!Array.isArray(jikanAnime) || jikanAnime.length === 0) {
    throw new Error(`No anime returned for ${normalizedSeason} ${year}`);
  }

  const anilistMap = await anilist.fetchSeason(normalizedSeason, year);
  const malIds = [...new Set(jikanAnime.map(a => a.mal_id))];
  const shikiMap = await shikimori.fetchBatch(malIds);
  
  let inserted = 0;
  let errors = 0;
  
  for (const anime of jikanAnime) {
    const alData = anilistMap.get(anime.mal_id) || {};
    const shData = shikiMap.get(anime.mal_id) || {};
    const existing = getAnimeByMalId(anime.mal_id) || {};
    
    const merged = {
      mal_id: anime.mal_id,
      title_en: anime.title_en || alData.title_en || null,
      title_jp: alData.title_jp || anime.title_jp || null,
      title_ru: shData.title_ru ?? existing.title_ru ?? null,
      synopsis_en: anime.synopsis_en || null,
      synopsis_ru: shData.synopsis_ru ?? existing.synopsis_ru ?? null,
      poster_url: anime.poster_url || alData.poster_url || null,
      score_mal: anime.score_mal || null,
      score_anilist: alData.score_anilist || null,
      score_shiki: shData.score_shiki ?? existing.score_shiki ?? null,
      episodes_total: anime.episodes_total || alData.episodes_total || null,
      season: anime.season,
      airing_status: alData.airing_status || anime.airing_status || null,
      airing_day: anime.airing_day || null,
      next_ep_num: alData.next_ep_num || null,
      next_ep_at: alData.next_ep_at || null,
      anilist_id: alData.anilist_id || null,
      genres: anime.genres || JSON.stringify(alData.genres || []),
      related: anime.related || null
    };
    
    try {
      upsertAnime(merged);
      inserted++;
    } catch (err) {
      console.error(`[Sync] Error upserting ${anime.mal_id}:`, err.message);
      errors++;
    }
  }
  
  console.log(`[Sync] Complete: ${inserted} inserted, ${errors} errors`);
  return { inserted, errors };
}

async function refreshCountdowns(year, season) {
  const normalizedSeason = String(season || '').toLowerCase();
  console.log(`[Sync] Refreshing countdowns for ${normalizedSeason} ${year}`);
  
  const anilistMap = await anilist.fetchSeason(normalizedSeason, year);
  const { db } = require('../db/db');
  
  const updateStmt = db.prepare(`
    UPDATE anime SET next_ep_num = ?, next_ep_at = ?, updated_at = unixepoch()
    WHERE mal_id = ?
  `);
  
  let updated = 0;
  for (const [malId, data] of anilistMap) {
    if (data.next_ep_num !== undefined) {
      updateStmt.run(data.next_ep_num, data.next_ep_at, malId);
      updated++;
    }
  }
  
  console.log(`[Sync] Updated ${updated} countdown entries`);
  return updated;
}

module.exports = { syncSeason, refreshCountdowns, getCurrentSeason };
