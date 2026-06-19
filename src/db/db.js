const Database = require('better-sqlite3');
const path = require('path');
const { migrations: defaultMigrations, migrate } = require('./migrations');

const DEFAULT_DB_PATH = path.join(__dirname, '../../anidiary.db');

function createDatabase(dbPath, { migrations = defaultMigrations } = {}) {
  if (!dbPath) throw new Error('A database path is required');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  function init() {
    const startingVersion = db.pragma('user_version', { simple: true });
    const version = migrate(db, migrations);
    if (version !== startingVersion) console.log(`Database migrated from version ${startingVersion} to ${version} at ${dbPath}`);
  }

  function getAnimeBySeason(season) {
    return db.prepare('SELECT * FROM anime WHERE season = ? ORDER BY score_mal DESC').all(season);
  }

  function getAnimeByMalId(malId) {
    return db.prepare('SELECT * FROM anime WHERE mal_id = ?').get(malId);
  }

  function updateAnimeRelated(malId, related) {
    return db.prepare('UPDATE anime SET related = ?, updated_at = unixepoch() WHERE mal_id = ?').run(related, malId);
  }

  function upsertAnime(anime) {
    return db.prepare(`
      INSERT INTO anime (
        mal_id, title_en, title_jp, title_ru, synopsis_en, synopsis_ru,
        poster_url, score_mal, score_anilist, score_shiki, episodes_total,
        season, airing_status, airing_day, next_ep_num, next_ep_at,
        anilist_id, genres, related, updated_at
      ) VALUES (
        @mal_id, @title_en, @title_jp, @title_ru, @synopsis_en, @synopsis_ru,
        @poster_url, @score_mal, @score_anilist, @score_shiki, @episodes_total,
        @season, @airing_status, @airing_day, @next_ep_num, @next_ep_at,
        @anilist_id, @genres, @related, unixepoch()
      )
      ON CONFLICT(mal_id) DO UPDATE SET
        title_en = excluded.title_en, title_jp = excluded.title_jp,
        title_ru = excluded.title_ru, synopsis_en = excluded.synopsis_en,
        synopsis_ru = excluded.synopsis_ru, poster_url = excluded.poster_url,
        score_mal = excluded.score_mal, score_anilist = excluded.score_anilist,
        score_shiki = excluded.score_shiki, episodes_total = excluded.episodes_total,
        season = excluded.season, airing_status = excluded.airing_status,
        airing_day = excluded.airing_day, next_ep_num = excluded.next_ep_num,
        next_ep_at = excluded.next_ep_at, anilist_id = excluded.anilist_id,
        genres = excluded.genres, related = excluded.related, updated_at = unixepoch()
    `).run(anime);
  }

  return {
    db,
    path: dbPath,
    init,
    close: () => db.close(),
    transaction: (operation) => db.transaction(operation)(),
    getAnimeBySeason,
    getAnimeByMalId,
    updateAnimeRelated,
    upsertAnime,
    getUserAnimeStatus: (userId) => db.prepare('SELECT mal_id, status FROM user_anime WHERE user_id = ?').all(userId),
    getUserAnimeStatusByMalId: (userId, malId) => db.prepare('SELECT status FROM user_anime WHERE user_id = ? AND mal_id = ?').get(userId, malId),
    getFollowedAnimeForUser: (userId) => db.prepare(`
      SELECT a.* FROM user_anime ua JOIN anime a ON a.mal_id = ua.mal_id
      WHERE ua.user_id = ? ORDER BY ua.updated_at DESC
    `).all(userId),
    setUserAnimeStatus: (userId, malId, status) => db.prepare(`
      INSERT INTO user_anime (user_id, mal_id, status, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(user_id, mal_id) DO UPDATE SET status = excluded.status, updated_at = unixepoch()
    `).run(userId, malId, status),
    setAnimeJellyfinAvailability: (malId, available) => db.prepare(`
      UPDATE anime SET in_jellyfin = ?, updated_at = unixepoch() WHERE mal_id = ?
    `).run(available ? 1 : 0, malId),
    removeUserAnimeStatus: (userId, malId) => db.prepare('DELETE FROM user_anime WHERE user_id = ? AND mal_id = ?').run(userId, malId),
    createUser(username, passwordHash) {
      try {
        const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
        return { id: result.lastInsertRowid };
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: 'Username already exists' };
        throw err;
      }
    },
    getUserByUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
    updateUserLangPref: (userId, lang) => db.prepare('UPDATE users SET lang_pref = ? WHERE id = ?').run(lang, userId)
  };
}

module.exports = { createDatabase, DEFAULT_DB_PATH };
