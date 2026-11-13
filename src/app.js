const express = require('express');
const session = require('express-session');
const path = require('path');
const { SQLiteSessionStore } = require('./session-store');

const { createAuthRouter } = require('./routes/auth');
const { createSeasonRouter } = require('./routes/season');
const { createApiRouter } = require('./routes/api');
const { exposeCsrfToken } = require('./middleware/csrf');
const { createAssetVersions } = require('./assets');

function createApp({
  repository, sessionSecret, isProduction = false, trustProxy = false, syncService,
  sessionStore, registrationOpen, authRateLimitMax, now
}) {
  if (!repository) throw new Error('A repository is required');
  if (!sessionSecret) throw new Error('A session secret is required');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'",
        "form-action 'self'", "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data: https://cdn.myanimelist.net https://s4.anilist.co https://shikimori.io",
        "connect-src 'self'"
      ].join('; '),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  // Deploy smoke check: verifies the running code can actually write the
  // database and that its schema version matches what this code expects.
  // A stale process against a newer-migrated database fails here.
  app.get('/healthz', (req, res) => {
    try {
      const health = repository.checkHealth();
      const healthy = health.writable && health.schemaVersion === health.expectedSchemaVersion;
      return res.status(healthy ? 200 : 503).json({
        ok: healthy,
        schemaVersion: health.schemaVersion,
        expectedSchemaVersion: health.expectedSchemaVersion,
        writable: health.writable
      });
    } catch (err) {
      console.error('Health check failed:', err);
      return res.status(503).json({ ok: false });
    }
  });

  // /css, /js and /fonts are linked with a content hash (`asset()` in views) and cached
  // for a year when the hash matches; anything else revalidates with the ETag.
  const publicDir = path.join(__dirname, '../public');
  const assets = createAssetVersions(publicDir, { watch: !isProduction });
  app.locals.asset = assets.url;
  const versionedStatic = { setHeaders: assets.setCacheHeaders };
  app.use('/css', express.static(path.join(publicDir, 'css'), versionedStatic));
  app.use('/js', express.static(path.join(publicDir, 'js'), versionedStatic));
  app.use('/fonts', express.static(path.join(publicDir, 'fonts'), versionedStatic));
  app.use(express.static(publicDir, { maxAge: '1d' }));

  app.use(session({
    store: sessionStore || new SQLiteSessionStore(repository.db),
    name: 'anidiary.sid',
    secret: sessionSecret,
    proxy: isProduction,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction
    }
  }));

  // Only pages with a form (GET /login, /register) start an anonymous session;
  // see issueCsrfToken. Everything else just exposes an existing token.
  app.use(exposeCsrfToken);

  app.use((req, res, next) => {
    res.locals.user = req.session;
    next();
  });

  app.use('/', createAuthRouter(repository, {
    registrationOpen: registrationOpen ?? !isProduction,
    authRateLimitMax
  }));
  app.use('/', createSeasonRouter(repository, { syncService, now }));
  app.use('/api', createApiRouter(repository));

  app.use((req, res) => res.status(404).render('error', { error: 'This page does not exist.' }));
  app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).render('error', { error: 'The server hit an error while loading this page. Try again in a minute.' });
  });

  return app;
}

module.exports = { createApp };
