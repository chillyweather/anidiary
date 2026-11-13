const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../src/db/db');
const { createSyncService } = require('../src/services/sync');
const { fetchSeasonWith } = require('../src/services/jikan');
const { cleanDescription, createAniListClient } = require('../src/services/anilist');

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
    related: '[{"relation":"Sequel","entries":[]}]', format: 'tv', popularity: 500, ...overrides
  };
}

const completeMap = (records = new Map()) => ({ records, complete: true, errors: [] });
const quiet = { log() {}, error() {} };
const NOW_MS = 1_800_000_000_000;

function syncWith(repository, providers, options = {}) {
  return createSyncService({ repository, providers, logger: quiet, now: () => NOW_MS, ...options });
}

test('sync preserves stored fields and relationships across partial and failed providers', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const logs = [];
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({
      records: [{ mal_id: 1, title_en: 'New title', synopsis_en: null, score_mal: null }],
      complete: false,
      errors: [{ page: 2, message: 'timeout' }]
    }) },
    anilist: { fetchSeason: async () => { throw new Error('provider timeout'); } },
    shikimori: { fetchBatch: async () => completeMap() }
  }, { logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) } });

  const result = await sync.syncSeason(2026, 'spring');
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.title_en, 'New title');
  assert.equal(stored.synopsis_en, 'Old synopsis');
  assert.equal(stored.score_mal, 7);
  assert.equal(stored.score_anilist, 70);
  assert.equal(stored.title_ru, 'Старое');
  assert.equal(stored.related, '[{"relation":"Sequel","entries":[]}]');
  assert.equal(stored.format, 'tv');
  assert.equal(stored.popularity, 500);
  // AniList did not answer, so the stored countdown is kept.
  assert.equal(stored.next_ep_num, 4);
  assert.equal(stored.next_ep_at, 1000);
  assert.equal(result.providers.jikan.complete, false);
  assert.equal(result.providers.jikan.errors[0].page, 2);
  assert.equal(result.providers.anilist.complete, false);
  assert.equal(result.status, 'partial');
  assert.ok(result.missingFields > 0);
  assert.match(logs.at(-1), /^\[Sync\] .*"missingFields"/);
});

test('successful authoritative provider values update owned fields', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [anime({ score_mal: 9, airing_day: 'friday' })], complete: true, errors: [] }) },
    anilist: { fetchSeason: async () => completeMap(new Map([[1, {
      score_anilist: 91, next_ep_num: 5, next_ep_at: 3000, format: 'ona', popularity: 1234,
      related: [{ relation: 'Prequel', entries: [{ mal_id: 7, type: 'anime', title: 'Before' }] }]
    }]])) },
    shikimori: { fetchBatch: async () => completeMap(new Map([[1, { title_ru: 'Новое', score_shiki: 8.2 }]])) }
  });

  const result = await sync.syncSeason(2026, 'spring');
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.score_mal, 9);
  assert.equal(stored.airing_day, 'friday');
  assert.equal(stored.score_anilist, 91);
  assert.equal(stored.next_ep_num, 5);
  assert.equal(stored.next_ep_at, 3000);
  assert.equal(stored.format, 'ona');
  assert.equal(stored.popularity, 1234);
  assert.deepEqual(JSON.parse(stored.related), [
    { relation: 'Prequel', entries: [{ mal_id: 7, type: 'anime', title: 'Before' }] }
  ]);
  assert.equal(stored.title_ru, 'Новое');
  assert.equal(stored.score_shiki, 8.2);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'complete');
});

test('AniList answering "no next episode" clears the stored countdown during a season sync (#19)', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime({ airing_status: 'Currently Airing' }));
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [anime({ airing_status: 'Currently Airing' })], complete: true, errors: [] }) },
    anilist: { fetchSeason: async () => completeMap(new Map([[1, {
      next_ep_num: null, next_ep_at: null, airing_status: 'Finished Airing', related: []
    }]])) },
    shikimori: { fetchBatch: async () => completeMap() }
  });

  await sync.syncSeason(2026, 'spring');
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, null);
  assert.equal(stored.next_ep_at, null);
  assert.equal(stored.airing_status, 'Finished Airing');
  assert.equal(stored.related, '[]');
  // Fields AniList did not supply are still preserved.
  assert.equal(stored.score_anilist, 70);
  assert.equal(stored.popularity, 500);
});

test('a sync never changes shared Jellyfin availability', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  repository.setAnimeJellyfinAvailability(1, true);
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [anime({ in_jellyfin: 0 })], complete: true, errors: [] }) },
    anilist: { fetchSeason: async () => completeMap(new Map([[1, { title_en: 'Refreshed', in_jellyfin: 0 }]])) },
    shikimori: { fetchBatch: async () => completeMap() }
  });

  await sync.syncSeason(2026, 'spring');
  assert.equal(repository.getAnimeByMalId(1).title_en, 'Refreshed');
  assert.equal(repository.getAnimeByMalId(1).in_jellyfin, 1);
});

test('AniList supplies the whole season list when Jikan is unavailable', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime({ mal_id: 2, season: 'summer_2026', synopsis_en: null, score_mal: 8 }));
  const anilistRecords = new Map([
    [2, { title_en: 'Carried over', synopsis_en: 'From AniList', anilist_id: 20, genres: ['Drama'] }],
    [3, { title_en: 'Brand new', title_jp: '新しい', synopsis_en: 'New synopsis', anilist_id: 30, genres: ['Comedy'], poster_url: 'https://example.test/new.jpg', format: 'tv', popularity: 42 }]
  ]);
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [], complete: false, errors: [{ page: 1, message: 'Jikan API error: 504' }] }) },
    anilist: { fetchSeason: async () => completeMap(anilistRecords) },
    shikimori: { fetchBatch: async () => completeMap() }
  });

  const result = await sync.syncSeason(2026, 'fall');
  assert.equal(result.writes, 2);
  assert.equal(result.jikanOnly, 0);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'partial');

  const created = repository.getAnimeByMalId(3);
  assert.equal(created.title_en, 'Brand new');
  assert.equal(created.synopsis_en, 'New synopsis');
  assert.equal(created.season, 'fall_2026');
  assert.equal(created.genres, '["Comedy"]');
  assert.equal(created.format, 'tv');
  assert.equal(created.popularity, 42);
  assert.equal(created.score_mal, null);

  // AniList is the catalogue, so it places the title in the synced season,
  // while the MAL score Jikan could not refresh is kept.
  const existing = repository.getAnimeByMalId(2);
  assert.equal(existing.synopsis_en, 'From AniList');
  assert.equal(existing.season, 'fall_2026');
  assert.equal(existing.score_mal, 8);
});

test('Jikan supplies the titles AniList missed when AniList is down or incomplete', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime({ mal_id: 4, season: 'summer_2026', next_ep_num: 2, next_ep_at: 5000 }));
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({
      records: [
        { mal_id: 1, title_en: 'Both', score_mal: 8.1 },
        { mal_id: 4, title_en: 'Carried over', score_mal: 7.7 },
        { mal_id: 5, title_en: 'Only on page three', synopsis_en: 'Jikan synopsis', episodes_total: 24, format: 'movie', genres: '["Action"]' }
      ],
      complete: true,
      errors: []
    }) },
    anilist: { fetchSeason: async () => ({
      records: new Map([[1, { title_en: 'Both', popularity: 900 }]]),
      complete: false,
      errors: [{ page: 2, message: 'AniList error: 500' }]
    }) },
    shikimori: { fetchBatch: async (ids) => {
      assert.deepEqual(ids, [1, 4, 5]);
      return completeMap(new Map([[5, { title_ru: 'Только Jikan' }]]));
    } }
  });

  const result = await sync.syncSeason(2026, 'fall');
  assert.equal(result.writes, 3);
  assert.equal(result.jikanOnly, 2);
  assert.equal(result.status, 'partial');

  const jikanOnly = repository.getAnimeByMalId(5);
  assert.equal(jikanOnly.title_en, 'Only on page three');
  assert.equal(jikanOnly.synopsis_en, 'Jikan synopsis');
  assert.equal(jikanOnly.format, 'movie');
  assert.equal(jikanOnly.title_ru, 'Только Jikan');
  assert.equal(jikanOnly.season, 'fall_2026');

  // A Jikan-only title that already belongs to another season stays there and
  // keeps its countdown, since AniList did not answer for it.
  const existing = repository.getAnimeByMalId(4);
  assert.equal(existing.season, 'summer_2026');
  assert.equal(existing.score_mal, 7.7);
  assert.equal(existing.next_ep_num, 2);
  assert.equal(existing.next_ep_at, 5000);
});

test('a complete AniList result is not extended with Jikan-only anime', async (t) => {
  const repository = createRepository(t);
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({
      records: [{ mal_id: 1, synopsis_en: 'Jikan synopsis', score_mal: 8.4, airing_day: 'sundays' }, { mal_id: 9, title_en: 'Jikan only' }],
      complete: true,
      errors: []
    }) },
    anilist: { fetchSeason: async () => completeMap(new Map([[1, { title_en: 'AniList title', synopsis_en: null }]])) },
    shikimori: { fetchBatch: async () => completeMap() }
  });

  const result = await sync.syncSeason(2026, 'spring');
  assert.equal(result.jikanOnly, 0);
  assert.equal(repository.getAnimeByMalId(9), undefined);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.title_en, 'AniList title');
  assert.equal(stored.synopsis_en, 'Jikan synopsis');
  assert.equal(stored.score_mal, 8.4);
  assert.equal(stored.airing_day, 'sundays');
});

test('season sync records its outcome in sync_state', async (t) => {
  const repository = createRepository(t);
  let shikimoriComplete = false;
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [], complete: true, errors: [] }) },
    anilist: { fetchSeason: async () => completeMap(new Map([[1, { title_en: 'One' }]])) },
    shikimori: { fetchBatch: async () => ({
      records: new Map(), complete: shikimoriComplete, errors: shikimoriComplete ? [] : [{ batch: 1, message: 'Shikimori error: 503' }]
    }) }
  });

  await sync.syncSeason(2026, 'fall');
  let state = repository.getSyncState('fall_2026');
  assert.equal(state.last_status, 'partial');
  assert.equal(state.last_attempt_at, NOW_MS / 1000);
  assert.equal(state.last_success_at, null);
  assert.equal(state.consecutive_failures, 1);
  assert.match(state.last_error, /shikimori: Shikimori error: 503/);

  shikimoriComplete = true;
  await sync.syncSeason(2026, 'fall');
  state = repository.getSyncState('fall_2026');
  assert.equal(state.last_status, 'complete');
  assert.equal(state.last_success_at, NOW_MS / 1000);
  assert.equal(state.consecutive_failures, 0);
});

test('a sync where every catalogue provider fails is recorded as failed', async (t) => {
  const repository = createRepository(t);
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => { throw new Error('offline'); } },
    anilist: { fetchSeason: async () => { throw new Error('offline'); } },
    shikimori: { fetchBatch: async () => completeMap() }
  });
  const result = await sync.syncSeason(2026, 'fall');
  assert.equal(result.writes, 0);
  assert.equal(result.status, 'failed');
  assert.equal(repository.getSyncState('fall_2026').last_status, 'failed');
});

test('countdown refresh clears a stored countdown when AniList reports no next episode', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = syncWith(repository, {
    anilist: { fetchByMalIds: async () => completeMap(new Map([[
      1, { next_ep_num: null, next_ep_at: null, airing_status: 'Finished Airing', episodes_total: null }
    ]])) }
  });

  assert.equal(await sync.refreshCountdowns([1]), 1);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, null);
  assert.equal(stored.next_ep_at, null);
  assert.equal(stored.airing_status, 'Finished Airing');
  assert.equal(stored.episodes_total, 12);
});

test('countdown refresh stores the next episode reported by AniList', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = syncWith(repository, {
    anilist: { fetchByMalIds: async () => completeMap(new Map([[
      1, { next_ep_num: 5, next_ep_at: 2000 }
    ]])) }
  });

  assert.equal(await sync.refreshCountdowns([1]), 1);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, 5);
  assert.equal(stored.next_ep_at, 2000);
  assert.equal(repository.getSyncState('countdowns').last_status, 'complete');
});

test('countdown refresh preserves a stored countdown when AniList omits the title', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = syncWith(repository, {
    anilist: { fetchByMalIds: async () => ({ records: new Map([[2, {}]]), complete: false, errors: [{ batch: 1, message: 'timeout' }] }) }
  });

  assert.equal(await sync.refreshCountdowns([1]), 0);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.next_ep_num, 4);
  assert.equal(stored.next_ep_at, 1000);
  assert.equal(repository.getSyncState('countdowns').last_status, 'partial');
});

test('countdown refresh covers due titles and tracked titles regardless of season', async (t) => {
  const repository = createRepository(t);
  const nowSeconds = NOW_MS / 1000;
  repository.upsertAnime(anime({ mal_id: 1, season: 'spring_2020', next_ep_at: nowSeconds - 60 }));
  repository.upsertAnime(anime({ mal_id: 2, season: 'fall_2026', next_ep_at: nowSeconds + 3600, airing_status: 'Not yet aired' }));
  repository.upsertAnime(anime({ mal_id: 3, next_ep_at: nowSeconds + 10 * 86400 }));
  repository.upsertAnime(anime({ mal_id: 4, next_ep_at: null, airing_status: 'Finished Airing' }));
  repository.upsertAnime(anime({ mal_id: 5, next_ep_at: null, airing_status: 'Currently Airing', season: 'winter_2019' }));
  repository.upsertAnime(anime({ mal_id: 6, next_ep_at: null, airing_status: 'Finished Airing' }));
  // Airing but untracked and without a known countdown: still refreshed.
  repository.upsertAnime(anime({ mal_id: 7, next_ep_at: null, airing_status: 'Currently Airing', season: 'summer_2026' }));
  // Not yet aired and far away: left to the season sync.
  repository.upsertAnime(anime({ mal_id: 8, next_ep_at: nowSeconds + 10 * 86400, airing_status: 'Not yet aired' }));
  const user = repository.createUser('user', 'hash');
  repository.setUserAnimeStatus(user.id, 5, 'following');
  repository.setUserAnimeStatus(user.id, 6, 'watching');
  repository.setUserAnimeStatus(user.id, 4, 'watched');

  let requested;
  const sync = syncWith(repository, {
    anilist: { fetchByMalIds: async (ids) => { requested = ids; return completeMap(); } }
  });
  await sync.refreshCountdowns();
  assert.deepEqual(requested, [1, 2, 3, 5, 7]);
});

test('empty and malformed provider results are incomplete without damaging stored data', async (t) => {
  const repository = createRepository(t);
  repository.upsertAnime(anime());
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => undefined },
    anilist: { fetchSeason: async () => ({ records: new Map(), complete: true, errors: [] }) },
    shikimori: { fetchBatch: async () => completeMap() }
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
        data: [{ mal_id: 1, title: 'One', type: 'TV Special', images: { jpg: {} }, genres: [] }],
        pagination: { has_next_page: true }
      })
    };
  }, 2026, 'spring');
  assert.equal(laterFailure.complete, false);
  assert.equal(laterFailure.errors[0].page, 2);
  assert.equal(laterFailure.records.length, 1);
  assert.equal(laterFailure.records[0].format, 'special');
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
    now: () => NOW_MS,
    providers: {
      jikan: { fetchSeason: async () => ({ records: [], complete: true, errors: [] }) },
      anilist: { fetchSeason: async () => {
        providerCalls++;
        return completeMap(new Map([[1, { title_en: 'New one' }], [2, { title_en: 'New two' }]]));
      } },
      shikimori: { fetchBatch: async () => completeMap() }
    },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) }
  });

  await assert.rejects(sync.syncSeason(2026, 'spring'), /injected write failure/);
  assert.equal(repository.getAnimeByMalId(1).title_en, 'Old one');
  assert.equal(repository.getAnimeByMalId(2).title_en, 'Old two');
  assert.match(logs.at(-1), /"transaction":"rolled_back"/);
  assert.equal(repository.getSyncState('spring_2026').last_status, 'failed');
  assert.equal(repository.getSyncState('spring_2026').last_error, 'injected write failure');
  await assert.rejects(sync.syncSeason(2026, 'spring'), /injected write failure/);
  assert.equal(providerCalls, 2);
  assert.equal(repository.getSyncState('spring_2026').consecutive_failures, 2);
});

test('concurrent synchronization for one season is skipped and later runs can proceed', async (t) => {
  const repository = createRepository(t);
  let releaseFirst;
  let calls = 0;
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [], complete: true, errors: [] }) },
    anilist: { fetchSeason: async () => {
      calls++;
      if (calls === 1) return firstResult;
      return completeMap();
    } },
    shikimori: { fetchBatch: async () => completeMap() }
  });

  const first = sync.syncSeason(2026, 'spring');
  assert.equal(sync.isSyncing(2026, 'spring'), true);
  assert.equal(sync.isSyncing(2026, 'summer'), false);
  const overlap = await sync.syncSeason(2026, 'spring');
  assert.deepEqual(overlap, {
    year: 2026, season: 'spring', skipped: true, reason: 'overlap', transaction: 'not_started'
  });
  assert.equal(calls, 1);
  releaseFirst(completeMap());
  assert.equal((await first).transaction, 'committed');
  assert.equal(sync.isSyncing(2026, 'spring'), false);
  assert.equal((await sync.syncSeason(2026, 'spring')).skipped, undefined);
  assert.equal(calls, 2);
});

test('AniList descriptions are reduced to plain text', () => {
  assert.equal(cleanDescription('First line.<br><br>\n<i>Second</i> &amp; third.<br /><br><br><br>(Source: X)'), 'First line.\n\nSecond & third.\n\n(Source: X)');
  assert.equal(cleanDescription('<br>'), null);
  assert.equal(cleanDescription(null), null);
});

test('AniList omitting relations keeps stored relations; an explicit empty list clears them', async (t) => {
  const repository = createRepository(t);
  const stored = '[{"relation":"Sequel","entries":[{"mal_id":2,"type":"anime","title":"Two"}]}]';
  repository.upsertAnime(anime({ related: stored }));
  let relations = null;
  const anilistClient = createAniListClient({
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data: { Page: {
        pageInfo: { hasNextPage: false },
        media: [{ id: 10, idMal: 1, title: { english: 'One' }, status: 'RELEASING', ...(relations === undefined ? {} : { relations }) }]
      } } })
    }),
    sleep: async () => {}, logger: quiet, minIntervalMs: 0
  });
  const sync = syncWith(repository, {
    jikan: { fetchSeason: async () => ({ records: [], complete: true, errors: [] }) },
    anilist: anilistClient,
    shikimori: { fetchBatch: async () => completeMap() }
  });

  await sync.syncSeason(2026, 'spring');
  assert.equal(repository.getAnimeByMalId(1).related, stored, 'relations: null keeps stored relations');

  relations = undefined;
  await sync.syncSeason(2026, 'spring');
  assert.equal(repository.getAnimeByMalId(1).related, stored, 'an omitted field keeps stored relations');

  relations = { edges: [] };
  await sync.syncSeason(2026, 'spring');
  assert.equal(repository.getAnimeByMalId(1).related, '[]');
});
