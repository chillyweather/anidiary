const express = require('express');
const router = express.Router();
const {
  setUserAnimeStatus,
  removeUserAnimeStatus,
  getAnimeByMalId,
  updateAnimeRelated,
  getUserAnimeStatusByMalId,
  updateUserLangPref
} = require('../db/db');
const { fetchAnimeDetail } = require('../services/jikan');

const VALID_STATUSES = ['following', 'in_jellyfin', 'watched'];

function parseJsonArray(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatSeasonLabel(seasonValue) {
  if (!seasonValue) return '';

  const [season, year] = String(seasonValue).split('_');
  if (!season || !year) return String(seasonValue);

  return `${season.charAt(0).toUpperCase()}${season.slice(1)} ${year}`;
}

function serializeSeriesEntry(anime) {
  if (!anime) return null;

  return {
    mal_id: anime.mal_id,
    title_en: anime.title_en,
    title_jp: anime.title_jp,
    title_ru: anime.title_ru,
    season: anime.season,
    season_label: formatSeasonLabel(anime.season)
  };
}

function resolveSeriesTarget(related, relationName) {
  const normalizedRelation = String(relationName || '').toLowerCase();

  for (const relation of related) {
    if (String(relation?.relation || '').toLowerCase() !== normalizedRelation) continue;

    for (const entry of relation.entries || []) {
      if (String(entry?.type || '').toLowerCase() !== 'anime') continue;

      const anime = getAnimeByMalId(entry.mal_id);
      if (anime) {
        return serializeSeriesEntry(anime);
      }
    }
  }

  return null;
}

function normalizeAnimeForModal(anime, related, userStatus) {
  return {
    mal_id: anime.mal_id,
    title_en: anime.title_en,
    title_jp: anime.title_jp,
    title_ru: anime.title_ru,
    synopsis_en: anime.synopsis_en,
    synopsis_ru: anime.synopsis_ru,
    poster_url: anime.poster_url,
    score_mal: anime.score_mal,
    score_anilist: anime.score_anilist,
    score_shiki: anime.score_shiki,
    episodes_total: anime.episodes_total,
    season: anime.season,
    airing_status: anime.airing_status,
    airing_day: anime.airing_day,
    next_ep_num: anime.next_ep_num,
    next_ep_at: anime.next_ep_at,
    anilist_id: anime.anilist_id,
    genres: parseJsonArray(anime.genres),
    related,
    user_status: userStatus,
    series_nav: {
      previous: resolveSeriesTarget(related, 'Prequel'),
      next: resolveSeriesTarget(related, 'Sequel')
    }
  };
}

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

router.get('/anime/:mal_id', async (req, res) => {
  try {
    const malId = parseInt(req.params.mal_id, 10);
    if (Number.isNaN(malId) || malId <= 0) {
      return res.status(400).json({ error: 'Invalid mal_id' });
    }

    const anime = getAnimeByMalId(malId);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    let related = parseJsonArray(anime.related);

    if (anime.related == null || anime.related === '') {
      try {
        const detail = await fetchAnimeDetail(malId);
        const rawRelated = detail?.related || '[]';
        related = parseJsonArray(rawRelated);
        updateAnimeRelated(malId, rawRelated);
      } catch (detailErr) {
        console.error(`Failed to lazily fetch anime relations for ${malId}:`, detailErr);
      }
    }

    const userStatusRow = req.session?.userId
      ? getUserAnimeStatusByMalId(req.session.userId, malId)
      : null;

    return res.json(normalizeAnimeForModal(anime, related, userStatusRow?.status || null));
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
