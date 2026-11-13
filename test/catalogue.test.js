const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matches, comparator, groupWeek, formatCountdown, searchText, normalizeText
} = require('../public/js/catalogue');

const item = (overrides = {}) => ({
  status: '', format: 'tv', search: 'title', inSeason: true, ...overrides
});

test('search matches English, Japanese and Russian titles, ignoring case and ё', () => {
  const search = searchText({ title_en: 'Frieren: Beyond Journey’s End', title_jp: '葬送のフリーレン', title_ru: 'Провожающая в последний путь Фрирен' });
  const view = (query) => ({ tab: 'all', format: 'all', query });
  assert.ok(matches(item({ search }), view('FRIEREN')));
  assert.ok(matches(item({ search }), view('フリーレン')));
  assert.ok(matches(item({ search }), view('фрирен')));
  assert.ok(matches(item({ search }), view('  journey  ')));
  assert.ok(!matches(item({ search }), view('naruto')));
  assert.equal(normalizeText('Ёлка'), 'елка');
  assert.ok(matches(item({ search: searchText({ title_ru: 'Ёлка' }) }), view('ЕЛКА')));
  // Full-width Latin typed on a Japanese keyboard still matches.
  assert.ok(matches(item({ search }), view('ＦＲＩＥＲＥＮ')));
});

test('format filter groups TV, movies and everything else', () => {
  const view = (format) => ({ tab: 'all', format });
  const formats = ['tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music', ''];
  const shown = (format) => formats.filter((value) => matches(item({ format: value }), view(format)));
  assert.deepEqual(shown('all'), formats);
  assert.deepEqual(shown('tv'), ['tv', 'tv_short']);
  assert.deepEqual(shown('movie'), ['movie']);
  assert.deepEqual(shown('other'), ['ova', 'ona', 'special', 'music', '']);
});

test('tabs keep exact-state lists across seasons; hide watched applies everywhere', () => {
  const titles = [
    item({ status: 'following' }), item({ status: 'watching' }), item({ status: 'watched' }), item(),
    item({ status: 'following', inSeason: false }), item({ status: 'watching', inSeason: false })
  ];
  const count = (view) => titles.filter((title) => matches(title, view)).length;
  assert.equal(count({ tab: 'all' }), 4, 'All lists only this season');
  assert.equal(count({ tab: 'all', hideWatched: true }), 3);
  assert.equal(count({ tab: 'following' }), 2, 'Following includes other seasons');
  assert.equal(count({ tab: 'watching' }), 2);
  assert.equal(count({ tab: 'following', query: 'nothing' }), 0);
});

test('sort orders: scores and popularity descending, next episode future-first, title by locale', () => {
  const now = 1_000_000;
  const titles = [
    { id: 'past', nextEpAt: now - 60, popularity: 50, scoreMal: 7, title: 'b' },
    { id: 'later', nextEpAt: now + 7200, popularity: 10, scoreMal: 9, title: 'Äb' },
    { id: 'none-popular', nextEpAt: 0, popularity: 90, scoreMal: 0, title: 'c' },
    { id: 'soon', nextEpAt: now + 60, popularity: 5, scoreMal: 8, title: 'a' },
    { id: 'none', nextEpAt: 0, popularity: 1, scoreMal: 6, title: 'd' }
  ];
  const order = (sort) => [...titles].sort(comparator(sort, now, 'en')).map((title) => title.id);
  assert.deepEqual(order('next_ep'), ['soon', 'later', 'none-popular', 'past', 'none']);
  assert.deepEqual(order('popularity'), ['none-popular', 'past', 'later', 'soon', 'none']);
  assert.deepEqual(order('score_mal'), ['later', 'soon', 'past', 'none', 'none-popular']);
  assert.deepEqual(order('title'), ['soon', 'later', 'past', 'none-popular', 'none']);
});

test('countdowns show days, hours or minutes and stop once the time has passed', () => {
  const templates = { days: 'in {days}d {hours}h', hours: 'in {hours}h {minutes}m', minutes: 'in {minutes}m' };
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const at = (ms) => (now + ms) / 1000;
  assert.equal(formatCountdown(at(2 * 86400000 + 3 * 3600000 + 59000), now, templates), 'in 2d 3h');
  assert.equal(formatCountdown(at(5 * 3600000 + 7 * 60000), now, templates), 'in 5h 7m');
  assert.equal(formatCountdown(at(42 * 60000), now, templates), 'in 42m');
  assert.equal(formatCountdown(at(20000), now, templates), 'in 1m');
  assert.equal(formatCountdown(at(-1000), now, templates), null);
});

test('the week groups tracked episodes into seven local days starting today', () => {
  // 2026-11-13 23:30 in Tokyo is 14:30 UTC: still the 13th in Tokyo.
  const now = Date.UTC(2026, 10, 13, 14, 30);
  const seconds = (iso) => Date.parse(iso) / 1000;
  const entries = [
    { id: 'aired', nextEpAt: seconds('2026-11-13T14:00:00Z') },
    { id: 'tonight', nextEpAt: seconds('2026-11-13T14:50:00Z') },
    { id: 'after-midnight', nextEpAt: seconds('2026-11-13T15:10:00Z') },
    { id: 'early', nextEpAt: seconds('2026-11-14T01:00:00Z') },
    { id: 'day-seven', nextEpAt: seconds('2026-11-19T14:00:00Z') },
    { id: 'day-eight', nextEpAt: seconds('2026-11-20T15:30:00Z') }
  ];

  const tokyo = groupWeek(entries, { now, timeZone: 'Asia/Tokyo' });
  assert.deepEqual(tokyo.map((day) => day.key), [
    '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'
  ]);
  assert.deepEqual(tokyo.map((day) => day.isToday), [true, false, false, false, false, false, false]);
  assert.deepEqual(tokyo[0].entries.map((entry) => entry.id), ['tonight']);
  // Sorted by time within a day.
  assert.deepEqual(tokyo[1].entries.map((entry) => entry.id), ['after-midnight', 'early']);
  assert.deepEqual(tokyo[6].entries.map((entry) => entry.id), ['day-seven']);
  assert.equal(tokyo.flatMap((day) => day.entries).some((entry) => entry.id === 'day-eight'), false);

  // The same instants fall on other days in New York (UTC-5).
  const newYork = groupWeek(entries, { now, timeZone: 'America/New_York' });
  assert.equal(newYork[0].key, '2026-11-13');
  assert.deepEqual(newYork[0].entries.map((entry) => entry.id), ['tonight', 'after-midnight', 'early']);
  assert.deepEqual(newYork[6].entries.map((entry) => entry.id), ['day-seven']);
  assert.deepEqual(newYork[6].key, '2026-11-19');

  // Month and year boundaries.
  const december = groupWeek([], { now: Date.UTC(2026, 11, 29, 12), timeZone: 'UTC' });
  assert.deepEqual(december.map((day) => day.key), [
    '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'
  ]);
});
