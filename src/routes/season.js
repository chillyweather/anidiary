const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { getCurrentSeason, isValidSeason, getAdjacentSeasons, seasonKey } = require('../domain/seasons');
const { getCatalog } = require('../locales');

function createSeasonRouter(repository) {
const router = express.Router();
const { getAnimeBySeason, getUserAnimeStatus, getFollowedAnimeForUser } = repository;

router.get('/', (req, res) => {
  const { year, season } = getCurrentSeason();
  res.redirect(`/season/${year}/${season}`);
});

router.get('/season/:year/:season', requireLogin, (req, res) => {
  const year = parseInt(req.params.year, 10);
  const season = String(req.params.season || '').toLowerCase();

  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !isValidSeason(season)) {
    return res.status(400).render('error', { error: 'Invalid season URL' });
  }

  const seasonParam = seasonKey(year, season);
  
  const animeList = getAnimeBySeason(seasonParam);
  const userStatuses = getUserAnimeStatus(req.session.userId);
  const followedAnime = getFollowedAnimeForUser(req.session.userId);
  
  const statusMap = new Map();
  for (const row of userStatuses) {
    statusMap.set(row.mal_id, row.status);
  }
  
  const adjacentSeasons = getAdjacentSeasons(year, season);
  const followedAnimeOutsideSeason = followedAnime.filter((anime) => anime.season !== seasonParam);
  const ui = getCatalog(req.session.langPref);
  
  res.render('season', {
    animeList,
    followedAnimeOutsideSeason,
    userStatuses: statusMap,
    year,
    season,
    adjacentSeasons,
    ui,
    csrfToken: res.locals.csrfToken,
    localeJson: JSON.stringify(ui).replace(/</g, '\\u003c'),
    user: req.session
  });
});

return router;
}

module.exports = { createSeasonRouter };
