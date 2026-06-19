const SEASONS = Object.freeze(['winter', 'spring', 'summer', 'fall']);
const APPLICATION_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Tokyo';

function isValidSeason(season) {
  return SEASONS.includes(String(season || '').toLowerCase());
}

function getCurrentSeason(date = new Date(), timeZone = APPLICATION_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric'
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year').value);
  const month = Number(parts.find((part) => part.type === 'month').value);
  return { year, season: SEASONS[Math.floor((month - 1) / 3)] };
}

function getAdjacentSeasons(year, season) {
  const index = SEASONS.indexOf(String(season).toLowerCase());
  if (!Number.isInteger(year) || index < 0) throw new Error('Invalid season');
  const previousIndex = (index + SEASONS.length - 1) % SEASONS.length;
  const nextIndex = (index + 1) % SEASONS.length;
  return {
    prevSeason: SEASONS[previousIndex],
    prevYear: index === 0 ? year - 1 : year,
    nextSeason: SEASONS[nextIndex],
    nextYear: index === SEASONS.length - 1 ? year + 1 : year
  };
}

function seasonKey(year, season) {
  if (!isValidSeason(season)) throw new Error(`Invalid season: ${season}`);
  return `${String(season).toLowerCase()}_${year}`;
}

function parseSeasonKey(value) {
  const [season, yearValue] = String(value || '').split('_');
  const year = Number(yearValue);
  return isValidSeason(season) && Number.isInteger(year) ? { season, year } : null;
}

function formatSeasonKey(value, catalog) {
  const parsed = parseSeasonKey(value);
  if (!parsed) return String(value || '');
  return `${catalog.seasons[parsed.season]} ${parsed.year}`;
}

function toAniListSeason(season) {
  if (!isValidSeason(season)) throw new Error(`Invalid season: ${season}`);
  return String(season).toUpperCase();
}

module.exports = {
  SEASONS,
  APPLICATION_TIME_ZONE,
  isValidSeason,
  getCurrentSeason,
  getAdjacentSeasons,
  seasonKey,
  parseSeasonKey,
  formatSeasonKey,
  toAniListSeason
};
