const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');

const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/db');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Uses the real SQLite session store so stored rows can be counted.
async function withApp(t, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-sessions-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  const app = createApp({ repository, sessionSecret: 'test-secret', registrationOpen: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const sessions = () => repository.db.prepare('SELECT sid, sess, expire FROM sessions').all();
    await callback(`http://127.0.0.1:${server.address().port}`, { repository, sessions });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function cookieExpiry(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a session cookie');
  return Date.parse(header.match(/Expires=([^;]+)/i)[1]);
}

function assertNear(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 60_000, `${label}: ${new Date(actual).toISOString()}`);
}

test('anonymous requests without a form store no session', async (t) => {
  await withApp(t, async (baseUrl, { sessions }) => {
    const requests = [
      fetch(`${baseUrl}/`, { redirect: 'manual' }),
      fetch(`${baseUrl}/season/2026/spring`, { redirect: 'manual' }),
      fetch(`${baseUrl}/no-such-page`),
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/api/anime/1`),
      // Malformed JSON reaches the error page.
      fetch(`${baseUrl}/api/mark`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
      }),
      // CSRF rejection without a session still rejects, and stores nothing.
      fetch(`${baseUrl}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'x', password: 'y' })
      })
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), [302, 302, 404, 200, 401, 500, 403]);
    for (const response of responses) assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(sessions().length, 0);
  });
});

test('form pages create one short-lived anonymous session and login restores 30 days', async (t) => {
  await withApp(t, async (baseUrl, { repository, sessions }) => {
    repository.createUser('tester', await bcrypt.hash('test-password', 4));

    const loginPage = await fetch(`${baseUrl}/login`);
    const cookie = loginPage.headers.get('set-cookie').split(';', 1)[0];
    const token = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    assert.equal(sessions().length, 1);
    assertNear(cookieExpiry(loginPage), Date.now() + HOUR_MS, 'anonymous cookie');
    assertNear(Date.parse(sessions()[0].expire), Date.now() + HOUR_MS, 'anonymous row');

    // Revisiting with the cookie reuses the session and token.
    const again = await fetch(`${baseUrl}/login`, { headers: { cookie } });
    assert.equal((await again.text()).match(/name="_csrf" value="([^"]+)"/)[1], token);
    assert.equal(sessions().length, 1);

    const register = await fetch(`${baseUrl}/register`);
    assert.equal(register.status, 200);
    assert.ok(register.headers.get('set-cookie'));
    assert.equal(sessions().length, 2);

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'tester', password: 'test-password', _csrf: token })
    });
    assert.equal(login.status, 302);
    assertNear(cookieExpiry(login), Date.now() + 30 * DAY_MS, 'authenticated cookie');
    const authenticatedCookie = login.headers.get('set-cookie').split(';', 1)[0];
    const authenticated = sessions().find((row) => JSON.parse(row.sess).userId);
    assertNear(Date.parse(authenticated.expire), Date.now() + 30 * DAY_MS, 'authenticated row');
    // Regeneration replaced the anonymous login session.
    assert.equal(sessions().length, 2);

    // Authenticated pages still carry the token for the meta tag and forms.
    const page = await fetch(`${baseUrl}/season/2026/spring`, { headers: { cookie: authenticatedCookie } });
    const html = await page.text();
    const pageToken = html.match(/name="csrf-token" content="([^"]+)"/)[1];
    assert.notEqual(pageToken, token);
    assert.match(html, new RegExp(`name="_csrf" value="${pageToken}"`));
  });
});
