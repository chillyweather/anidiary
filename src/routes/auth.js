const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { csrfProtection, issueCsrfToken, newCsrfToken } = require('../middleware/csrf');

const BCRYPT_ROUNDS = 12;

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validatePassword(password) {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be at most 72 UTF-8 bytes';
  return null;
}

function setAuthenticatedSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.langPref = user.lang_pref || 'en';
      req.session.csrfToken = newCsrfToken();
      resolve();
    });
  });
}

function createAuthRouter(repository, { registrationOpen = true, authRateLimitMax = 10 } = {}) {
const router = express.Router();
const { createUser, getUserByUsername } = repository;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' }
});

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  issueCsrfToken(req, res);
  res.render('login', { error: null });
});

router.post('/login', csrfProtection, authLimiter, async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.render('login', { error: 'Enter both a username and a password.' });
    }

    const user = getUserByUsername(username);

    const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8.FQYB1YvQm0gK6lL0m7fQpF5u6bYu';
    const hashToCompare = user ? user.password_hash : DUMMY_HASH;

    const match = await bcrypt.compare(password, hashToCompare);

    if (!user || !match) {
      return res.render('login', { error: 'That username and password do not match an account.' });
    }

    await setAuthenticatedSession(req, user);
    return res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).render('login', { error: 'Logging in failed because of a server error. Try again in a minute.' });
  }
});

router.get('/register', (req, res) => {
  if (!registrationOpen) {
    return res.status(404).render('error', { error: 'New accounts cannot be created on this server.' });
  }
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  issueCsrfToken(req, res);
  res.render('register', { error: null });
});

router.post('/register', csrfProtection, authLimiter, async (req, res) => {
  try {
    if (!registrationOpen) {
      return res.status(403).render('error', { error: 'New accounts cannot be created on this server.' });
    }
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.render('register', { error: 'Enter both a username and a password.' });
    }

    if (username.length < 3 || username.length > 20) {
      return res.render('register', { error: 'Usernames are 3 to 20 characters long.' });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.render('register', { error: 'Usernames may use only letters, numbers and underscores.' });
    }

    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).render('register', { error: passwordError });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = createUser(username, passwordHash);

    if (result.error) {
      return res.render('register', { error: result.error });
    }

    await setAuthenticatedSession(req, { id: result.id, username, lang_pref: 'en' });
    return res.redirect('/');
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).render('register', { error: 'Creating the account failed because of a server error. Try again in a minute.' });
  }
});

router.post('/logout', csrfProtection, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('anidiary.sid');
    res.redirect('/login');
  });
});

return router;
}

module.exports = { createAuthRouter, validatePassword };
