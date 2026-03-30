const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../anidiary.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anime'").get();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  if (!tableCheck) {
    console.log('Database schema initialized');
  }
}

function getAnimeBySeason(season) {
  return db.prepare('SELECT * FROM anime WHERE season = ? ORDER BY score_mal DESC').all(season);
}

function getAnimeByMalId(malId) {
  return db.prepare('SELECT * FROM anime WHERE mal_id = ?').get(malId);
}

function upsertAnime(anime) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO anime (
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
  `);
  return stmt.run(anime);
}

function getUserAnimeStatus(userId) {
  return db.prepare('SELECT mal_id, status FROM user_anime WHERE user_id = ?').all(userId);
}

function getFollowedAnimeForUser(userId) {
  return db.prepare(`
    SELECT a.*
    FROM user_anime ua
    JOIN anime a ON a.mal_id = ua.mal_id
    WHERE ua.user_id = ?
    ORDER BY ua.updated_at DESC
  `).all(userId);
}

function setUserAnimeStatus(userId, malId, status) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO user_anime (user_id, mal_id, status, episodes_seen, updated_at)
    VALUES (?, ?, ?, 0, unixepoch())
  `);
  return stmt.run(userId, malId, status);
}

function removeUserAnimeStatus(userId, malId) {
  return db.prepare('DELETE FROM user_anime WHERE user_id = ? AND mal_id = ?').run(userId, malId);
}

function createUser(username, passwordHash) {
  const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
  try {
    const result = stmt.run(username, passwordHash);
    return { id: result.lastInsertRowid };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { error: 'Username already exists' };
    }
    throw err;
  }
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function updateUserLangPref(userId, lang) {
  return db.prepare('UPDATE users SET lang_pref = ? WHERE id = ?').run(lang, userId);
}

module.exports = {
  db,
  initDb,
  getAnimeBySeason,
  getAnimeByMalId,
  upsertAnime,
  getUserAnimeStatus,
  getFollowedAnimeForUser,
  setUserAnimeStatus,
  removeUserAnimeStatus,
  createUser,
  getUserByUsername,
  updateUserLangPref
};
