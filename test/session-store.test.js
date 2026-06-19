const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { SQLiteSessionStore } = require('../src/session-store');

function setSession(store, sid, value) {
  return new Promise((resolve, reject) => {
    store.set(sid, value, (error) => error ? reject(error) : resolve());
  });
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

test('periodic cleanup removes expired sessions without reading them', async (t) => {
  const db = new Database(':memory:');
  const store = new SQLiteSessionStore(db, { cleanupIntervalMs: 10 });
  t.after(() => {
    store.close?.();
    db.close();
  });

  await setSession(store, 'expired', {
    cookie: { expires: new Date(Date.now() - 60_000) }
  });
  await setSession(store, 'active', {
    cookie: { expires: new Date(Date.now() + 60_000) }
  });

  assert.equal(await waitFor(() => db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count === 1), true);
  assert.deepEqual(db.prepare('SELECT sid FROM sessions ORDER BY sid').all(), [{ sid: 'active' }]);
});

test('closing the session store stops periodic cleanup', async (t) => {
  const db = new Database(':memory:');
  const store = new SQLiteSessionStore(db, { cleanupIntervalMs: 10 });
  t.after(() => db.close());
  store.close();

  await setSession(store, 'expired', {
    cookie: { expires: new Date(Date.now() - 60_000) }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(db.prepare('SELECT sid FROM sessions').all(), [{ sid: 'expired' }]);
});

test('session cleanup does not keep the process alive', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const { SQLiteSessionStore } = require('./src/session-store');
    new SQLiteSessionStore(new Database(':memory:'), { cleanupIntervalMs: 60_000 });
  `], {
    cwd: require('node:path').join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 500
  });

  assert.equal(result.status, 0, result.error?.message || result.stderr);
});
