const jikan = require('./jikan');
const anilist = require('./anilist');
const shikimori = require('./shikimori');
const { getCurrentSeason } = require('../domain/seasons');

function createSyncService({ repository, providers = {}, logger = console }) {
  const jikanClient = providers.jikan || jikan;
  const anilistClient = providers.anilist || anilist;
  const shikimoriClient = providers.shikimori || shikimori;
  const { upsertAnime, getAnimeByMalId, db } = repository;
  const activeSeasons = new Set();

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

  async function syncSeason(year, season) {
    const key = `${year}:${String(season).toLowerCase()}`;
    if (activeSeasons.has(key)) {
      const overlap = { year, season: String(season).toLowerCase(), skipped: true, reason: 'overlap', transaction: 'not_started' };
      logger.log(`[Sync] ${JSON.stringify(overlap)}`);
      return overlap;
    }
    activeSeasons.add(key);
    try {
      return await synchronizeSeason(year, season);
    } finally {
      activeSeasons.delete(key);
    }
  }

  async function synchronizeSeason(year, season) {
    const startedAt = Date.now();
    const normalizedSeason = String(season || '').toLowerCase();
    const [jikanResult, anilistResult] = await Promise.all([
      providerResult('jikan', () => jikanClient.fetchSeason(year, normalizedSeason), []),
      providerResult('anilist', () => anilistClient.fetchSeason(normalizedSeason, year), new Map())
    ]);
    const records = Array.isArray(jikanResult.records) ? jikanResult.records : [];
    const malIds = [...new Set(records.map((anime) => anime.mal_id))];
    const shikimoriResult = await providerResult(
      'shikimori', () => shikimoriClient.fetchBatch(malIds), new Map()
    );
    const anilistRecords = anilistResult.records instanceof Map ? anilistResult.records : new Map();
    const shikimoriRecords = shikimoriResult.records instanceof Map ? shikimoriResult.records : new Map();

    let preservedFields = 0;

    function valueOrExisting(values, existingValue) {
      const value = values.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
      if (value !== undefined) return value;
      if (existingValue !== undefined && existingValue !== null) preservedFields++;
      return existingValue ?? null;
    }

    const mergedRecords = [];
    for (const anime of records) {
      if (!Number.isInteger(anime.mal_id) || anime.mal_id <= 0) continue;
      const alData = anilistRecords.get(anime.mal_id) || {};
      const shData = shikimoriRecords.get(anime.mal_id) || {};
      const existing = getAnimeByMalId(anime.mal_id) || {};
      const merged = {
        mal_id: anime.mal_id,
        title_en: valueOrExisting([anime.title_en, alData.title_en], existing.title_en),
        title_jp: valueOrExisting([alData.title_jp, anime.title_jp], existing.title_jp),
        title_ru: valueOrExisting([shData.title_ru], existing.title_ru),
        synopsis_en: valueOrExisting([anime.synopsis_en], existing.synopsis_en),
        synopsis_ru: valueOrExisting([shData.synopsis_ru], existing.synopsis_ru),
        poster_url: valueOrExisting([anime.poster_url, alData.poster_url], existing.poster_url),
        score_mal: valueOrExisting([anime.score_mal], existing.score_mal),
        score_anilist: valueOrExisting([alData.score_anilist], existing.score_anilist),
        score_shiki: valueOrExisting([shData.score_shiki], existing.score_shiki),
        episodes_total: valueOrExisting([anime.episodes_total, alData.episodes_total], existing.episodes_total),
        season: valueOrExisting([anime.season], existing.season),
        airing_status: valueOrExisting([alData.airing_status, anime.airing_status], existing.airing_status),
        airing_day: valueOrExisting([anime.airing_day], existing.airing_day),
        next_ep_num: valueOrExisting([alData.next_ep_num], existing.next_ep_num),
        next_ep_at: valueOrExisting([alData.next_ep_at], existing.next_ep_at),
        anilist_id: valueOrExisting([alData.anilist_id], existing.anilist_id),
        genres: valueOrExisting([anime.genres, alData.genres && JSON.stringify(alData.genres)], existing.genres),
        related: valueOrExisting([], existing.related)
      };

      mergedRecords.push(merged);
    }

    const providerSummary = {
      jikan: summarizeProvider(jikanResult),
      anilist: summarizeProvider(anilistResult),
      shikimori: summarizeProvider(shikimoriResult)
    };
    const summary = {
      season: normalizedSeason,
      year,
      providers: providerSummary,
      records: records.length,
      writes: 0,
      writeErrors: 0,
      preservedFields,
      durationMs: 0,
      complete: false,
      transaction: 'not_started'
    };

    try {
      repository.transaction(() => {
        for (const merged of mergedRecords) upsertAnime(merged);
      });
      summary.writes = mergedRecords.length;
      summary.transaction = 'committed';
      summary.complete = Object.values(providerSummary).every((provider) => provider.complete);
    } catch (error) {
      summary.writeErrors = 1;
      summary.transaction = 'rolled_back';
      summary.error = error.message;
      summary.durationMs = Date.now() - startedAt;
      logger.error(`[Sync] ${JSON.stringify(summary)}`);
      throw error;
    }

    summary.durationMs = Date.now() - startedAt;
    logger.log(`[Sync] ${JSON.stringify(summary)}`);
    return { inserted: summary.writes, errors: summary.writeErrors, ...summary };
  }

  async function refreshCountdowns(year, season) {
    const result = await providerResult(
      'anilist', () => anilistClient.fetchSeason(String(season).toLowerCase(), year), new Map()
    );
    const update = db.prepare(`
      UPDATE anime SET next_ep_num = ?, next_ep_at = ?, updated_at = unixepoch() WHERE mal_id = ?
    `);
    let updated = 0;
    for (const [malId, data] of result.records instanceof Map ? result.records : []) {
      if (data.next_ep_num !== undefined) {
        update.run(data.next_ep_num, data.next_ep_at ?? null, malId);
        updated++;
      }
    }
    logger.log(`[Sync] ${JSON.stringify({ operation: 'countdowns', year, season, updated, provider: summarizeProvider(result) })}`);
    return updated;
  }

  return { syncSeason, refreshCountdowns };
}

function summarizeProvider(result) {
  return {
    complete: result.complete,
    records: result.records instanceof Map ? result.records.size : result.records.length,
    errors: (result.errors || []).map((error) => ({ page: error.page, id: error.id, message: error.message }))
  };
}

module.exports = { createSyncService, getCurrentSeason, summarizeProvider };
