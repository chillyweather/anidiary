const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { getCurrentSeason, isValidSeason, getAdjacentSeasons, seasonKey, SEASONS } = require('../domain/seasons');
const { SYNC_POLICY, retryAt } = require('../domain/sync-policy');
const { getCatalog } = require('../locales');
const titleItem = require('../../public/js/title-item');

const SEED_REFRESH_SECONDS = 10;

function seasonOrdinal(year, season) {
  return year * SEASONS.length + SEASONS.indexOf(season);
}

function parseSeasonParams(params) {
  const year = parseInt(params.year, 10);
  const season = String(params.season || '').toLowerCase();
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !isValidSeason(season)) return null;
  return { year, season, key: seasonKey(year, season) };
}

function createSeasonRouter(repository, {
  syncService, getCurrent = getCurrentSeason, now = () => Date.now(), policy = SYNC_POLICY
} = {}) {
const router = express.Router();
const {
  getAnimeBySeason, getUserAnimeStatus, getTabAnimeForUser, getSyncState, getOtherUsersStatuses
} = repository;
const nowSeconds = () => Math.floor(now() / 1000);

// A season can be seeded from a page view when it is empty, was never synced
// successfully, and is no more than one season ahead.
function isSeedable({ year, season, key }) {
  if (!syncService) return false;
  const current = getCurrent();
  if (seasonOrdinal(year, season) > seasonOrdinal(current.year, current.season) + 1) return false;
  return getAnimeBySeason(key).length === 0;
}

// Page state for an empty season: null, 'pending', 'failed' (with retryAt) or 'empty'.
function resolveSeedState(target) {
  if (!isSeedable(target)) return { state: null };
  if (syncService.isSyncing(target.year, target.season)) return { state: 'pending' };

  const syncState = getSyncState(target.key);
  if (syncState?.last_success_at) return { state: 'empty' };
  const nextAttempt = retryAt(syncState, policy);
  if (nextAttempt !== null && nowSeconds() < nextAttempt) return { state: 'failed', retryAt: nextAttempt };

  // 'busy' (queue full) also shows the fetching state; a later refresh queues it.
  syncService.requestSeasonSync(target.year, target.season);
  return { state: 'pending' };
}

router.get('/', (req, res) => {
  const { year, season } = getCurrent();
  res.redirect(`/season/${year}/${season}`);
});

router.get('/season/:year/:season', requireLogin, (req, res) => {
  const target = parseSeasonParams(req.params);
  if (!target) return res.status(400).render('error', { error: 'That season address is not valid. Season addresses look like /season/2026/fall.' });
  const { year, season, key: seasonParam } = target;

  const animeList = getAnimeBySeason(seasonParam);
  const seed = animeList.length === 0 ? resolveSeedState(target) : { state: null };
  const userStatuses = getUserAnimeStatus(req.session.userId);
  const tabAnime = getTabAnimeForUser(req.session.userId);

  const statusMap = new Map();
  for (const row of userStatuses) {
    statusMap.set(row.mal_id, row.status);
  }

  // Other household members' states, shown read-only as initial chips.
  const partnerStatuses = new Map();
  for (const row of getOtherUsersStatuses(req.session.userId)) {
    if (!partnerStatuses.has(row.mal_id)) partnerStatuses.set(row.mal_id, []);
    partnerStatuses.get(row.mal_id).push({ username: row.username, status: row.status });
  }

  const adjacentSeasons = getAdjacentSeasons(year, season);
  const trackedAnimeOutsideSeason = tabAnime.filter((anime) => anime.season !== seasonParam);
  const ui = getCatalog(req.session.langPref);

  res.render('season', {
    animeList,
    trackedAnimeOutsideSeason,
    userStatuses: statusMap,
    partnerStatuses,
    nowSeconds: nowSeconds(),
    titleItem,
    year,
    season,
    adjacentSeasons,
    seedState: seed.state,
    retryInMinutes: seed.retryAt ? Math.max(1, Math.ceil((seed.retryAt - nowSeconds()) / 60)) : null,
    retryAtIso: seed.retryAt ? new Date(seed.retryAt * 1000).toISOString() : null,
    refresh: seed.state === 'pending'
      ? { seconds: SEED_REFRESH_SECONDS, url: `/season/${year}/${season}` }
      : null,
    ui,
    csrfToken: res.locals.csrfToken,
    localeJson: JSON.stringify(ui).replace(/</g, '\\u003c'),
    user: req.session
  });
});

// Manual retry for a failed first sync. It may bypass the backoff, but at most
// once per manualRetryGap per season (measured from the last attempt).
router.post('/season/:year/:season/retry', requireLogin, csrfProtection, (req, res) => {
  const target = parseSeasonParams(req.params);
  if (!target) return res.status(400).render('error', { error: 'That season address is not valid. Season addresses look like /season/2026/fall.' });

  if (isSeedable(target) && !syncService.isSyncing(target.year, target.season)) {
    const syncState = getSyncState(target.key);
    const recentlyAttempted = syncState && nowSeconds() - syncState.last_attempt_at < policy.manualRetryGap;
    if (!syncState?.last_success_at && !recentlyAttempted) {
      syncService.requestSeasonSync(target.year, target.season);
    }
  }
  return res.redirect(303, `/season/${target.year}/${target.season}`);
});

return router;
}

module.exports = { createSeasonRouter };
