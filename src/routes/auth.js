const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { createUser, getUserByUsername } = require('../db/db');

const BCRYPT_ROUNDS = 12;

function normalizeUsername(username) {
  return String(username || '').trim();
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
      resolve();
    });
  });
}

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.render('login', { error: 'Username and password are required' });
    }

    const user = getUserByUsername(username);

    if (!user) {
      return res.render('login', { error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.render('login', { error: 'Invalid username or password' });
    }

    await setAuthenticatedSession(req, user);
    return res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).render('login', { error: 'Unable to login right now' });
  }
});

router.get('/register', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.render('register', { error: 'Username and password are required' });
    }

    if (username.length < 3 || username.length > 20) {
      return res.render('register', { error: 'Username must be 3-20 characters' });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.render('register', { error: 'Username can only contain letters, numbers, and underscores' });
    }

    if (password.length < 6) {
      return res.render('register', { error: 'Password must be at least 6 characters' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = createUser(username, passwordHash);

    if (result.error) {
      return res.render('register', { error: result.error });
    }

    await setAuthenticatedSession(req, { id: result.id, username, lang_pref: 'en' });
    return res.redirect('/');
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).render('register', { error: 'Unable to register right now' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('anidiary.sid');
    res.redirect('/login');
  });
});

module.exports = router;
