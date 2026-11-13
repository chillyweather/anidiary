const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');
const session = require('express-session');

const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/db');

test('household members see each other\'s states but can change only their own', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-household-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  const hash = await bcrypt.hash('test-password', 4);
  const anna = repository.createUser('anna', hash).id;
  const dima = repository.createUser('dima', hash).id;
  repository.upsertAnime({ mal_id: 1, title_en: 'Shared show', season: 'fall_2026', genres: '[]', popularity: 10 });
  repository.upsertAnime({ mal_id: 2, title_en: 'Other show', season: 'fall_2026', genres: '[]', popularity: 5 });
  repository.setUserAnimeStatus(anna, 1, 'watching');

  const app = createApp({ repository, sessionSecret: 'test-secret', sessionStore: new session.MemoryStore() });
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

  async function login(username) {
    const form = await fetch(`${baseUrl}/login`);
    const formCookie = form.headers.get('set-cookie').split(';', 1)[0];
    const formToken = (await form.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: formCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'test-password', _csrf: formToken })
    });
    const cookie = response.headers.get('set-cookie').split(';', 1)[0];
    const page = await (await fetch(`${baseUrl}/season/2026/fall`, { headers: { cookie } })).text();
    const token = page.match(/name="csrf-token" content="([^"]+)"/)[1];
    return { cookie, token, page };
  }

  const dimaSession = await login('dima');
  // Dima's page shows Anna's state as a chip on her title only.
  const shared = dimaSession.page.match(/<li class="title" data-mal-id="1"[\s\S]*?<\/li>/)[0];
  assert.match(shared, /data-status=""/, 'Anna\'s state is not Dima\'s state');
  assert.match(shared, /<span class="chip" data-status="watching" title="anna: watching">/);
  const other = dimaSession.page.match(/<li class="title" data-mal-id="2"[\s\S]*?<\/li>/)[0];
  assert.doesNotMatch(other, /class="chip"/);

  const detail = await (await fetch(`${baseUrl}/api/anime/1`, { headers: { cookie: dimaSession.cookie } })).json();
  assert.deepEqual(detail.partners, [{ username: 'anna', status: 'watching' }]);
  assert.equal(detail.user_status, null);

  // Naming another user in the request has no effect: /api/mark writes only
  // the session user's row.
  const post = (body) => fetch(`${baseUrl}/api/mark`, {
    method: 'POST',
    headers: { cookie: dimaSession.cookie, 'content-type': 'application/json', 'x-csrf-token': dimaSession.token },
    body: JSON.stringify(body)
  });
  assert.equal((await post({ mal_id: 1, status: 'watched', user_id: anna, username: 'anna' })).status, 200);
  assert.equal(repository.getUserAnimeStatusByMalId(anna, 1).status, 'watching');
  assert.equal(repository.getUserAnimeStatusByMalId(dima, 1).status, 'watched');
  assert.equal((await post({ mal_id: 1, status: 'none', user_id: anna })).status, 200);
  assert.equal(repository.getUserAnimeStatusByMalId(anna, 1).status, 'watching');
  assert.equal(repository.getUserAnimeStatusByMalId(dima, 1), undefined);

  // Anna sees nothing of her own as a chip, and Dima's earlier change is gone.
  const annaSession = await login('anna');
  const annaShared = annaSession.page.match(/<li class="title" data-mal-id="1"[\s\S]*?<\/li>/)[0];
  assert.match(annaShared, /data-status="watching"/);
  assert.doesNotMatch(annaShared, /class="chip"/);
  assert.deepEqual(repository.getOtherUsersStatuses(anna), []);
  assert.deepEqual(repository.getOtherUsersStatuses(dima), [{ mal_id: 1, username: 'anna', status: 'watching' }]);
});
