const Database = require('better-sqlite3');
const path = require('path');
const { migrations: defaultMigrations, migrate } = require('./migrations');

const DEFAULT_DB_PATH = path.join(__dirname, '../../anidiary.db');

const HEALTH_ROLLBACK = new Error('healthz write probe rollback');

const ANIME_COLUMNS = [
  'mal_id', 'title_en', 'title_jp', 'title_ru', 'synopsis_en', 'synopsis_ru',
  'poster_url', 'score_mal', 'score_anilist', 'score_shiki', 'episodes_total',
  'season', 'airing_status', 'airing_day', 'next_ep_num', 'next_ep_at',
  'anilist_id', 'genres', 'related', 'format', 'popularity'
];

// Every provider-owned column keeps its stored value when the incoming value is
// null ("the provider did not tell us"). Two exceptions are controlled per row:
// - next_ep_authoritative: AniList answered for this title, so a null countdown
//   means "no next episode" and must overwrite the stored one;
// - season_authoritative: the catalogue placed the title in this season.
// in_jellyfin is never written here.
const PRESERVED_COLUMNS = ANIME_COLUMNS.filter((column) => ![
  'mal_id', 'season', 'next_ep_num', 'next_ep_at'
].includes(column));

const UPSERT_ANIME_SQL = `
  INSERT INTO anime (${ANIME_COLUMNS.join(', ')}, updated_at)
  VALUES (${ANIME_COLUMNS.map((column) => `@${column}`).join(', ')}, unixepoch())
  ON CONFLICT(mal_id) DO UPDATE SET
    ${PRESERVED_COLUMNS.map((column) => `${column} = COALESCE(excluded.${column}, anime.${column})`).join(',\n    ')},
    season = CASE WHEN @season_authoritative THEN excluded.season ELSE anime.season END,
    next_ep_num = CASE WHEN @next_ep_authoritative THEN excluded.next_ep_num
      ELSE COALESCE(excluded.next_ep_num, anime.next_ep_num) END,
    next_ep_at = CASE WHEN @next_ep_authoritative THEN excluded.next_ep_at
      ELSE COALESCE(excluded.next_ep_at, anime.next_ep_at) END,
    updated_at = unixepoch()
`;

const COUNTDOWN_STATUSES = "('Currently Airing', 'Not yet aired')";

const SQL = {
  animeBySeason: `
    SELECT * FROM anime WHERE season = ?
    ORDER BY popularity IS NULL, popularity DESC, score_mal IS NULL, score_mal DESC, mal_id
  `,
  animeByMalId: 'SELECT * FROM anime WHERE mal_id = ?',
  upsertAnime: UPSERT_ANIME_SQL,
  updateCountdown: `
    UPDATE anime SET
      next_ep_num = @next_ep_num, next_ep_at = @next_ep_at,
      airing_status = COALESCE(@airing_status, airing_status),
      episodes_total = COALESCE(@episodes_total, episodes_total),
      updated_at = unixepoch()
    WHERE mal_id = @mal_id
  `,
  countdownRefreshIds: `
    SELECT mal_id FROM anime
    WHERE airing_status = 'Currently Airing'
       OR (airing_status = 'Not yet aired' AND next_ep_at IS NOT NULL AND next_ep_at <= @horizon)
    UNION
    SELECT a.mal_id FROM anime a
    WHERE a.mal_id IN (SELECT mal_id FROM user_anime WHERE status IN ('following', 'watching'))
      AND (a.airing_status IS NULL OR a.airing_status NOT IN ('Finished Airing', 'Cancelled'))
    ORDER BY mal_id
  `,
  earliestCountdown: `
    SELECT MIN(next_ep_at) AS next_ep_at FROM anime
    WHERE airing_status IN ${COUNTDOWN_STATUSES} AND next_ep_at IS NOT NULL
  `,
  seasonHasAiring: "SELECT 1 FROM anime WHERE season = ? AND airing_status = 'Currently Airing' LIMIT 1",
  syncState: 'SELECT * FROM sync_state WHERE job = ?',
  recordSyncResult: `
    INSERT INTO sync_state (job, last_attempt_at, last_success_at, last_status, consecutive_failures, last_error)
    VALUES (
      @job, @at, CASE WHEN @status = 'complete' THEN @at END, @status,
      CASE WHEN @status = 'complete' THEN 0 ELSE 1 END, @error
    )
    ON CONFLICT(job) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = COALESCE(excluded.last_success_at, sync_state.last_success_at),
      last_status = excluded.last_status,
      consecutive_failures = CASE WHEN excluded.last_status = 'complete' THEN 0
        ELSE sync_state.consecutive_failures + 1 END,
      last_error = excluded.last_error
  `,
  userAnimeStatus: 'SELECT mal_id, status FROM user_anime WHERE user_id = ?',
  userAnimeStatusByMalId: 'SELECT status FROM user_anime WHERE user_id = ? AND mal_id = ?',
  // Personal states of the other household members (read-only for the viewer).
  otherUsersStatuses: `
    SELECT ua.mal_id, u.username, ua.status FROM user_anime ua JOIN users u ON u.id = ua.user_id
    WHERE ua.user_id != ? ORDER BY u.username, ua.mal_id
  `,
  otherUsersStatusesByMalId: `
    SELECT u.username, ua.status FROM user_anime ua JOIN users u ON u.id = ua.user_id
    WHERE ua.user_id != ? AND ua.mal_id = ? ORDER BY u.username
  `,
  tabAnimeForUser: `
    SELECT a.* FROM user_anime ua JOIN anime a ON a.mal_id = ua.mal_id
    WHERE ua.user_id = ? AND ua.status IN ('following', 'watching') ORDER BY ua.updated_at DESC
  `,
  setUserAnimeStatus: `
    INSERT INTO user_anime (user_id, mal_id, status, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id, mal_id) DO UPDATE SET status = excluded.status, updated_at = unixepoch()
  `,
  setJellyfin: 'UPDATE anime SET in_jellyfin = ?, updated_at = unixepoch() WHERE mal_id = ?',
  removeUserAnimeStatus: 'DELETE FROM user_anime WHERE user_id = ? AND mal_id = ?',
  createUser: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
  userByUsername: 'SELECT * FROM users WHERE username = ?',
  updateUserLangPref: 'UPDATE users SET lang_pref = ? WHERE id = ?'
};

function createDatabase(dbPath, { migrations = defaultMigrations } = {}) {
  if (!dbPath) throw new Error('A database path is required');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const expectedSchemaVersion = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);

  // Statements are compiled once and reused. Compilation is deferred to first
  // use because the tables only exist after init() has migrated the database.
  const compiled = new Map();
  function statement(name) {
    let prepared = compiled.get(name);
    if (!prepared) {
      prepared = db.prepare(SQL[name]);
      compiled.set(name, prepared);
    }
    return prepared;
  }

  function checkHealth() {
    const schemaVersion = db.pragma('user_version', { simple: true });
    let writable = false;
    try {
      db.transaction(() => {
        db.prepare('CREATE TABLE IF NOT EXISTS _healthz_probe (touched_at INTEGER)').run();
        db.prepare('INSERT INTO _healthz_probe (touched_at) VALUES (unixepoch())').run();
        throw HEALTH_ROLLBACK;
      })();
    } catch (err) {
      // The probe intentionally rolls back; any other error means the database
      // could not be written (read-only file/directory, lock, corruption).
      writable = err === HEALTH_ROLLBACK;
    }
    return { schemaVersion, expectedSchemaVersion, writable };
  }

  function init() {
    const startingVersion = db.pragma('user_version', { simple: true });
    const version = migrate(db, migrations);
    if (version !== startingVersion) console.log(`Database migrated from version ${startingVersion} to ${version} at ${dbPath}`);
  }

  function upsertAnime(anime) {
    const params = { season_authoritative: 1, next_ep_authoritative: 0 };
    for (const column of ANIME_COLUMNS) params[column] = anime[column] ?? null;
    if ('season_authoritative' in anime) params.season_authoritative = anime.season_authoritative ? 1 : 0;
    if ('next_ep_authoritative' in anime) params.next_ep_authoritative = anime.next_ep_authoritative ? 1 : 0;
    return statement('upsertAnime').run(params);
  }

  return {
    db,
    path: dbPath,
    init,
    checkHealth,
    close: () => db.close(),
    transaction: (operation) => db.transaction(operation)(),
    getAnimeBySeason: (season) => statement('animeBySeason').all(season),
    getAnimeByMalId: (malId) => statement('animeByMalId').get(malId),
    upsertAnime,
    updateCountdown: (malId, { next_ep_num = null, next_ep_at = null, airing_status = null, episodes_total = null }) => (
      statement('updateCountdown').run({ mal_id: malId, next_ep_num, next_ep_at, airing_status, episodes_total })
    ),
    getCountdownRefreshIds: (horizon) => statement('countdownRefreshIds').all({ horizon }).map((row) => row.mal_id),
    getEarliestCountdown: () => statement('earliestCountdown').get().next_ep_at,
    seasonHasAiring: (season) => Boolean(statement('seasonHasAiring').get(season)),
    getSyncState: (job) => statement('syncState').get(job),
    recordSyncResult: (job, { at, status, error = null }) => (
      statement('recordSyncResult').run({ job, at, status, error })
    ),
    getUserAnimeStatus: (userId) => statement('userAnimeStatus').all(userId),
    getUserAnimeStatusByMalId: (userId, malId) => statement('userAnimeStatusByMalId').get(userId, malId),
    getTabAnimeForUser: (userId) => statement('tabAnimeForUser').all(userId),
    getOtherUsersStatuses: (userId) => statement('otherUsersStatuses').all(userId),
    getOtherUsersStatusesByMalId: (userId, malId) => statement('otherUsersStatusesByMalId').all(userId, malId),
    setUserAnimeStatus: (userId, malId, status) => statement('setUserAnimeStatus').run(userId, malId, status),
    setAnimeJellyfinAvailability: (malId, available) => statement('setJellyfin').run(available ? 1 : 0, malId),
    removeUserAnimeStatus: (userId, malId) => statement('removeUserAnimeStatus').run(userId, malId),
    createUser(username, passwordHash) {
      try {
        const result = statement('createUser').run(username, passwordHash);
        return { id: result.lastInsertRowid };
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: 'That username is taken. Choose another one.' };
        throw err;
      }
    },
    getUserByUsername: (username) => statement('userByUsername').get(username),
    updateUserLangPref: (userId, lang) => statement('updateUserLangPref').run(lang, userId)
  };
}

module.exports = { createDatabase, DEFAULT_DB_PATH };
