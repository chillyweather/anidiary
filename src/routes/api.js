const express = require('express');
const router = express.Router();
const { setUserAnimeStatus, removeUserAnimeStatus, getAnimeByMalId, updateUserLangPref } = require('../db/db');

const VALID_STATUSES = ['following', 'in_jellyfin', 'watched'];

router.post('/mark', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { mal_id, status } = req.body;

    if (typeof mal_id !== 'number' && typeof mal_id !== 'string') {
      return res.status(400).json({ error: 'Invalid mal_id' });
    }

    const malId = parseInt(mal_id, 10);
    if (Number.isNaN(malId) || malId <= 0) {
      return res.status(400).json({ error: 'Invalid mal_id' });
    }

    const anime = getAnimeByMalId(malId);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    if (status === 'none' || !status) {
      removeUserAnimeStatus(req.session.userId, malId);
      return res.json({ ok: true, status: null });
    }

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    setUserAnimeStatus(req.session.userId, malId, status);
    return res.json({ ok: true, status });
  } catch (err) {
    console.error('Failed to update anime status:', err);
    return res.status(500).json({ error: 'Unable to update status right now' });
  }
});

router.get('/anime/:mal_id', (req, res) => {
  try {
    const malId = parseInt(req.params.mal_id, 10);
    if (Number.isNaN(malId) || malId <= 0) {
      return res.status(400).json({ error: 'Invalid mal_id' });
    }

    const anime = getAnimeByMalId(malId);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    return res.json(anime);
  } catch (err) {
    console.error('Failed to fetch anime details:', err);
    return res.status(500).json({ error: 'Unable to load anime right now' });
  }
});

router.post('/lang', (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const lang = String(req.body.lang || '').trim().toLowerCase();
    if (!['en', 'jp', 'ru'].includes(lang)) {
      return res.status(400).json({ error: 'Invalid language' });
    }

    updateUserLangPref(req.session.userId, lang);
    req.session.langPref = lang;

    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to update language:', err);
    return res.status(500).json({ error: 'Unable to update language right now' });
  }
});

module.exports = router;
