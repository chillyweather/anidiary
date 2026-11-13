const test = require('node:test');
const assert = require('node:assert/strict');

const { anime, createSeasonDom, closeWindows, click, settle, localNoon } = require('./helpers/season-dom');

test.afterEach(closeWindows);

const HOUR = 3600;

function fixture(now) {
  const seconds = Math.floor(now / 1000);
  return {
    now,
    animeList: [
      anime(1, { next_ep_at: seconds + HOUR, next_ep_num: 5, popularity: 300 }),
      anime(2, { next_ep_at: seconds + 30 * HOUR, next_ep_num: 2, popularity: 200, format: 'movie' }),
      anime(3, { airing_status: 'Finished Airing', popularity: 100, format: 'ova', title_en: 'Quiet Ending' })
    ]
  };
}

const pressed = (button) => button.getAttribute('aria-pressed');
const weekTitles = (document) => [...document.querySelectorAll('#weekDays .slot__title')].map((el) => el.textContent);
const tabCount = (document, tab) => document.querySelector(`.tab[data-tab="${tab}"] .tab__count`).textContent;

test('item status buttons update the marker, pressed state, counts and the week strip', async () => {
  const { document, fetchCalls, now } = await createSeasonDom(fixture(localNoon()));
  const item = document.querySelector('.title[data-mal-id="1"]');
  const follow = item.querySelector('[data-set="following"]');
  const watched = item.querySelector('[data-set="watched"]');

  assert.equal(document.getElementById('weekDays').hidden, true);
  assert.match(document.getElementById('weekEmpty').textContent, /^Follow a title/);

  await click(follow);
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'following' });
  assert.equal(fetchCalls.at(-1).options.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(item.dataset.status, 'following');
  assert.equal(pressed(follow), 'true');
  assert.equal(tabCount(document, 'following'), '1');
  assert.equal(document.getElementById('weekDays').hidden, false);
  assert.equal(document.getElementById('weekEmpty').hidden, true);
  assert.deepEqual(weekTitles(document), ['Title 1']);
  const today = document.querySelector('#weekDays .day[aria-current="date"]');
  assert.equal(today.querySelector('.day__name').textContent, 'Today');
  assert.equal(today.querySelector('.slot').dataset.openId, '1');
  assert.equal(document.querySelectorAll('#weekDays .day').length, 7);
  assert.ok(now);

  await click(document.querySelector('.title[data-mal-id="2"] [data-set="watching"]'));
  assert.deepEqual(weekTitles(document), ['Title 1', 'Title 2']);
  assert.equal(tabCount(document, 'watching'), '1');

  await click(watched);
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'watched' });
  assert.equal(item.dataset.status, 'watched');
  assert.equal(pressed(follow), 'false');
  assert.equal(pressed(watched), 'true');
  assert.equal(tabCount(document, 'following'), '0');
  assert.deepEqual(weekTitles(document), ['Title 2']);

  // Pressing the active state clears it.
  await click(watched);
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'none' });
  assert.equal(item.dataset.status, '');
  assert.equal(pressed(watched), 'false');

  const jellyfin = item.querySelector('[data-set="jellyfin"]');
  await click(jellyfin);
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, available: true });
  assert.equal(item.hasAttribute('data-jellyfin'), true);
  assert.equal(pressed(jellyfin), 'true');
  assert.equal(item.dataset.status, '', 'Jellyfin availability is independent of personal state');
});

test('with tracked titles but nothing airing this week the strip says so', async () => {
  const now = localNoon();
  const { document } = await createSeasonDom({
    now,
    animeList: [anime(1, { next_ep_at: Math.floor(now / 1000) + 9 * 24 * HOUR })],
    statuses: { 1: 'following' }
  });
  assert.equal(document.getElementById('weekDays').hidden, true);
  assert.equal(document.getElementById('weekEmpty').textContent, 'None of your titles air in the next seven days.');
});

test('tracked titles from other seasons appear in the week strip', async () => {
  const now = localNoon();
  const { document } = await createSeasonDom({
    now,
    animeList: [anime(1)],
    tracked: [anime(50, { season: 'summer_2026', next_ep_at: Math.floor(now / 1000) + 2 * HOUR, title_en: 'Carry-over' })],
    statuses: { 50: 'watching' }
  });
  assert.deepEqual(weekTitles(document), ['Carry-over']);
  assert.equal(document.querySelector('.title[data-mal-id="50"]').hidden, true, 'not listed under All');
});

test('a failed status update shows the error and changes nothing', async () => {
  const { document } = await createSeasonDom({
    ...fixture(localNoon()),
    fetchHandler: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Invalid CSRF token' }) })
  });
  const item = document.querySelector('.title[data-mal-id="1"]');
  const follow = item.querySelector('[data-set="following"]');
  await click(follow);

  const error = document.getElementById('actionError');
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Invalid CSRF token');
  assert.equal(item.dataset.status, '');
  assert.equal(pressed(follow), 'false');
  assert.equal(follow.disabled, false);
  assert.equal(follow.getAttribute('aria-busy'), 'false');
});

test('buttons stay pending until the request completes', async () => {
  let release;
  const { document } = await createSeasonDom({
    ...fixture(localNoon()),
    fetchHandler: () => new Promise((resolve) => {
      release = () => resolve({ ok: true, json: async () => ({ ok: true, status: 'following' }) });
    })
  });
  const item = document.querySelector('.title[data-mal-id="1"]');
  const follow = item.querySelector('[data-set="following"]');
  await click(follow);
  assert.equal(follow.disabled, true);
  assert.equal(follow.getAttribute('aria-busy'), 'true');
  assert.equal(item.dataset.status, '', 'state changes only after the response');
  release();
  await settle();
  assert.equal(item.dataset.status, 'following');
  assert.equal(follow.disabled, false);
});

test('Following and Watching tabs list only titles in that exact state', async () => {
  const { document } = await createSeasonDom(fixture(localNoon()));
  const item = document.querySelector('.title[data-mal-id="1"]');
  const followingTab = document.querySelector('.tab[data-tab="following"]');
  const watchingTab = document.querySelector('.tab[data-tab="watching"]');

  await click(item.querySelector('[data-set="following"]'));
  await click(followingTab);
  assert.equal(pressed(followingTab), 'true');
  assert.equal(item.hidden, false);
  assert.equal(document.querySelector('.title[data-mal-id="2"]').hidden, true);

  await click(item.querySelector('[data-set="watching"]'));
  assert.equal(tabCount(document, 'following'), '0');
  assert.equal(tabCount(document, 'watching'), '1');
  assert.equal(item.hidden, true);
  assert.equal(document.getElementById('noMatch').hidden, false);

  await click(watchingTab);
  assert.equal(item.hidden, false);
  assert.equal(document.getElementById('noMatch').hidden, true);

  await click(item.querySelector('[data-set="watched"]'));
  assert.equal(item.hidden, true);
  await click(followingTab);
  assert.equal(item.hidden, true);
});

test('search, format and hide-watched filter the catalogue and are remembered', async () => {
  const { window, document } = await createSeasonDom({
    ...fixture(localNoon()),
    statuses: { 3: 'watched' }
  });
  const visible = () => [...document.querySelectorAll('#catalogue > .title')].filter((el) => !el.hidden).map((el) => el.dataset.malId);
  const search = document.getElementById('title-search');
  const type = (value) => {
    search.value = value;
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const choose = (id, value) => {
    const element = document.getElementById(id);
    if (element.type === 'checkbox') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  assert.deepEqual(visible(), ['1', '2', '3']);
  type('название 2');
  assert.deepEqual(visible(), ['2']);
  type('タイトル1');
  assert.deepEqual(visible(), ['1']);
  type('zzz');
  assert.deepEqual(visible(), []);
  assert.equal(document.getElementById('noMatch').hidden, false);
  assert.equal(document.getElementById('noMatch').textContent, 'No titles match. Change the search or the filters.');
  type('');

  choose('format-filter', 'movie');
  assert.deepEqual(visible(), ['2']);
  choose('format-filter', 'other');
  assert.deepEqual(visible(), ['3']);
  choose('hide-watched', true);
  assert.deepEqual(visible(), []);
  choose('format-filter', 'all');
  assert.deepEqual(visible(), ['1', '2']);

  choose('sort-select', 'next_ep');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('anidiary.view')), {
    tab: 'all', format: 'all', hideWatched: true, sort: 'next_ep'
  });
});

test('saved view choices are restored and applied on load', async () => {
  const { document } = await createSeasonDom({
    ...fixture(localNoon()),
    statuses: { 3: 'watched', 2: 'following' },
    storage: { 'anidiary.view': JSON.stringify({ tab: 'following', format: 'movie', hideWatched: true, sort: 'title' }) }
  });
  assert.equal(pressed(document.querySelector('.tab[data-tab="following"]')), 'true');
  assert.equal(pressed(document.querySelector('.tab[data-tab="all"]')), 'false');
  assert.equal(document.getElementById('format-filter').value, 'movie');
  assert.equal(document.getElementById('hide-watched').checked, true);
  assert.equal(document.getElementById('sort-select').value, 'title');
  const visible = [...document.querySelectorAll('#catalogue > .title')].filter((el) => !el.hidden);
  assert.deepEqual(visible.map((el) => el.dataset.malId), ['2']);
});

test('broken saved preferences fall back to the defaults', async () => {
  const { document } = await createSeasonDom({
    ...fixture(localNoon()),
    storage: { 'anidiary.view': '{not json' }
  });
  assert.equal(pressed(document.querySelector('.tab[data-tab="all"]')), 'true');
  assert.equal(document.getElementById('sort-select').value, 'popularity');
});

test('sorting by next episode puts upcoming episodes first, soonest first', async () => {
  const now = localNoon();
  const seconds = Math.floor(now / 1000);
  const { window, document } = await createSeasonDom({
    now,
    animeList: [
      anime(1, { popularity: 500 }),
      anime(2, { popularity: 400, next_ep_at: seconds + 50 * HOUR }),
      anime(3, { popularity: 300, next_ep_at: seconds - HOUR }),
      anime(4, { popularity: 200, next_ep_at: seconds + 2 * HOUR })
    ]
  });
  const order = () => [...document.querySelectorAll('#catalogue > .title')].map((el) => el.dataset.malId);
  assert.deepEqual(order(), ['1', '2', '3', '4']);
  const select = document.getElementById('sort-select');
  select.value = 'next_ep';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(order(), ['4', '2', '1', '3']);
  select.value = 'popularity';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(order(), ['1', '2', '3', '4']);
});

test('countdowns update once a minute, aligned to the minute, with the local time as a tooltip', async () => {
  const now = localNoon() + 20000;
  const { document, timeouts } = await createSeasonDom(fixture(now));
  const countdown = document.querySelector('.title[data-mal-id="1"] .cd');
  assert.equal(countdown.textContent, 'in 1h 0m');
  assert.ok(countdown.title.length > 0, 'the absolute local day and time is available');
  assert.deepEqual(timeouts, [60000 - 20000 + 50]);
});
