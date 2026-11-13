const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');
const session = require('express-session');

const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/db');
const { createSyncService } = require('../src/services/sync');
const { getCurrentSeason, getAdjacentSeasons } = require('../src/domain/seasons');

const quiet = { log() {}, error() {} };
const offline = async () => { throw new Error('tests never reach a provider'); };
const OFFLINE_PROVIDERS = {
  jikan: { fetchSeason: offline }, anilist: { fetchSeason: offline, fetchByMalIds: offline },
  shikimori: { fetchBatch: offline }
};

async function withSeedApp(t, providers, callback, { clock } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-seed-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  repository.createUser('tester', await bcrypt.hash('test-password', 4));
  const now = clock ? () => clock.ms : undefined;
  const syncService = createSyncService({ repository, providers, logger: quiet, ...(now ? { now } : {}) });
  const app = createApp({
    repository, syncService, now, sessionSecret: 'test-secret', sessionStore: new session.MemoryStore()
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      repository.close();
      fs.rmSync(directory, { recursive: true, force: true });
      resolve();
    });
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const form = await fetch(`${baseUrl}/login`);
  const formCookie = form.headers.get('set-cookie').split(';', 1)[0];
  const formToken = (await form.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: formCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'tester', password: 'test-password', _csrf: formToken })
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const get = async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { cookie } });
    return { status: response.status, html: await response.text(), json: response.headers.get('content-type')?.includes('json') };
  };
  const getJson = async (pathname) => (await fetch(`${baseUrl}${pathname}`, { headers: { cookie } })).json();
  // A far-future season is never seeded, so reading the token has no side effects.
  const page = await get('/season/2100/winter');
  const csrfToken = page.html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const post = async (pathname, token = csrfToken) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(token === null ? {} : { _csrf: token })
    });
    return { status: response.status, location: response.headers.get('location') };
  };
  await callback({ get, getJson, post, repository, syncService });
}

async function settled(syncService, year, season) {
  for (let i = 0; i < 100 && syncService.isSyncing(year, season); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(syncService.isSyncing(year, season), false);
}

const FAILED = /role="status">\s*<p>\s*This season could not be fetched/;
const FETCHING = /role="status">Fetching this season/;
const MINUTE_MS = 60 * 1000;
const REFRESH = /<meta http-equiv="refresh" content="10;url=\/season\/2010\/winter">/;

test('first visit to a never-synced season queues one background sync and shows its progress', async (t) => {
  let releaseAniList;
  let anilistCalls = 0;
  const providers = {
    jikan: { fetchSeason: async () => ({ records: [], complete: true, errors: [] }) },
    anilist: { fetchSeason: () => {
      anilistCalls++;
      return new Promise((resolve) => { releaseAniList = resolve; });
    } },
    shikimori: { fetchBatch: async () => ({ records: new Map(), complete: true, errors: [] }) }
  };

  await withSeedApp(t, providers, async ({ get, syncService }) => {
    const first = await get('/season/2010/winter');
    assert.equal(first.status, 200);
    assert.match(first.html, FETCHING);
    assert.match(first.html, REFRESH);
    assert.equal(anilistCalls, 1);

    const again = await get('/season/2010/winter');
    assert.match(again.html, /role="status">Fetching this season/);
    assert.equal(anilistCalls, 1, 'a pending sync is not queued twice');

    releaseAniList({ records: new Map([[42, { title_en: 'Seeded title', popularity: 10 }]]), complete: true, errors: [] });
    await settled(syncService, 2010, 'winter');

    const done = await get('/season/2010/winter');
    assert.match(done.html, /Seeded title/);
    assert.doesNotMatch(done.html, /http-equiv="refresh"/);
    assert.doesNotMatch(done.html, /role="status">Fetching this season/);
    assert.equal(anilistCalls, 1);
  });
});

function failingProviders() {
  const counts = { anilist: 0 };
  return {
    counts,
    providers: {
      jikan: { fetchSeason: async () => { throw new Error('offline'); } },
      anilist: { fetchSeason: async () => { counts.anilist++; throw new Error('offline'); } },
      shikimori: { fetchBatch: async () => ({ records: new Map(), complete: true, errors: [] }) }
    }
  };
}

test('a failed first sync waits out its persisted backoff and offers a CSRF-protected retry', async (t) => {
  const { counts, providers } = failingProviders();
  const clock = { ms: 1_800_000_000_000 };

  await withSeedApp(t, providers, async ({ get, post, syncService, repository }) => {
    await get('/season/2010/winter');
    await settled(syncService, 2010, 'winter');
    assert.equal(repository.getSyncState('winter_2010').last_status, 'failed');
    assert.equal(counts.anilist, 1);

    const failed = await get('/season/2010/winter');
    assert.match(failed.html, FAILED);
    assert.match(failed.html, /<time datetime="[^"]+">It will be tried again automatically in about 60 min\.<\/time>/);
    assert.match(failed.html, /<form method="POST" action="\/season\/2010\/winter\/retry">\s*<input type="hidden" name="_csrf" value="[^"]+">/);
    assert.doesNotMatch(failed.html, /http-equiv="refresh"/);

    // Views inside the backoff window never start a sync, however many there are.
    clock.ms += 59 * MINUTE_MS;
    for (let i = 0; i < 3; i++) assert.match((await get('/season/2010/winter')).html, FAILED);
    assert.equal(counts.anilist, 1);

    // Once the backoff has passed, the next view retries on its own.
    clock.ms += MINUTE_MS;
    assert.match((await get('/season/2010/winter')).html, FETCHING);
    await settled(syncService, 2010, 'winter');
    assert.equal(counts.anilist, 2);
    assert.equal(repository.getSyncState('winter_2010').consecutive_failures, 2);
    assert.match((await get('/season/2010/winter')).html, /about 120 min/);
  }, { clock });
});

test('a manual retry bypasses the backoff at most once every few minutes', async (t) => {
  const { counts, providers } = failingProviders();
  const clock = { ms: 1_800_000_000_000 };

  await withSeedApp(t, providers, async ({ get, post, syncService }) => {
    await get('/season/2010/winter');
    await settled(syncService, 2010, 'winter');
    assert.equal(counts.anilist, 1);

    // Right after the automatic attempt, a manual retry is refused.
    const tooSoon = await post('/season/2010/winter/retry');
    assert.equal(tooSoon.status, 303);
    assert.equal(tooSoon.location, '/season/2010/winter');
    assert.equal(counts.anilist, 1);

    clock.ms += 5 * MINUTE_MS;
    assert.equal((await post('/season/2010/winter/retry')).status, 303);
    // Repeated clicks while it runs or right after it fails do nothing more.
    await post('/season/2010/winter/retry');
    await settled(syncService, 2010, 'winter');
    await post('/season/2010/winter/retry');
    await post('/season/2010/winter/retry');
    await settled(syncService, 2010, 'winter');
    assert.equal(counts.anilist, 2);

    clock.ms += 5 * MINUTE_MS;
    await post('/season/2010/winter/retry');
    await settled(syncService, 2010, 'winter');
    assert.equal(counts.anilist, 3);
    assert.match((await get('/season/2010/winter')).html, FAILED);
  }, { clock });
});

test('a retry without a valid CSRF token is rejected and starts nothing', async (t) => {
  const { counts, providers } = failingProviders();
  const clock = { ms: 1_800_000_000_000 };

  await withSeedApp(t, providers, async ({ get, post, syncService }) => {
    await get('/season/2010/winter');
    await settled(syncService, 2010, 'winter');
    clock.ms += 10 * MINUTE_MS;

    assert.equal((await post('/season/2010/winter/retry', null)).status, 403);
    assert.equal((await post('/season/2010/winter/retry', 'forged-token-value-forged-token-valu')).status, 403);
    assert.equal(counts.anilist, 1);
    assert.equal(syncService.isSyncing(2010, 'winter'), false);
  }, { clock });
});

test('views of several unsynced seasons share one queue: one sync at a time, at most three waiting', async (t) => {
  const releases = [];
  let running = 0;
  let maxRunning = 0;
  const providers = {
    jikan: { fetchSeason: async () => ({ records: [], complete: true, errors: [] }) },
    anilist: { fetchSeason: () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise((resolve) => releases.push(() => {
        running--;
        resolve({ records: new Map(), complete: true, errors: [] });
      }));
    } },
    shikimori: { fetchBatch: async () => ({ records: new Map(), complete: true, errors: [] }) }
  };
  const seasons = [[2010, 'winter'], [2010, 'spring'], [2010, 'summer'], [2010, 'fall'], [2011, 'winter']];

  await withSeedApp(t, providers, async ({ get, syncService }) => {
    for (const [year, season] of seasons) {
      assert.match((await get(`/season/${year}/${season}`)).html, FETCHING);
    }
    assert.equal(releases.length, 1, 'only the first season is fetching');
    assert.deepEqual(seasons.map(([year, season]) => syncService.isSyncing(year, season)),
      [true, true, true, false, false]);

    // Visiting the busy seasons again still does not queue them.
    await get('/season/2010/fall');
    assert.equal(syncService.isSyncing(2010, 'fall'), false);

    for (let i = 0; i < 3; i++) {
      while (releases.length <= i) await new Promise((resolve) => setImmediate(resolve));
      releases[i]();
    }
    await settled(syncService, 2010, 'summer');
    assert.equal(releases.length, 3);
    assert.equal(maxRunning, 1);

    // With room in the queue, the next view of a waiting season queues it.
    assert.match((await get('/season/2010/fall')).html, FETCHING);
    assert.equal(syncService.isSyncing(2010, 'fall'), true);
    while (releases.length < 4) await new Promise((resolve) => setImmediate(resolve));
    releases[3]();
    await settled(syncService, 2010, 'fall');
  });
});

test('seasons more than one season ahead are never fetched on visit', async (t) => {
  let calls = 0;
  const counting = async () => { calls++; return { records: new Map(), complete: true, errors: [] }; };
  const providers = {
    jikan: { fetchSeason: async () => { calls++; return { records: [], complete: true, errors: [] }; } },
    anilist: { fetchSeason: counting },
    shikimori: { fetchBatch: counting }
  };

  await withSeedApp(t, providers, async ({ get, syncService }) => {
    const current = getCurrentSeason();
    const next = getAdjacentSeasons(current.year, current.season);
    const afterNext = getAdjacentSeasons(next.nextYear, next.nextSeason);

    const farFuture = await get(`/season/${afterNext.nextYear}/${afterNext.nextSeason}`);
    assert.equal(farFuture.status, 200);
    assert.doesNotMatch(farFuture.html, /role="status">Fetching this season/);
    assert.equal(calls, 0);

    const nextSeason = await get(`/season/${next.nextYear}/${next.nextSeason}`);
    assert.match(nextSeason.html, /role="status">Fetching this season/);
    await settled(syncService, next.nextYear, next.nextSeason);

    const empty = await get(`/season/${next.nextYear}/${next.nextSeason}`);
    assert.match(empty.html, /role="status">No anime are listed/);
    assert.doesNotMatch(empty.html, /http-equiv="refresh"/);
  });
});

test('the modal reads series navigation from relations stored by the sync', async (t) => {
  await withSeedApp(t, OFFLINE_PROVIDERS, async ({ getJson, repository }) => {
    const base = { genres: '[]', season: 'fall_2026' };
    repository.upsertAnime({ ...base, mal_id: 1, title_en: 'Season one', season: 'fall_2025' });
    repository.upsertAnime({
      ...base, mal_id: 2, title_en: 'Season two', popularity: 10, format: 'tv',
      related: JSON.stringify([
        { relation: 'Prequel', entries: [{ mal_id: 1, type: 'anime', title: 'Season one' }] },
        { relation: 'Adaptation', entries: [{ mal_id: 99, type: 'manga', title: 'Manga' }] }
      ])
    });
    const detail = await getJson('/api/anime/2');
    assert.equal(detail.series_nav.previous.mal_id, 1);
    assert.equal(detail.series_nav.previous.season, 'fall_2025');
    assert.equal(detail.series_nav.next, null);
    assert.equal(detail.related.length, 2);
    // Related titles stored in our catalogue carry `local` so the dialog can open them.
    assert.deepEqual(detail.related[0].entries[0].local, {
      mal_id: 1, title_en: 'Season one', title_jp: null, title_ru: null, season: 'fall_2025', season_label: 'Fall 2025'
    });
    assert.equal('local' in detail.related[1].entries[0], false);
    assert.deepEqual(detail.partners, []);
  });
});

test('season cards expose popularity and format, and popularity is the default sort', async (t) => {
  await withSeedApp(t, OFFLINE_PROVIDERS, async ({ get, repository }) => {
    repository.upsertAnime({ mal_id: 5, title_en: 'Card', season: 'spring_2026', genres: '[]', popularity: 321, format: 'movie' });
    const page = await get('/season/2026/spring');
    assert.match(page.html, /data-popularity="321"/);
    assert.match(page.html, /data-format="movie"/);
    assert.match(page.html, /<option value="popularity" selected>Popularity<\/option>/);
  });
});
