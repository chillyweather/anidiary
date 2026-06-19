const session = require('express-session');

class SQLiteSessionStore extends session.Store {
  constructor(db, { cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TEXT NOT NULL
      )
    `);
    this.getStatement = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `);
    this.destroyStatement = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.clearExpiredStatement = db.prepare('DELETE FROM sessions WHERE expire <= ?');
    this.cleanupTimer = setInterval(() => {
      try {
        this.clearExpiredStatement.run(new Date().toISOString());
      } catch (error) {
        if (this.listenerCount('error') > 0) this.emit('error', error);
      }
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (Date.parse(row.expire) <= Date.now()) {
        this.destroyStatement.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiry = value.cookie?.expires
        ? new Date(value.cookie.expires)
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
      this.setStatement.run(sid, JSON.stringify(value), expiry.toISOString());
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    this.set(sid, value, callback);
  }

  close() {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

module.exports = { SQLiteSessionStore };
