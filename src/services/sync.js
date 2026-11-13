const jikan = require('./jikan');
const anilist = require('./anilist');
const shikimori = require('./shikimori');
const { getCurrentSeason, seasonKey } = require('../domain/seasons');

const COUNTDOWN_JOB = 'countdowns';
// Countdown refresh covers titles whose next episode is due within this window.
const COUNTDOWN_HORIZON_SECONDS = 24 * 60 * 60;

// Columns the database keeps when a merged value is null (see db.upsertAnime).
const PRESERVABLE_FIELDS = [
  'title_en', 'title_jp', 'title_ru', 'synopsis_en', 'synopsis_ru', 'poster_url',
  'score_mal', 'score_anilist', 'score_shiki', 'episodes_total', 'airing_status',
  'airing_day', 'anilist_id', 'genres', 'related', 'format', 'popularity'
];

function pick(...values) {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined ? null : value;
}

const MAX_QUEUED_SEASONS = 3;

function createSyncService({
  repository, providers = {}, logger = console, now = () => Date.now(), maxQueuedSeasons = MAX_QUEUED_SEASONS
}) {
  const jikanClient = providers.jikan || jikan;
  const anilistClient = providers.anilist || anilist;
  const shikimoriClient = providers.shikimori || shikimori;
  const nowSeconds = () => Math.floor(now() / 1000);

  async function providerResult(name, call, emptyRecords) {
    try {
      const result = await call();
      if (!result || !('records' in result) || typeof result.complete !== 'boolean') {
        throw new Error(`${name} returned a malformed result`);
      }
      return result;
    } catch (error) {
      return { records: emptyRecords, complete: false, errors: [{ message: error.message }] };
    }
  }

  function recordResult(job, at, status, error = null) {
    try {
      repository.recordSyncResult(job, { at, status, error });
    } catch (recordError) {
      logger.error(`[Sync] Unable to record ${job} state: ${recordError.message}`);
    }
  }

  // Season syncs run one at a time, whoever asks (scheduler, page views, CLI):
  // pendingSeasons holds the running season and those waiting behind it.
  const pendingSeasons = new Set();
  let seasonChain = Promise.resolve();

  function isSyncing(year, season) {
    return pendingSeasons.has(`${year}:${String(season).toLowerCase()}`);
  }

  function syncSeason(year, season) {
    const key = `${year}:${String(season).toLowerCase()}`;
    if (pendingSeasons.has(key)) {
      const overlap = { year, season: String(season).toLowerCase(), skipped: true, reason: 'overlap', transaction: 'not_started' };
      logger.log(`[Sync] ${JSON.stringify(overlap)}`);
      return Promise.resolve(overlap);
    }
    pendingSeasons.add(key);
    const run = seasonChain.then(() => synchronizeSeason(year, season));
    seasonChain = run.catch(() => {});
    return run.finally(() => pendingSeasons.delete(key));
  }

  // Background sync for a page view. Never waits; refuses when the queue is full.
  // Returns 'queued', 'pending' (already queued or running) or 'busy'.
  function requestSeasonSync(year, season) {
    if (isSyncing(year, season)) return 'pending';
    if (pendingSeasons.size >= maxQueuedSeasons) return 'busy';
    syncSeason(year, season).catch((error) => {
      logger.error(`[Sync] background ${season} ${year} failed: ${error.message}`);
    });
    return 'queued';
  }

  async function synchronizeSeason(year, season) {
    const startedAt = now();
    const attemptedAt = nowSeconds();
    const normalizedSeason = String(season || '').toLowerCase();
    const key = seasonKey(year, normalizedSeason);
    const [jikanResult, anilistResult] = await Promise.all([
      providerResult('jikan', () => jikanClient.fetchSeason(year, normalizedSeason), []),
      providerResult('anilist', () => anilistClient.fetchSeason(normalizedSeason, year), new Map())
    ]);
    const anilistRecords = anilistResult.records instanceof Map ? anilistResult.records : new Map();
    const jikanRecords = new Map();
    for (const anime of Array.isArray(jikanResult.records) ? jikanResult.records : []) {
      if (Number.isInteger(anime?.mal_id) && anime.mal_id > 0) jikanRecords.set(anime.mal_id, anime);
    }

    // AniList is the catalogue. When it fails or is cut short, Jikan supplies the
    // titles it missed so the season is still listed.
    const malIds = [...anilistRecords.keys()].filter((id) => Number.isInteger(id) && id > 0);
    let jikanOnly = 0;
    if (!anilistResult.complete) {
      for (const malId of jikanRecords.keys()) {
        if (anilistRecords.has(malId)) continue;
        malIds.push(malId);
        jikanOnly++;
      }
    }

    const shikimoriResult = await providerResult(
      'shikimori', () => shikimoriClient.fetchBatch(malIds), new Map()
    );
    const shikimoriRecords = shikimoriResult.records instanceof Map ? shikimoriResult.records : new Map();

    let missingFields = 0;
    const mergedRecords = malIds.map((malId) => {
      const al = anilistRecords.get(malId);
      const a = al || {};
      const jk = jikanRecords.get(malId) || {};
      const sh = shikimoriRecords.get(malId) || {};
      const merged = {
        mal_id: malId,
        title_en: pick(a.title_en, jk.title_en),
        title_jp: pick(a.title_jp, jk.title_jp),
        title_ru: pick(sh.title_ru),
        synopsis_en: pick(a.synopsis_en, jk.synopsis_en),
        synopsis_ru: pick(sh.synopsis_ru),
        poster_url: pick(a.poster_url, jk.poster_url),
        score_mal: pick(jk.score_mal),
        score_anilist: pick(a.score_anilist),
        score_shiki: pick(sh.score_shiki),
        episodes_total: pick(a.episodes_total, jk.episodes_total),
        season: key,
        // A title only Jikan listed keeps the season it already has.
        season_authoritative: Boolean(al),
        airing_status: pick(a.airing_status, jk.airing_status),
        airing_day: pick(jk.airing_day),
        // AniList answered for this title: "no next episode" is a fact, not a gap.
        next_ep_num: al ? a.next_ep_num ?? null : null,
        next_ep_at: al ? a.next_ep_at ?? null : null,
        next_ep_authoritative: Boolean(al),
        anilist_id: pick(a.anilist_id),
        genres: pick(Array.isArray(a.genres) && a.genres.length ? JSON.stringify(a.genres) : null, jk.genres),
        related: Array.isArray(a.related) ? JSON.stringify(a.related) : null,
        format: pick(a.format, jk.format),
        popularity: pick(a.popularity)
      };
      for (const field of PRESERVABLE_FIELDS) if (merged[field] === null) missingFields++;
      return merged;
    });

    const providerSummary = {
      jikan: summarizeProvider(jikanResult),
      anilist: summarizeProvider(anilistResult),
      shikimori: summarizeProvider(shikimoriResult)
    };
    const complete = Object.values(providerSummary).every((provider) => provider.complete);
    const summary = {
      season: normalizedSeason,
      year,
      providers: providerSummary,
      records: mergedRecords.length,
      jikanOnly,
      writes: 0,
      writeErrors: 0,
      missingFields,
      durationMs: 0,
      complete: false,
      status: 'failed',
      transaction: 'not_started'
    };

    try {
      repository.transaction(() => {
        for (const merged of mergedRecords) repository.upsertAnime(merged);
      });
    } catch (error) {
      summary.writeErrors = 1;
      summary.transaction = 'rolled_back';
      summary.error = error.message;
      summary.durationMs = now() - startedAt;
      recordResult(key, attemptedAt, 'failed', error.message);
      logger.error(`[Sync] ${JSON.stringify(summary)}`);
      throw error;
    }

    summary.writes = mergedRecords.length;
    summary.transaction = 'committed';
    summary.complete = complete;
    summary.status = complete ? 'complete' : (mergedRecords.length ? 'partial' : 'failed');
    summary.durationMs = now() - startedAt;
    recordResult(key, attemptedAt, summary.status, complete ? null : firstError(providerSummary));
    logger.log(`[Sync] ${JSON.stringify(summary)}`);
    return { inserted: summary.writes, errors: summary.writeErrors, ...summary };
  }

  // Refreshes countdown fields for the given titles (default: every airing title,
  // not-yet-aired titles due within a day, and everything a user follows or
  // watches that has not finished), regardless of season.
  async function refreshCountdowns(malIds) {
    const attemptedAt = nowSeconds();
    const ids = malIds || repository.getCountdownRefreshIds(attemptedAt + COUNTDOWN_HORIZON_SECONDS);
    if (!malIds) logger.log(`[Sync] Countdown refresh covers ${ids.length} titles`);
    const result = ids.length
      ? await providerResult('anilist', () => anilistClient.fetchByMalIds(ids), new Map())
      : { records: new Map(), complete: true, errors: [] };
    const records = result.records instanceof Map ? result.records : new Map();
    let updated = 0;
    repository.transaction(() => {
      for (const [malId, data] of records) {
        if (data?.next_ep_num === undefined) continue;
        repository.updateCountdown(malId, data);
        updated++;
      }
    });
    const status = result.complete ? 'complete' : (records.size ? 'partial' : 'failed');
    recordResult(COUNTDOWN_JOB, attemptedAt, status, result.complete ? null : result.errors?.[0]?.message || null);
    logger.log(`[Sync] ${JSON.stringify({
      operation: 'countdowns', requested: ids.length, updated, status, provider: summarizeProvider(result)
    })}`);
    return updated;
  }

  return { syncSeason, requestSeasonSync, refreshCountdowns, isSyncing };
}

function firstError(providerSummary) {
  for (const [name, provider] of Object.entries(providerSummary)) {
    if (provider.errors.length) return `${name}: ${provider.errors[0].message}`;
    if (!provider.complete) return `${name}: incomplete`;
  }
  return null;
}

function summarizeProvider(result) {
  return {
    complete: result.complete,
    records: result.records instanceof Map ? result.records.size : (result.records?.length ?? 0),
    errors: (result.errors || []).map((error) => ({
      page: error.page, batch: error.batch, id: error.id, message: error.message
    }))
  };
}

module.exports = {
  createSyncService, getCurrentSeason, summarizeProvider, COUNTDOWN_JOB, COUNTDOWN_HORIZON_SECONDS
};
