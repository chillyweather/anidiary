const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');
const session = require('express-session');

const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/db');
const { createScheduler } = require('../src/scheduler');

test('application serves an authenticated session from an isolated database', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-test-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  const passwordHash = await bcrypt.hash('test-password', 4);
  repository.createUser('tester', passwordHash);
  const russian = repository.createUser('russian', passwordHash);
  repository.updateUserLangPref(russian.id, 'ru');
  const japanese = repository.createUser('japanese', passwordHash);
  repository.updateUserLangPref(japanese.id, 'jp');
  repository.upsertAnime({
    mal_id: 1, title_en: 'English title', title_jp: '日本語タイトル', title_ru: 'Русское название',
    synopsis_en: `English synopsis ${'x'.repeat(130)} FULL_SYNOPSIS_TAIL`, synopsis_ru: 'Русское описание', poster_url: null,
    score_mal: null, score_anilist: null, score_shiki: null, episodes_total: 12,
    season: 'spring_2026', airing_status: 'Currently Airing', airing_day: null,
    next_ep_num: null, next_ep_at: null, anilist_id: null, genres: '[]', related: null
  });
  let detailProviderCalls = 0;

  const app = createApp({
    repository,
    sessionSecret: 'test-secret',
    sessionStore: new session.MemoryStore(),
    providers: {
      fetchAnimeDetail: async () => {
        detailProviderCalls++;
        return { related: '[]' };
      }
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
    resolve();
  })));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const unauthenticatedDetail = await fetch(`${baseUrl}/api/anime/1`);
  assert.equal(unauthenticatedDetail.status, 401);
  assert.deepEqual(await unauthenticatedDetail.json(), { error: 'Not authenticated' });
  assert.equal(detailProviderCalls, 0);
  assert.equal(repository.getAnimeByMalId(1).related, null);

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.headers.get('x-content-type-options'), 'nosniff');
  assert.match(loginPage.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(loginPage.headers.get('content-security-policy'), /unsafe-inline/);
  const loginPageHtml = await loginPage.text();
  const initialCookie = loginPage.headers.get('set-cookie').split(';', 1)[0];
  const initialToken = loginPageHtml.match(/name="_csrf" value="([^"]+)"/)[1];
  const missingTokenLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'tester', password: 'test-password' })
  });
  assert.equal(missingTokenLogin.status, 403);
  const invalidTokenLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: {
      cookie: initialCookie,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: 'tester', password: 'test-password', _csrf: 'invalid' })
  });
  assert.equal(invalidTokenLogin.status, 403);
  async function renderFor(username) {
    const form = await fetch(`${baseUrl}/login`);
    const formCookie = form.headers.get('set-cookie').split(';', 1)[0];
    const formToken = (await form.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: formCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'test-password', _csrf: formToken })
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const response = await fetch(`${baseUrl}/season/2026/spring`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
    return { html, cookie, token, formToken };
  }

  const englishSession = await renderFor('tester');
  const englishHtml = englishSession.html;
  assert.match(englishHtml, /Spring 2026/);
  assert.match(englishHtml, />Language</);
  assert.doesNotMatch(englishHtml, /data-modal=/);
  assert.doesNotMatch(englishHtml, /FULL_SYNOPSIS_TAIL/);

  const russianHtml = (await renderFor('russian')).html;
  assert.match(russianHtml, /Весна 2026/);
  assert.match(russianHtml, /Связанные аниме/);

  const japaneseHtml = (await renderFor('japanese')).html;
  assert.match(japaneseHtml, /日本語タイトル/);
  assert.match(japaneseHtml, />Language</);
  assert.doesNotMatch(japaneseHtml, />Язык</);

  const authenticatedDetail = await fetch(`${baseUrl}/api/anime/1`, {
    headers: { cookie: englishSession.cookie }
  });
  assert.equal(authenticatedDetail.status, 200);
  assert.equal(detailProviderCalls, 1);
  assert.equal(repository.getAnimeByMalId(1).related, '[]');

  const missingApiToken = await fetch(`${baseUrl}/api/mark`, {
    method: 'POST',
    headers: { cookie: englishSession.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ mal_id: 1, status: 'following' })
  });
  assert.equal(missingApiToken.status, 403);
  const staleApiToken = await fetch(`${baseUrl}/api/mark`, {
    method: 'POST',
    headers: {
      cookie: englishSession.cookie,
      'content-type': 'application/json',
      'x-csrf-token': englishSession.formToken
    },
    body: JSON.stringify({ mal_id: 1, status: 'following' })
  });
  assert.equal(staleApiToken.status, 403);
  const validApiToken = await fetch(`${baseUrl}/api/mark`, {
    method: 'POST',
    headers: {
      cookie: englishSession.cookie,
      'content-type': 'application/json',
      'x-csrf-token': englishSession.token
    },
    body: JSON.stringify({ mal_id: 1, status: 'following' })
  });
  assert.equal(validApiToken.status, 200);
  assert.deepEqual(await validApiToken.json(), { ok: true, status: 'following' });

  const jellyfin = await fetch(`${baseUrl}/api/jellyfin`, {
    method: 'POST',
    headers: {
      cookie: englishSession.cookie,
      'content-type': 'application/json',
      'x-csrf-token': englishSession.token
    },
    body: JSON.stringify({ mal_id: 1, available: true })
  });
  assert.deepEqual(await jellyfin.json(), { ok: true, available: true });
  assert.equal(repository.getAnimeByMalId(1).in_jellyfin, 1);
  assert.equal(repository.getUserAnimeStatusByMalId(1, 1).status, 'following');

  const language = await fetch(`${baseUrl}/api/lang`, {
    method: 'POST',
    headers: {
      cookie: englishSession.cookie,
      'content-type': 'application/json',
      'x-csrf-token': englishSession.token
    },
    body: JSON.stringify({ lang: 'ru' })
  });
  assert.deepEqual(await language.json(), { ok: true });
  assert.equal(repository.getUserByUsername('tester').lang_pref, 'ru');

  const logout = await fetch(`${baseUrl}/logout`, {
    method: 'POST', redirect: 'manual',
    headers: {
      cookie: englishSession.cookie,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ _csrf: englishSession.token })
  });
  assert.equal(logout.status, 302);
  const afterLogout = await fetch(`${baseUrl}/api/anime/1`, { headers: { cookie: englishSession.cookie } });
  assert.equal(afterLogout.status, 401);
});

test('scheduler lifecycle is explicit and idempotent', () => {
  const scheduler = createScheduler({
    syncService: { syncSeason: async () => {}, refreshCountdowns: async () => {} },
    getCurrentSeason: () => ({ year: 2026, season: 'spring' })
  });

  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
});
