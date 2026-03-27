CREATE TABLE IF NOT EXISTS anime (
  mal_id         INTEGER PRIMARY KEY,
  title_en       TEXT,
  title_jp       TEXT,
  title_ru       TEXT,
  synopsis_en    TEXT,
  synopsis_ru    TEXT,
  poster_url     TEXT,
  score_mal      REAL,
  score_anilist  INTEGER,
  score_shiki    REAL,
  episodes_total INTEGER,
  season         TEXT NOT NULL,
  airing_status  TEXT,
  airing_day     TEXT,
  next_ep_num    INTEGER,
  next_ep_at     INTEGER,
  anilist_id     INTEGER,
  genres         TEXT,
  related        TEXT,
  updated_at     INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  lang_pref      TEXT DEFAULT 'en',
  created_at     INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_anime (
  user_id        INTEGER NOT NULL,
  mal_id         INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK(status IN ('following', 'in_jellyfin', 'watched')),
  episodes_seen  INTEGER DEFAULT 0,
  updated_at     INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, mal_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS watch_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  mal_id         INTEGER NOT NULL,
  episode        INTEGER,
  watched_at     INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_anime_season ON anime(season);
CREATE INDEX IF NOT EXISTS idx_user_anime_user ON user_anime(user_id);
CREATE INDEX IF NOT EXISTS idx_user_anime_status ON user_anime(user_id, status);