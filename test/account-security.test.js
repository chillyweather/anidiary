const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const session = require('express-session');
const bcrypt = require('bcrypt');

const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/db');
const { validatePassword } = require('../src/routes/auth');
const { parseTrustProxy } = require('../server');

test('password validation enforces character minimum and bcrypt byte maximum', () => {
  assert.match(validatePassword('short'), /12 characters/);
  assert.equal(validatePassword('twelve-chars'), null);
  assert.equal(validatePassword('a'.repeat(72)), null);
  assert.match(validatePassword('é'.repeat(37)), /72 UTF-8 bytes/);
});

test('proxy configuration accepts explicit topologies and rejects permissive true', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
  assert.throws(() => parseTrustProxy('true'), /hop count/);
});

async function withApp(t, options, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-account-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  const app = createApp({
    repository,
    sessionSecret: 'test-secret',
    sessionStore: new session.MemoryStore(),
    ...options
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(baseUrl, repository);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('registration configuration hides and rejects account creation when closed', async (t) => {
  await withApp(t, { registrationOpen: false }, async (baseUrl, repository) => {
    repository.createUser('existing', await bcrypt.hash('existing-password', 4));
    const page = await fetch(`${baseUrl}/register`);
    assert.equal(page.status, 404);
    assert.doesNotMatch(await page.text(), /action="\/register"/);
    const loginPage = await fetch(`${baseUrl}/login`);
    const cookie = loginPage.headers.get('set-cookie').split(';', 1)[0];
    const token = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'existing', password: 'existing-password', _csrf: token })
    });
    assert.equal(login.status, 302);
  });
  await withApp(t, { registrationOpen: true }, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/register`);
    assert.equal(page.status, 200);
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const html = await page.text();
    const token = html.match(/name="_csrf" value="([^"]+)"/)[1];
    assert.match(html, /action="\/register"/);

    async function register(password) {
      return fetch(`${baseUrl}/register`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'new_user', password, _csrf: token })
      });
    }
    assert.equal((await register('short')).status, 400);
    assert.equal((await register('é'.repeat(37))).status, 400);
    assert.equal((await register('valid-password')).status, 302);
  });
});

test('forwarded addresses affect auth rate limits only for the configured proxy topology', async (t) => {
  async function attempt(baseUrl, forwardedFor) {
    const page = await fetch(`${baseUrl}/login`, { headers: { 'x-forwarded-for': forwardedFor } });
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    return fetch(`${baseUrl}/login`, {
      method: 'POST', redirect: 'manual',
      headers: {
        cookie,
        'x-forwarded-for': forwardedFor,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ _csrf: token })
    });
  }

  await withApp(t, { trustProxy: false, authRateLimitMax: 1 }, async (baseUrl) => {
    assert.equal((await attempt(baseUrl, '203.0.113.1')).status, 200);
    assert.equal((await attempt(baseUrl, '203.0.113.2')).status, 429);
  });
  await withApp(t, { trustProxy: 1, authRateLimitMax: 1 }, async (baseUrl) => {
    assert.equal((await attempt(baseUrl, '203.0.113.1')).status, 200);
    assert.equal((await attempt(baseUrl, '203.0.113.2')).status, 200);
  });
});
