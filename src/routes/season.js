const express = require('express');
const router = express.Router();
const { getAnimeBySeason, getUserAnimeStatus } = require('../db/db');
const { requireLogin } = require('../middleware/auth');

function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  let season;
  if (month >= 1 && month <= 3) season = 'winter';
  else if (month >= 4 && month <= 6) season = 'spring';
  else if (month >= 7 && month <= 9) season = 'summer';
  else season = 'fall';
  return { year, season };
}

function isValidSeason(season) {
  return ['winter', 'spring', 'summer', 'fall'].includes(season);
}

function getAdjacentSeasons(year, season) {
  const seasons = ['winter', 'spring', 'summer', 'fall'];
  const currentIndex = seasons.indexOf(season);
  
  let prevSeason, prevYear, nextSeason, nextYear;
  
  if (currentIndex === 0) {
    prevSeason = 'fall';
    prevYear = year - 1;
  } else {
    prevSeason = seasons[currentIndex - 1];
    prevYear = year;
  }
  
  if (currentIndex === 3) {
    nextSeason = 'winter';
    nextYear = year + 1;
  } else {
    nextSeason = seasons[currentIndex + 1];
    nextYear = year;
  }
  
  return { prevSeason, prevYear, nextSeason, nextYear };
}

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

  const seasonParam = `${season}_${year}`;
  
  const animeList = getAnimeBySeason(seasonParam);
  const userStatuses = getUserAnimeStatus(req.session.userId);
  
  const statusMap = new Map();
  for (const row of userStatuses) {
    statusMap.set(row.mal_id, row.status);
  }
  
  const adjacentSeasons = getAdjacentSeasons(year, season);
  
  res.render('season', {
    animeList,
    userStatuses: statusMap,
    year,
    season,
    adjacentSeasons,
    user: req.session
  });
});

module.exports = router;
