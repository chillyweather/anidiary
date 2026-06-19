const { createRateLimiter } = require('./rateLimiter');
const { isValidSeason, seasonKey } = require('../domain/seasons');

const BASE_URL = 'https://api.jikan.moe/v4';
const rateLimitedFetch = createRateLimiter(350);

async function fetchSeason(year, season) {
  return fetchSeasonWith(rateLimitedFetch, year, season);
}

async function fetchSeasonWith(fetchImpl, year, season) {
  const normalizedSeason = String(season || '').toLowerCase();
  if (!isValidSeason(normalizedSeason)) {
    throw new Error(`Invalid season: ${season}`);
  }

  const animeList = [];
  const errors = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    const url = `${BASE_URL}/seasons/${year}/${normalizedSeason}?page=${page}&sfw=true`;
    console.log(`[Jikan] Fetching ${url}`);
    
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`Jikan API error: ${res.status}`);
      }
      const data = await res.json();
      
      if (!Array.isArray(data.data) || typeof data.pagination?.has_next_page !== 'boolean') {
        throw new Error('Jikan response is malformed');
      }
      const items = data.data;
      for (const item of items) {
        animeList.push({
          mal_id: item.mal_id,
          title_en: item.title_english || item.title,
          title_jp: item.title_japanese,
          synopsis_en: item.synopsis,
          poster_url: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url,
          score_mal: item.score,
          episodes_total: item.episodes,
          season: seasonKey(year, normalizedSeason),
          airing_status: item.status,
          airing_day: item.broadcast?.day?.toLowerCase() || null,
          genres: JSON.stringify(item.genres?.map(g => g.name) || []),
          related: null
        });
      }
      
      hasNextPage = data.pagination?.has_next_page || false;
      page++;
    } catch (err) {
      console.error(`[Jikan] Error fetching page ${page}:`, err.message);
      errors.push({ page, message: err.message });
      break;
    }
  }

  console.log(`[Jikan] Fetched ${animeList.length} anime for ${season} ${year}`);
  return { records: animeList, complete: errors.length === 0, errors };
}

async function fetchAnimeDetail(malId) {
  const url = `${BASE_URL}/anime/${malId}/full`;
  console.log(`[Jikan] Fetching detail for ${malId}`);
  
  const res = await rateLimitedFetch(url);
  if (!res.ok) {
    throw new Error(`Jikan API error: ${res.status}`);
  }
  const data = await res.json();
  
  const relations = data.data?.relations || [];
  const related = relations.map(r => ({
    relation: r.relation,
    entries: r.entry.map(e => ({
      mal_id: e.mal_id,
      type: e.type,
      title: e.name
    }))
  }));

  return { related: JSON.stringify(related) };
}

module.exports = { fetchSeason, fetchSeasonWith, fetchAnimeDetail };
