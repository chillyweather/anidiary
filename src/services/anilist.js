const he = require('he');
const { toAniListSeason } = require('../domain/seasons');
const { normalizeFormat } = require('../domain/formats');
const { withTimeout } = require('./rateLimiter');

const ANILIST_URL = 'https://graphql.anilist.co';
const REQUEST_TIMEOUT_MS = 15000;
// AniList currently allows 30 requests/minute; one request every ~2s stays under it.
const MIN_REQUEST_INTERVAL_MS = 2100;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 60000;
const MAX_RETRY_AFTER_MS = 65000;
const PAGE_SIZE = 50;

const SEASON_QUERY = `
  query ($season: MediaSeason, $year: Int, $page: Int) {
    Page(page: $page, perPage: ${PAGE_SIZE}) {
      pageInfo { hasNextPage currentPage }
      media(season: $season, seasonYear: $year, type: ANIME, isAdult: false, sort: POPULARITY_DESC) {
        id
        idMal
        title { romaji english native }
        description(asHtml: false)
        nextAiringEpisode { airingAt episode }
        episodes
        averageScore
        coverImage { large }
        genres
        status
        format
        popularity
        relations { edges { relationType node { id idMal type title { romaji english native } } } }
      }
    }
  }
`;

const COUNTDOWN_QUERY = `
  query ($ids: [Int]) {
    Page(page: 1, perPage: ${PAGE_SIZE}) {
      media(idMal_in: $ids, type: ANIME) {
        idMal
        status
        episodes
        nextAiringEpisode { airingAt episode }
      }
    }
  }
`;

const STATUS_MAP = Object.freeze({
  FINISHED: 'Finished Airing',
  RELEASING: 'Currently Airing',
  NOT_YET_RELEASED: 'Not yet aired',
  CANCELLED: 'Cancelled',
  HIATUS: 'On Hiatus'
});

// AniList relation types mapped onto the relation names the locale catalogs
// translate (and that series navigation looks up as Prequel/Sequel).
const RELATION_MAP = Object.freeze({
  ADAPTATION: 'Adaptation',
  SOURCE: 'Adaptation',
  PREQUEL: 'Prequel',
  SEQUEL: 'Sequel',
  PARENT: 'Parent story',
  SIDE_STORY: 'Side story',
  CHARACTER: 'Character',
  SUMMARY: 'Summary',
  COMPILATION: 'Summary',
  CONTAINS: 'Full story',
  ALTERNATIVE: 'Alternative version',
  SPIN_OFF: 'Spin-off',
  OTHER: 'Other'
});

// AniList descriptions carry inline markup (<br>, <i>) and HTML entities.
function cleanDescription(description) {
  if (!description) return null;
  const text = he.decode(String(description).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

// Returns null when AniList sent no edge list, so stored relations are kept;
// an explicit (even empty) edge list is authoritative.
function mapRelations(relations) {
  if (!Array.isArray(relations?.edges)) return null;
  const groups = new Map();
  for (const edge of relations.edges) {
    const node = edge?.node;
    if (!node || !Number.isInteger(node.idMal) || node.idMal <= 0) continue;
    const relation = RELATION_MAP[edge.relationType] || 'Other';
    if (!groups.has(relation)) groups.set(relation, []);
    groups.get(relation).push({
      mal_id: node.idMal,
      type: String(node.type || 'anime').toLowerCase(),
      title: node.title?.english || node.title?.romaji || node.title?.native || null
    });
  }
  return [...groups].map(([relation, entries]) => ({ relation, entries }));
}

function mapMedia(media) {
  return {
    score_anilist: media.averageScore ?? null,
    next_ep_num: media.nextAiringEpisode?.episode ?? null,
    next_ep_at: media.nextAiringEpisode?.airingAt ?? null,
    title_en: media.title?.english || media.title?.romaji || null,
    title_jp: media.title?.native || null,
    synopsis_en: cleanDescription(media.description),
    poster_url: media.coverImage?.large || null,
    anilist_id: media.id,
    genres: media.genres || [],
    airing_status: STATUS_MAP[media.status] || null,
    episodes_total: media.episodes ?? null,
    format: normalizeFormat(media.format),
    popularity: Number.isInteger(media.popularity) ? media.popularity : null,
    related: mapRelations(media.relations)
  };
}

function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === '') return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - nowMs);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createAniListClient({
  fetchImpl = (...args) => fetch(...args),
  sleep = defaultSleep,
  now = Date.now,
  logger = console,
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  maxRetries = MAX_RETRIES,
  maxRetryAfterMs = MAX_RETRY_AFTER_MS,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  let lastRequestAt = 0;
  let tail = Promise.resolve();

  async function send(body) {
    for (let attempt = 0; ; attempt++) {
      const wait = minIntervalMs - (now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();

      // The deadline covers the response body as well as the headers.
      const outcome = await withTimeout(timeoutMs, async (signal) => {
        const res = await fetchImpl(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          signal,
          body: JSON.stringify(body)
        });
        if (res.status === 429) return { rateLimited: true, retryAfter: res.headers?.get?.('retry-after') };
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.errors?.[0]?.message || `AniList error: ${res.status}`);
        }
        return { result: await res.json() };
      });

      if (outcome.rateLimited) {
        if (attempt >= maxRetries) throw new Error('AniList rate limit exceeded (429)');
        const delay = Math.min(parseRetryAfter(outcome.retryAfter, now()), maxRetryAfterMs);
        logger.log(`[AniList] Rate limited; retrying in ${Math.ceil(delay / 1000)}s`);
        await sleep(delay);
        continue;
      }

      const { result } = outcome;
      if (result.errors?.length) throw new Error(result.errors[0].message || 'AniList GraphQL error');
      if (!result.data?.Page) throw new Error('AniList response is missing Page data');
      return result.data.Page;
    }
  }

  // Requests are serialized so spacing and Retry-After apply across callers.
  function request(body) {
    const run = tail.then(() => send(body));
    tail = run.catch(() => {});
    return run;
  }

  async function fetchSeason(season, year) {
    const records = new Map();
    const errors = [];
    const anilistSeason = toAniListSeason(season);
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      logger.log(`[AniList] Fetching ${anilistSeason} ${year}, page ${page}`);
      try {
        const pageData = await request({ query: SEASON_QUERY, variables: { season: anilistSeason, year, page } });
        if (!Array.isArray(pageData.media) || typeof pageData.pageInfo?.hasNextPage !== 'boolean') {
          throw new Error('AniList Page data is malformed');
        }
        for (const media of pageData.media) {
          if (media.idMal) records.set(media.idMal, mapMedia(media));
        }
        hasNextPage = pageData.pageInfo.hasNextPage;
        page++;
      } catch (err) {
        logger.error(`[AniList] Error: ${err.message}`);
        errors.push({ page, message: err.message });
        break;
      }
    }

    logger.log(`[AniList] Fetched ${records.size} anime entries`);
    return { records, complete: errors.length === 0, errors };
  }

  // Countdown fields for arbitrary titles, regardless of season.
  async function fetchByMalIds(malIds) {
    const records = new Map();
    const errors = [];
    const ids = [...new Set(malIds)].filter((id) => Number.isInteger(id) && id > 0);

    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      const chunk = ids.slice(i, i + PAGE_SIZE);
      try {
        const pageData = await request({ query: COUNTDOWN_QUERY, variables: { ids: chunk } });
        if (!Array.isArray(pageData.media)) throw new Error('AniList Page data is malformed');
        for (const media of pageData.media) {
          if (!media.idMal) continue;
          records.set(media.idMal, {
            next_ep_num: media.nextAiringEpisode?.episode ?? null,
            next_ep_at: media.nextAiringEpisode?.airingAt ?? null,
            airing_status: STATUS_MAP[media.status] || null,
            episodes_total: media.episodes ?? null
          });
        }
      } catch (err) {
        logger.error(`[AniList] Error fetching ids ${chunk[0]}…${chunk.at(-1)}: ${err.message}`);
        errors.push({ batch: i / PAGE_SIZE + 1, message: err.message });
      }
    }

    return { records, complete: errors.length === 0, errors };
  }

  return { fetchSeason, fetchByMalIds };
}

const defaultClient = createAniListClient();

module.exports = {
  createAniListClient,
  fetchSeason: defaultClient.fetchSeason,
  fetchByMalIds: defaultClient.fetchByMalIds,
  cleanDescription,
  mapRelations,
  parseRetryAfter
};
