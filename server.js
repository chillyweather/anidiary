require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createApp } = require('./src/app');
const { createDatabase, DEFAULT_DB_PATH } = require('./src/db/db');
const { createSyncService } = require('./src/services/sync');
const { getCurrentSeason } = require('./src/domain/seasons');
const { createScheduler } = require('./src/scheduler');

const isProduction = process.env.NODE_ENV === 'production';

function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  if (value === 'true') throw new Error('TRUST_PROXY must be a hop count or comma-separated subnet list');
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction) throw new Error('SESSION_SECRET is required in production');

  const secretPath = path.join(__dirname, '.session-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

function main() {
  const repository = createDatabase(process.env.DB_PATH || DEFAULT_DB_PATH);
  repository.init();

  const syncService = createSyncService({ repository });
  const scheduler = createScheduler({ syncService, repository, getCurrentSeason });
  const app = createApp({
    repository,
    syncService,
    sessionSecret: loadSessionSecret(),
    isProduction,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    registrationOpen: process.env.REGISTRATION_OPEN === undefined
      ? undefined
      : process.env.REGISTRATION_OPEN === 'true'
  });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    scheduler.start();
    console.log(`anidiary running on http://localhost:${port}`);
  });

  // A sync that is still fetching is abandoned: its only write is one synchronous
  // transaction, so exiting here cannot leave a season half written, and nothing
  // touches the database after it is closed. PM2 kills the process 1.6s after
  // the signal, so the wait for open connections is kept shorter than that.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    const finish = () => {
      try {
        repository.close();
      } catch (error) {
        console.error('Database close failed:', error);
      }
      process.exit(0);
    };
    server.close(finish);
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    setTimeout(finish, 1000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { main, loadSessionSecret, parseTrustProxy };
