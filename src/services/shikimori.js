const { createRateLimiter } = require('./rateLimiter');
const he = require('he');

const BASE_URL = 'https://shikimori.one/api';
const CONCURRENCY = 1;

// Shikimori effectively enforces 90 requests/minute.
// 700ms keeps us under that threshold with headroom.
const fetch = createRateLimiter(700);

function stripHtml(str) {
  if (!str) return null;
  return str.replace(/<[^>]+>/g, '').trim();
}

function repairMojibake(str) {
  if (!str) return str;

  // Common UTF-8 -> Latin-1 mojibake markers for Cyrillic/Japanese text.
  if (!/[ÐÑã]/.test(str)) {
    return str;
  }

  try {
    const repaired = Buffer.from(str, 'latin1').toString('utf8');
    return /[\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(repaired) ? repaired : str;
  } catch {
    return str;
  }
}

async function fetchAnime(malId) {
  const url = `${BASE_URL}/animes/${malId}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Anidiary',
        'Accept-Charset': 'utf-8'
      }
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new Error(`Shikimori error: ${res.status}`);
    }

    const data = await res.json();

    let synopsisRu = null;
    if (data.description) {
      const stripped = stripHtml(data.description);
      synopsisRu = stripped ? repairMojibake(he.decode(stripped)) : null;
    }

    let titleRu = null;
    if (data.russian) {
      titleRu = repairMojibake(he.decode(data.russian));
    }

    return {
      mal_id: malId,
      title_ru: titleRu,
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

  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + CONCURRENCY);
    console.log(`[Shikimori] Fetching batch ${i + 1}–${i + batch.length} of ${uniqueIds.length}`);
    const results = await Promise.all(batch.map(id => fetchAnime(id)));
    for (const data of results) {
      if (data) {
        dataMap.set(data.mal_id, data);
        delete data.mal_id;
      }
    }
  }

  console.log(`[Shikimori] Fetched ${dataMap.size} of ${uniqueIds.length} entries`);
  return dataMap;
}

module.exports = { fetchAnime, fetchBatch };
