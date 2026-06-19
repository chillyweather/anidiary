const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCurrentSeason,
  getAdjacentSeasons,
  seasonKey,
  formatSeasonKey
} = require('../src/domain/seasons');
const { getCatalog, formatEpisodeCount } = require('../src/locales');

test('season boundaries use the explicit application timezone', () => {
  const boundary = new Date('2026-03-31T15:30:00.000Z');
  assert.deepEqual(getCurrentSeason(boundary, 'Asia/Tokyo'), { year: 2026, season: 'spring' });
  assert.deepEqual(getCurrentSeason(boundary, 'UTC'), { year: 2026, season: 'winter' });
  assert.deepEqual(getAdjacentSeasons(2026, 'winter'), {
    prevSeason: 'fall', prevYear: 2025, nextSeason: 'spring', nextYear: 2026
  });
  assert.deepEqual(getAdjacentSeasons(2026, 'fall'), {
    prevSeason: 'summer', prevYear: 2026, nextSeason: 'winter', nextYear: 2027
  });
  assert.equal(seasonKey(2026, 'SPRING'), 'spring_2026');
});

test('interface catalogs cover seasons, statuses, relationships, and episode plurals', () => {
  const en = getCatalog('en');
  const jp = getCatalog('jp');
  const ru = getCatalog('ru');

  assert.equal(jp, en);
  assert.equal(formatSeasonKey('spring_2026', en), 'Spring 2026');
  assert.equal(formatSeasonKey('spring_2026', ru), 'Весна 2026');
  assert.equal(ru.airingStatuses['Currently Airing'], 'Выходит');
  assert.equal(ru.relations.sequel, 'Сиквел');
  assert.equal(formatEpisodeCount(1, en), '1 episode');
  assert.equal(formatEpisodeCount(2, en), '2 episodes');
  assert.equal(formatEpisodeCount(1, ru), '1 серия');
  assert.equal(formatEpisodeCount(3, ru), '3 серии');
  assert.equal(formatEpisodeCount(12, ru), '12 серий');
});
