require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { db, initDb } = require('./src/db/db');
const { syncSeason, refreshCountdowns, getCurrentSeason } = require('./src/services/sync');

const authRoutes = require('./src/routes/auth');
const seasonRoutes = require('./src/routes/season');
const apiRoutes = require('./src/routes/api');

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (IS_PRODUCTION) {
    throw new Error('SESSION_SECRET is required in production');
  }
  const secretPath = path.join(__dirname, '.session-secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

const SESSION_SECRET = loadSessionSecret();

initDb();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

const publicDir = path.join(__dirname, 'public');
app.use('/css', express.static(path.join(publicDir, 'css'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
app.use('/js', express.static(path.join(publicDir, 'js'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.use(session({
  store: new SQLiteStore({
    client: db,
    expired: { clear: true, intervalMs: 900000 }
  }),
  name: 'anidiary.sid',
  secret: SESSION_SECRET,
  proxy: IS_PRODUCTION,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION
  }
}));

app.use((req, res, next) => {
  res.locals.user = req.session;
  next();
});

app.use('/', authRoutes);
app.use('/', seasonRoutes);
app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).render('error', { error: 'Page not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).render('error', { error: 'Something went wrong' });
});

const SIX_HOURS = 6 * 60* 60 * 1000;
const TWENTY_FOUR_HOURS = 24 *60 * 60 * 1000;

setInterval(() => {
  const { year, season } = getCurrentSeason();
  refreshCountdowns(year, season).catch(console.error);
}, SIX_HOURS);

setInterval(() => {
  const { year, season } = getCurrentSeason();
  syncSeason(year, season).catch(console.error);
}, TWENTY_FOUR_HOURS);

app.listen(PORT, () => {
  console.log(`anidiary running on http://localhost:${PORT}`);
});
