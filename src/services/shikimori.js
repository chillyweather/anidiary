const { createRateLimiter } = require('./rateLimiter');

const BASE_URL = 'https://shikimori.one/api';
const fetch = createRateLimiter(250);

async function fetchAnime(malId) {
  const url = `${BASE_URL}/animes/${malId}`;
  console.log(`[Shikimori] Fetching ${malId}`);
  
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Anidiary' }
    });
    
    if (res.status === 404) {
      return null;
    }
    
    if (!res.ok) {
      throw new Error(`Shikimori error: ${res.status}`);
    }
    
    const data = await res.json();
    const synopsisRu = data.description?.replace(/<[^>]+>/g, '') || null;
    
    return {
      title_ru: data.russian || null,
      synopsis_ru: synopsisRu,
      score_shiki: data.score ? parseFloat(data.score) : null
    };
  } catch (err) {
    console.error(`[Shikimori] Error fetching ${malId}:`, err.message);
    return null;
  }
}

async function fetchBatch(malIds) {
  const dataMap = new Map();
  const uniqueIds = [...new Set(malIds)].filter((id) => Number.isInteger(id) && id > 0);
  
  for (const malId of uniqueIds) {
    const data = await fetchAnime(malId);
    if (data) {
      dataMap.set(malId, data);
    }
  }
  
  console.log(`[Shikimori] Fetched ${dataMap.size} of ${uniqueIds.length} entries`);
  return dataMap;
}

module.exports = { fetchAnime, fetchBatch };
