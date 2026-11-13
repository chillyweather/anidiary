const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createDatabase } = require('../src/db/db');
const { migrations } = require('../src/db/migrations');

function temporaryPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anidiary-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'test.db');
}

function createLegacyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO anime (mal_id, title_en, season) VALUES (1, 'One', 'spring_2026')").run();
  db.prepare("INSERT INTO anime (mal_id, title_en, season) VALUES (2, 'Two', 'spring_2026')").run();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'user', 'hash')").run();
  return db;
}

test('fresh database reaches latest version with foreign keys enabled', (t) => {
  const repository = createDatabase(temporaryPath(t));
  repository.init();
  assert.equal(repository.db.pragma('user_version', { simple: true }), 4);
  assert.equal(repository.db.pragma('foreign_keys', { simple: true }), 1);
  const columns = repository.db.prepare('PRAGMA table_info(user_anime)').all().map((column) => column.name);
  assert.deepEqual(columns, ['user_id', 'mal_id', 'status', 'updated_at']);
  assert.equal(repository.db.prepare("SELECT name FROM sqlite_master WHERE name = 'watch_history'").get(), undefined);
  assert.ok(repository.db.prepare("SELECT name FROM pragma_table_info('anime') WHERE name = 'in_jellyfin'").get());
  repository.close();
});

test('legacy migration converts shared Jellyfin state and retains personal tracking', (t) => {
  const dbPath = temporaryPath(t);
  const legacy = createLegacyDatabase(dbPath);
  legacy.pragma('user_version = 1');
  legacy.prepare("INSERT INTO user_anime (user_id, mal_id, status) VALUES (1, 1, 'in_jellyfin')").run();
  legacy.prepare("INSERT INTO user_anime (user_id, mal_id, status) VALUES (1, 2, 'following')").run();
  legacy.close();

  const repository = createDatabase(dbPath);
  repository.init();
  assert.equal(repository.getAnimeByMalId(1).in_jellyfin, 1);
  assert.equal(repository.getUserAnimeStatusByMalId(1, 1), undefined);
  assert.equal(repository.getUserAnimeStatusByMalId(1, 2).status, 'following');
  repository.close();
});

test('migration stops without discarding episode progress', (t) => {
  const dbPath = temporaryPath(t);
  const legacy = createLegacyDatabase(dbPath);
  legacy.prepare("INSERT INTO user_anime (user_id, mal_id, status, episodes_seen) VALUES (1, 1, 'following', 3)").run();
  legacy.close();

  const repository = createDatabase(dbPath);
  assert.throws(() => repository.init(), /Migration blocked/);
  assert.equal(repository.db.prepare('SELECT episodes_seen FROM user_anime').get().episodes_seen, 3);
  assert.ok(repository.db.prepare("SELECT name FROM sqlite_master WHERE name = 'watch_history'").get());
  repository.close();
});

test('failed migration does not advance its schema version', (t) => {
  const failingMigrations = [...migrations, {
    version: 5,
    name: 'injected failure',
    up(db) {
      db.exec('CREATE TABLE should_rollback (id INTEGER)');
      throw new Error('injected migration failure');
    }
  }];
  const repository = createDatabase(temporaryPath(t), { migrations: failingMigrations });
  assert.throws(() => repository.init(), /injected migration failure/);
  assert.equal(repository.db.pragma('user_version', { simple: true }), 4);
  assert.equal(repository.db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'").get(), undefined);
  repository.close();
});

test('refuses to start when the database schema is newer than the code knows', (t) => {
  const dbPath = temporaryPath(t);
  const ahead = createDatabase(dbPath);
  ahead.init();
  ahead.db.pragma('user_version = 99');
  ahead.close();

  const repository = createDatabase(dbPath);
  assert.throws(() => repository.init(), /newer than this code/);
  assert.equal(repository.db.pragma('user_version', { simple: true }), 99);
  repository.close();
});

test('checkHealth reports schema version and database writability', (t) => {
  const repository = createDatabase(temporaryPath(t));
  repository.init();
  assert.deepEqual(repository.checkHealth(), {
    schemaVersion: 4, expectedSchemaVersion: 4, writable: true
  });
  assert.equal(repository.db.prepare("SELECT name FROM sqlite_master WHERE name = '_healthz_probe'").get(), undefined);
  repository.close();
});

test('personal status conflict updates preserve independent Jellyfin availability', (t) => {
  const repository = createDatabase(temporaryPath(t));
  repository.init();
  repository.upsertAnime({
    mal_id: 1, title_en: 'One', title_jp: null, title_ru: null, synopsis_en: null,
    synopsis_ru: null, poster_url: null, score_mal: null, score_anilist: null,
    score_shiki: null, episodes_total: null, season: 'spring_2026', airing_status: null,
    airing_day: null, next_ep_num: null, next_ep_at: null, anilist_id: null,
    genres: '[]', related: null
  });
  const user = repository.createUser('user', 'hash');
  repository.setAnimeJellyfinAvailability(1, true);
  repository.setUserAnimeStatus(user.id, 1, 'following');
  repository.setUserAnimeStatus(user.id, 1, 'watching');
  assert.equal(repository.getUserAnimeStatusByMalId(user.id, 1).status, 'watching');
  assert.deepEqual(repository.getTabAnimeForUser(user.id).map((anime) => anime.mal_id), [1]);
  repository.setUserAnimeStatus(user.id, 1, 'watched');
  assert.equal(repository.getUserAnimeStatusByMalId(user.id, 1).status, 'watched');
  assert.deepEqual(repository.getTabAnimeForUser(user.id), []);
  assert.equal(repository.getAnimeByMalId(1).in_jellyfin, 1);
  repository.close();
});

test('v4 upgrades a populated v3 database without touching existing data', (t) => {
  const dbPath = temporaryPath(t);
  const v3 = createDatabase(dbPath, { migrations: migrations.filter((migration) => migration.version <= 3) });
  v3.init();
  v3.db.prepare(`INSERT INTO anime (mal_id, title_en, season, score_mal, next_ep_at, airing_status, related, in_jellyfin)
    VALUES (1, 'One', 'fall_2026', 8.5, 2000, 'Currently Airing', '[]', 1)`).run();
  v3.db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'user', 'hash')").run();
  v3.db.prepare("INSERT INTO user_anime (user_id, mal_id, status) VALUES (1, 1, 'watching')").run();
  assert.equal(v3.db.pragma('user_version', { simple: true }), 3);
  v3.close();

  const repository = createDatabase(dbPath);
  repository.init();
  assert.equal(repository.db.pragma('user_version', { simple: true }), 4);
  const stored = repository.getAnimeByMalId(1);
  assert.equal(stored.title_en, 'One');
  assert.equal(stored.score_mal, 8.5);
  assert.equal(stored.in_jellyfin, 1);
  assert.equal(stored.related, '[]');
  assert.equal(stored.format, null);
  assert.equal(stored.popularity, null);
  assert.equal(repository.getUserAnimeStatusByMalId(1, 1).status, 'watching');
  assert.equal(repository.getSyncState('fall_2026'), undefined);
  assert.ok(repository.db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_anime_airing'").get());
  assert.throws(
    () => repository.db.prepare("UPDATE anime SET format = 'TV' WHERE mal_id = 1").run(),
    /CHECK constraint failed/
  );
  repository.close();
});

test('sync state records attempts, successes and consecutive failures', (t) => {
  const repository = createDatabase(temporaryPath(t));
  repository.init();
  repository.recordSyncResult('fall_2026', { at: 100, status: 'partial', error: 'jikan: offline' });
  assert.deepEqual(repository.getSyncState('fall_2026'), {
    job: 'fall_2026', last_attempt_at: 100, last_success_at: null, last_status: 'partial',
    consecutive_failures: 1, last_error: 'jikan: offline'
  });
  repository.recordSyncResult('fall_2026', { at: 200, status: 'failed', error: 'offline' });
  assert.equal(repository.getSyncState('fall_2026').consecutive_failures, 2);
  repository.recordSyncResult('fall_2026', { at: 300, status: 'complete' });
  assert.deepEqual(repository.getSyncState('fall_2026'), {
    job: 'fall_2026', last_attempt_at: 300, last_success_at: 300, last_status: 'complete',
    consecutive_failures: 0, last_error: null
  });
  repository.recordSyncResult('fall_2026', { at: 400, status: 'failed', error: 'offline' });
  const failed = repository.getSyncState('fall_2026');
  assert.equal(failed.last_success_at, 300);
  assert.equal(failed.last_attempt_at, 400);
  assert.equal(failed.consecutive_failures, 1);
  repository.close();
});

test('season order defaults to popularity with unknown popularity last', (t) => {
  const repository = createDatabase(temporaryPath(t));
  repository.init();
  const base = { season: 'winter_2027', genres: '[]' };
  repository.upsertAnime({ ...base, mal_id: 1, title_en: 'Unknown', popularity: null, score_mal: 9 });
  repository.upsertAnime({ ...base, mal_id: 2, title_en: 'Niche', popularity: 100 });
  repository.upsertAnime({ ...base, mal_id: 3, title_en: 'Hyped', popularity: 5000 });
  assert.deepEqual(repository.getAnimeBySeason('winter_2027').map((anime) => anime.mal_id), [3, 2, 1]);
  repository.close();
});
