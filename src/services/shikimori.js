const { createRateLimiter } = require('./rateLimiter');
const he = require('he');

const GRAPHQL_URL = 'https://shikimori.io/api/graphql';
const BATCH_SIZE = 50;

// Shikimori effectively enforces 90 requests/minute.
// 700ms keeps us under that threshold with headroom.
const rateLimitedFetch = createRateLimiter(700);

const BATCH_QUERY = `
  query ($ids: String) {
    animes(ids: $ids, limit: ${BATCH_SIZE}) { id malId russian score descriptionHtml description }
  }
`;

// Shikimori's own markup ([character=1]Name[/character], [i], [spoiler=…]) keeps
// the inner text and drops the tags.
function stripBbCode(str) {
  return str.replace(/\[\/?[a-z_]+(?:=[^\]]*)?\]/gi, '');
}

function stripHtml(str) {
  if (!str) return null;
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function repairMojibake(str) {
  if (!str) return str;

  // Common UTF-8 -> Latin-1 mojibake markers for Cyrillic/Japanese text.
  if (!/[ÐÑã]/.test(str)) {
    return str;
  }

  try {
    const repaired = Buffer.from(str, 'latin1').toString('utf8');
    return /[Ѐ-ӿ぀-ヿ一-鿿]/.test(repaired) ? repaired : str;
  } catch {
    return str;
  }
}

// Entities are decoded first so encoded tags (&lt;b&gt;) are stripped too; the
// same cleanup applies whichever field supplied the text.
function cleanSynopsis(html, raw) {
  const source = html || raw;
  if (!source) return null;
  const text = stripBbCode(stripHtml(repairMojibake(he.decode(String(source)))) || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

function mapAnime(item) {
  const score = item.score === null || item.score === undefined ? null : parseFloat(item.score);
  return {
    title_ru: item.russian ? repairMojibake(he.decode(item.russian)) : null,
    synopsis_ru: cleanSynopsis(item.descriptionHtml, item.description),
    score_shiki: score ? score : null
  };
}

function createShikimoriClient({ fetchImpl = rateLimitedFetch, logger = console, batchSize = BATCH_SIZE } = {}) {
  async function fetchChunk(ids) {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'Anidiary',
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query: BATCH_QUERY, variables: { ids: ids.join(',') } })
    });
    if (!res.ok) throw new Error(`Shikimori error: ${res.status}`);
    const result = await res.json();
    if (result.errors?.length) throw new Error(result.errors[0].message || 'Shikimori GraphQL error');
    if (!Array.isArray(result.data?.animes)) throw new Error('Shikimori response is malformed');
    return result.data.animes;
  }

  async function fetchBatch(malIds) {
    const records = new Map();
    const errors = [];
    const uniqueIds = [...new Set(malIds)].filter((id) => Number.isInteger(id) && id > 0);

    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const chunk = uniqueIds.slice(i, i + batchSize);
      const batch = i / batchSize + 1;
      logger.log(`[Shikimori] Fetching ${i + 1}–${i + chunk.length} of ${uniqueIds.length}`);
      try {
        const requested = new Set(chunk);
        // The ids filter matches Shikimori's own ids, which can differ from MAL
        // ids: only rows whose malId is one we asked for are kept.
        for (const item of await fetchChunk(chunk)) {
          const malId = Number(item.malId);
          if (item.malId !== null && Number.isInteger(malId) && requested.has(malId)) {
            records.set(malId, mapAnime(item));
          }
        }
      } catch (err) {
        logger.error(`[Shikimori] Batch ${batch} failed: ${err.message}`);
        errors.push({ batch, message: err.message });
      }
    }

    logger.log(`[Shikimori] Fetched ${records.size} of ${uniqueIds.length} entries`);
    return { records, complete: errors.length === 0, errors };
  }

  return { fetchBatch };
}

const defaultClient = createShikimoriClient();

module.exports = {
  createShikimoriClient,
  fetchBatch: defaultClient.fetchBatch,
  cleanSynopsis,
  repairMojibake
};
