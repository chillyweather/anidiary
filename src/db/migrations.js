const fs = require('fs');
const path = require('path');

const initialSchema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const migrations = [
  {
    version: 1,
    name: 'initial legacy schema',
    up(db) {
      db.exec(initialSchema);
    }
  },
  {
    version: 2,
    name: 'separate shared Jellyfin availability and remove dormant progress',
    validate(db) {
      const progressed = db.prepare('SELECT 1 FROM user_anime WHERE episodes_seen > 0 LIMIT 1').get();
      const history = db.prepare('SELECT 1 FROM watch_history LIMIT 1').get();
      if (progressed || history) {
        throw new Error('Migration blocked: episode progress or watch history must be resolved manually');
      }
    },
    up(db) {
      db.exec(`
        ALTER TABLE anime ADD COLUMN in_jellyfin INTEGER NOT NULL DEFAULT 0 CHECK(in_jellyfin IN (0, 1));
        UPDATE anime SET in_jellyfin = 1
          WHERE mal_id IN (SELECT mal_id FROM user_anime WHERE status = 'in_jellyfin');

        CREATE TABLE user_anime_next (
          user_id INTEGER NOT NULL,
          mal_id INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('following', 'watched')),
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (user_id, mal_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
        );
        INSERT INTO user_anime_next (user_id, mal_id, status, updated_at)
          SELECT user_id, mal_id, status, updated_at FROM user_anime
          WHERE status IN ('following', 'watched');
        DROP TABLE user_anime;
        ALTER TABLE user_anime_next RENAME TO user_anime;
        DROP TABLE watch_history;

        CREATE INDEX idx_user_anime_user ON user_anime(user_id);
        CREATE INDEX idx_user_anime_status ON user_anime(user_id, status);
      `);
    }
  }
];

const LATEST_SCHEMA_VERSION = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);

function migrate(db, orderedMigrations = migrations) {
  let currentVersion = db.pragma('user_version', { simple: true });
  const latestKnown = orderedMigrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  if (currentVersion > latestKnown) {
    throw new Error(`Database schema v${currentVersion} is newer than this code (knows up to v${latestKnown}). Refusing to start against a database migrated by a later release.`);
  }
  for (const migration of orderedMigrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== currentVersion + 1) {
      throw new Error(`Missing migration after schema version ${currentVersion}`);
    }
    if (migration.validate) migration.validate(db);
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    currentVersion = migration.version;
  }
  return currentVersion;
}

module.exports = { migrations, migrate, LATEST_SCHEMA_VERSION };
