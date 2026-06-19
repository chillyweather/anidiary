const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../src/db/db');
const { createSyncService } = require('../src/services/sync');
const { fetchSeasonWith } = require('../src/services/jikan');

function createRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-sync-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

function anime(overrides = {}) {
  return {
    mal_id: 1, title_en: 'Old title', title_jp: '古い', title_ru: 'Старое',
    synopsis_en: 'Old synopsis', synopsis_ru: 'Старое описание', poster_url: 'https://example.test/old.jpg',
    score_mal: 7, score_anilist: 70, score_shiki: 7.1, episodes_total: 12,
    season: 'spring_2026', airing_status: 'Currently Airing', airing_day: 'monday',
    next_ep_num: 4, next_ep_at: 1000, anilist_id: 10, genres: '["Drama"]',
    related: '[{"relation":"Sequel","entries":[]}]', ...overrides
  };
}

const completeMap = (records = new Map()) => ({ records, complete: true, errors: [] });

test('sync preserves stored fields and relationships across partial and failed providers', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const logs = [];
  const sync = createSyncService({
    repository,
    providers: {
      jikan: { fetchSeason: async () => ({
        records: [anime({ title_en: 'New title', synopsis_en: null, score_mal: null, related: null })],
        complete: false,
        errors: [{ page: 2, message: 'timeout' }]
      }) },
      anilist: { fetchSeason: async () => { throw new Error('provider timeout'); } },
      shikimori: { fetchBatch: async () => completeMap() }
    },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) }
  });

  const result = await sync.syncSeason(2026, 'spring');
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.title_en, 'New title');
  assert.equal(stored.synopsis_en, 'Old synopsis');
  assert.equal(stored.score_mal, 7);
  assert.equal(stored.score_anilist, 70);
  assert.equal(stored.title_ru, 'Старое');
  assert.equal(stored.related, '[{"relation":"Sequel","entries":[]}]');
  assert.equal(result.providers.jikan.complete, false);
  assert.equal(result.providers.jikan.errors[0].page, 2);
  assert.equal(result.providers.anilist.complete, false);
  assert.ok(result.preservedFields > 0);
  assert.match(logs.at(-1), /"preservedFields"/);
});

test('successful authoritative provider values update owned fields', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = createSyncService({
    repository,
    providers: {
      jikan: { fetchSeason: async () => ({ records: [anime({ score_mal: 9 })], complete: true, errors: [] }) },
      anilist: { fetchSeason: async () => completeMap(new Map([[1, { score_anilist: 91, next_ep_num: 5 }]])) },
      shikimori: { fetchBatch: async () => completeMap(new Map([[1, { title_ru: 'Новое' }]])) }
    },
    logger: { log() {}, error() {} }
  });

  const result = await sync.syncSeason(2026, 'spring');
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.score_mal, 9);
  assert.equal(stored.score_anilist, 91);
  assert.equal(stored.next_ep_num, 5);
  assert.equal(stored.title_ru, 'Новое');
  assert.equal(result.complete, true);
});

test('countdown refresh clears a stored countdown when AniList reports no next episode', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = createSyncService({
    repository,
    providers: {
      anilist: { fetchSeason: async () => completeMap(new Map([[
        1, { next_ep_num: null, next_ep_at: null }
      ]])) }
    },
    logger: { log() {}, error() {} }
  });

  assert.equal(await sync.refreshCountdowns(2026, 'spring'), 1);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, null);
  assert.equal(stored.next_ep_at, null);
});

test('countdown refresh stores the next episode reported by AniList', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = createSyncService({
    repository,
    providers: {
      anilist: { fetchSeason: async () => completeMap(new Map([[
        1, { next_ep_num: 5, next_ep_at: 2000 }
      ]])) }
    },
    logger: { log() {}, error() {} }
  });

  assert.equal(await sync.refreshCountdowns(2026, 'spring'), 1);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, 5);
  assert.equal(stored.next_ep_at, 2000);
});

test('countdown refresh preserves a stored countdown when AniList omits the field', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = createSyncService({
    repository,
    providers: {
      anilist: { fetchSeason: async () => completeMap(new Map([[1, {}]])) }
    },
    logger: { log() {}, error() {} }
  });

  assert.equal(await sync.refreshCountdowns(2026, 'spring'), 0);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, 4);
  assert.equal(stored.next_ep_at, 1000);
});

test('empty and malformed provider results are incomplete without damaging stored data', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = createSyncService({
    repository,
    providers: {
      jikan: { fetchSeason: async () => undefined },
      anilist: { fetchSeason: async () => ({ records: new Map(), complete: true, errors: [] }) },
      shikimori: { fetchBatch: async () => completeMap() }
    },
    logger: { log() {}, error() {} }
  });
  const result = await sync.syncSeason(2026, 'spring');
  assert.equal(result.writes, 0);
  assert.equal(result.providers.jikan.complete, false);
  assert.equal(repository.getAnimeByMalId(1).title_en, 'Old title');
});

test('Jikan reports first-page and later-page failures distinctly', async () => {
  const firstFailure = await fetchSeasonWith(async () => { throw new Error('offline'); }, 2026, 'spring');
  assert.equal(firstFailure.complete, false);
  assert.equal(firstFailure.errors[0].page, 1);
  assert.equal(firstFailure.records.length, 0);

  let call = 0;
  const laterFailure = await fetchSeasonWith(async () => {
    call++;
    if (call === 2) throw new Error('page timeout');
    return {
      ok: true,
      json: async () => ({
        data: [{ mal_id: 1, title: 'One', images: { jpg: {} }, genres: [] }],
        pagination: { has_next_page: true }
      })
    };
  }, 2026, 'spring');
  assert.equal(laterFailure.complete, false);
  assert.equal(laterFailure.errors[0].page, 2);
  assert.equal(laterFailure.records.length, 1);
});

test('a write failure rolls back every anime in the season and releases the lock', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime({ mal_id: 1, title_en: 'Old one' }));
  repository.upsertAnime(anime({ mal_id: 2, title_en: 'Old two' }));
  let providerCalls = 0;
  const failingRepository = {
    ...repository,
    upsertAnime(record) {
      if (record.mal_id === 2) throw new Error('injected write failure');
      return repository.upsertAnime(record);
    }
  };
  const logs = [];
  const sync = createSyncService({
    repository: failingRepository,
    providers: {
      jikan: { fetchSeason: async () => {
        providerCalls++;
        return {
          records: [
            anime({ mal_id: 1, title_en: 'New one' }),
            anime({ mal_id: 2, title_en: 'New two' })
          ],
          complete: true,
          errors: []
        };
      } },
      anilist: { fetchSeason: async () => completeMap() },
      shikimori: { fetchBatch: async () => completeMap() }
    },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) }
  });

  await assert.rejects(sync.syncSeason(2026, 'spring'), /injected write failure/);
  assert.equal(repository.getAnimeByMalId(1).title_en, 'Old one');
  assert.equal(repository.getAnimeByMalId(2).title_en, 'Old two');
  assert.match(logs.at(-1), /"transaction":"rolled_back"/);
  await assert.rejects(sync.syncSeason(2026, 'spring'), /injected write failure/);
  assert.equal(providerCalls, 2);
});

test('concurrent synchronization for one season is skipped and later runs can proceed', async (t) => {
  const repository = createRepository(t);
  let releaseFirst;
  let calls = 0;
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const sync = createSyncService({
    repository,
    providers: {
      jikan: { fetchSeason: async () => {
        calls++;
        if (calls === 1) return firstResult;
        return { records: [], complete: true, errors: [] };
      } },
      anilist: { fetchSeason: async () => completeMap() },
      shikimori: { fetchBatch: async () => completeMap() }
    },
    logger: { log() {}, error() {} }
  });

  const first = sync.syncSeason(2026, 'spring');
  const overlap = await sync.syncSeason(2026, 'spring');
  assert.deepEqual(overlap, {
    year: 2026, season: 'spring', skipped: true, reason: 'overlap', transaction: 'not_started'
  });
  assert.equal(calls, 1);
  releaseFirst({ records: [], complete: true, errors: [] });
  assert.equal((await first).transaction, 'committed');
  assert.equal((await sync.syncSeason(2026, 'spring')).skipped, undefined);
  assert.equal(calls, 2);
});
