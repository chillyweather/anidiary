const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const session = require('express-session');

const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/db');
const { createAssetVersions } = require('../src/assets');

const publicDir = path.join(__dirname, '../public');

function contentHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
}

// fetch() adds `Cache-Control: no-cache` to conditional requests, which defeats
// revalidation, so conditional GETs use node:http directly.
function conditionalGet(url, etag) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'if-none-match': etag } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

async function withApp(t, options, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-assets-'));
  const repository = createDatabase(path.join(directory, 'test.db'));
  repository.init();
  const app = createApp({
    repository, sessionSecret: 'test-secret', sessionStore: new session.MemoryStore(), ...options
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('pages link content-hashed assets that are cached immutably only at the current hash', async (t) => {
  await withApp(t, { isProduction: true }, async (baseUrl) => {
    const html = await (await fetch(`${baseUrl}/login`)).text();
    const styleHash = contentHash(path.join(publicDir, 'css/style.css'));
    assert.match(html, new RegExp(`href="/css/style\\.css\\?v=${styleHash}"`));

    const versioned = await fetch(`${baseUrl}/css/style.css?v=${styleHash}`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.ok(versioned.headers.get('etag'));
    // Security headers still apply to static responses.
    assert.equal(versioned.headers.get('x-content-type-options'), 'nosniff');
    assert.match(versioned.headers.get('content-security-policy'), /default-src 'self'/);

    const appHash = contentHash(path.join(publicDir, 'js/app.js'));
    const script = await fetch(`${baseUrl}/js/app.js?v=${appHash}`);
    assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    for (const url of ['/css/style.css', '/css/style.css?v=0000000000', `/js/app.js?v=${styleHash}`]) {
      const response = await fetch(`${baseUrl}${url}`);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('cache-control'), 'no-cache', url);
      assert.equal(await conditionalGet(`${baseUrl}${url}`, response.headers.get('etag')), 304, url);
    }

    const favicon = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(favicon.headers.get('x-frame-options'), 'DENY');
  });
});

test('every script on the authenticated shell is versioned', async () => {
  const ejs = require('ejs');
  const assets = createAssetVersions(publicDir);
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/partials/app-scripts.ejs'), {
    localeJson: '{}', asset: assets.url
  });
  const sources = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(sources.length, 4);
  for (const source of sources) assert.match(source, /^\/js\/[\w-]+\.js\?v=[0-9a-f]{10}$/);
});

test('asset versions follow edits in development and stay fixed in production', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-public-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'js'));
  const file = path.join(directory, 'js/app.js');
  fs.writeFileSync(file, 'first');

  const development = createAssetVersions(directory, { watch: true });
  const production = createAssetVersions(directory, { watch: false });
  const first = development.url('/js/app.js');
  assert.match(first, /^\/js\/app\.js\?v=[0-9a-f]{10}$/);
  assert.equal(production.url('/js/app.js'), first);

  fs.writeFileSync(file, 'second');
  const later = Date.now() / 1000 + 10;
  fs.utimesSync(file, later, later);
  assert.notEqual(development.url('/js/app.js'), first);
  assert.equal(production.url('/js/app.js'), first);

  assert.equal(development.url('/js/missing.js'), '/js/missing.js');
  assert.equal(development.url('/favicon.ico'), '/favicon.ico');
  assert.equal(development.url('/js/../../etc/passwd'), '/js/../../etc/passwd');
});
