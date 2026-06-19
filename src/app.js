const express = require('express');
const session = require('express-session');
const path = require('path');
const { SQLiteSessionStore } = require('./session-store');

const { createAuthRouter } = require('./routes/auth');
const { createSeasonRouter } = require('./routes/season');
const { createApiRouter } = require('./routes/api');
const { ensureCsrfToken } = require('./middleware/csrf');

function createApp({
  repository, sessionSecret, isProduction = false, trustProxy = false, providers,
  sessionStore, registrationOpen, authRateLimitMax
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
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://cdn.myanimelist.net https://s4.anilist.co https://shikimori.one",
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

  const publicDir = path.join(__dirname, '../public');
  const noCache = (res) => res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  app.use('/css', express.static(path.join(publicDir, 'css'), { setHeaders: noCache }));
  app.use('/js', express.static(path.join(publicDir, 'js'), { setHeaders: noCache }));
  app.use(express.static(publicDir));

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

  app.use(ensureCsrfToken);

  app.use((req, res, next) => {
    res.locals.user = req.session;
    next();
  });

  app.use('/', createAuthRouter(repository, {
    registrationOpen: registrationOpen ?? !isProduction,
    authRateLimitMax
  }));
  app.use('/', createSeasonRouter(repository));
  app.use('/api', createApiRouter(repository, providers));

  app.use((req, res) => res.status(404).render('error', { error: 'Page not found' }));
  app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).render('error', { error: 'Something went wrong' });
  });

  return app;
}

module.exports = { createApp };
