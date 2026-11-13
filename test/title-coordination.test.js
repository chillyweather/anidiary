// Regression tests for per-title coordination of writes, detail loads, the
// shared title store, sorting over time and focus after the dialog closes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  anime, createSeasonDom, closeWindows, click, settle, localNoon, deferredFetch
} = require('./helpers/season-dom');
const TitleItem = require('../public/js/title-item');
const { getCatalog } = require('../src/locales');

test.afterEach(closeWindows);

const HOUR = 3600;

function detail(malId, overrides = {}) {
  return {
    mal_id: malId, title_en: `Title ${malId}`, title_jp: null, title_ru: null,
    synopsis_en: `Synopsis ${malId}`, synopsis_ru: null, poster_url: `https://s4.anilist.co/poster-${malId}.jpg`,
    score_mal: null, score_anilist: 70, score_shiki: null, episodes_total: 12, season: 'fall_2026',
    airing_status: 'Currently Airing', next_ep_num: null, next_ep_at: null, anilist_id: 7,
    format: 'tv', popularity: 50, genres: [], related: [], in_jellyfin: false, user_status: null,
    partners: [], series_nav: { previous: null, next: null },
    ...overrides
  };
}

const markResponse = (call) => ({ ok: true, status: call.body.status === 'none' ? null : call.body.status });
const jellyfinResponse = (call) => ({ ok: true, available: call.body.available });
const isMark = (malId) => (call) => call.url === '/api/mark' && call.body.mal_id === malId;
const pressed = (button) => button.getAttribute('aria-pressed');
const statusButtons = (container) => [...container.querySelectorAll('[data-set]:not([data-set="jellyfin"])')];
const count = (document, tab) => document.querySelector(`.tab[data-tab="${tab}"] .tab__count`).textContent;
const visibleIds = (document) => [...document.querySelectorAll('#catalogue > .title')].filter((el) => !el.hidden).map((el) => el.dataset.malId);

// 1 ─ concurrent writes

test('a title allows one status write at a time across the grid and the dialog', async () => {
  const deferred = deferredFetch();
  const { document, fetchCalls } = await createSeasonDom({
    animeList: [anime(1), anime(2)], fetchHandler: deferred.handler
  });
  const item = document.querySelector('.title[data-mal-id="1"]');

  // Open the dialog for title 1 so both of its status groups are on screen.
  await click(item.querySelector('.title__open'));
  deferred.release('/api/anime/1', detail(1));
  await settle();
  const dialogActions = document.getElementById('modalActions');
  assert.ok(statusButtons(dialogActions).every((button) => !button.disabled));

  await click(item.querySelector('[data-set="following"]'));
  for (const button of [...statusButtons(item), ...statusButtons(dialogActions)]) {
    assert.equal(button.disabled, true, 'the whole status group is disabled in grid and dialog');
    assert.equal(button.getAttribute('aria-busy'), 'true');
  }
  assert.equal(item.querySelector('[data-set="jellyfin"]').disabled, false, 'Jellyfin is a separate group');

  // A second click before the first response returns is ignored.
  item.querySelector('[data-set="watching"]').disabled = false;
  await click(item.querySelector('[data-set="watching"]'));
  await click(dialogActions.querySelector('[data-set="watched"]'));
  assert.equal(fetchCalls.filter((call) => call.url === '/api/mark').length, 1);

  deferred.release(isMark(1), markResponse);
  await settle();
  assert.equal(item.dataset.status, 'following');
  assert.equal(pressed(dialogActions.querySelector('[data-set="following"]')), 'true');
  assert.ok([...statusButtons(item), ...statusButtons(dialogActions)].every((button) => !button.disabled));
});

test('writes to different titles resolved in reverse order each land on their own title', async () => {
  const deferred = deferredFetch();
  const { document } = await createSeasonDom({ animeList: [anime(1), anime(2)], fetchHandler: deferred.handler });
  const first = document.querySelector('.title[data-mal-id="1"]');
  const second = document.querySelector('.title[data-mal-id="2"]');

  await click(first.querySelector('[data-set="following"]'));
  await click(second.querySelector('[data-set="watching"]'));
  deferred.release(isMark(2), markResponse);
  await settle();
  deferred.release(isMark(1), markResponse);
  await settle();

  assert.equal(first.dataset.status, 'following');
  assert.equal(second.dataset.status, 'watching');
  assert.equal(count(document, 'following'), '1');
  assert.equal(count(document, 'watching'), '1');
});

// 2 ─ one title collection

test('following a title open only in the dialog adds it to its tab, count and week, and clearing removes it', async () => {
  const now = localNoon();
  const { document, fetchCalls } = await createSeasonDom({
    now,
    animeList: [anime(1)],
    details: {
      1: detail(1, { related: [{ relation: 'Sequel', entries: [{ mal_id: 9, type: 'anime', title: 'Nine', local: { mal_id: 9, title_en: 'Title 9' } }] }] }),
      // No scheduled episode: it still belongs to its tab.
      9: detail(9, { season: 'winter_2027', airing_status: 'Not yet aired', format: 'movie', partners: [{ username: 'anna', status: 'watching' }] }),
      10: detail(10, { season: 'winter_2027', next_ep_at: Math.floor(now / 1000) + 2 * HOUR, next_ep_num: 1 })
    }
  });
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));
  await click(document.querySelector('#modalRelated button.related__title'));
  assert.equal(document.getElementById('modalTitle').textContent, 'Title 9');
  assert.equal(document.querySelector('.title[data-mal-id="9"]'), null);

  await click(document.querySelector('#modalActions [data-set="following"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 9, status: 'following' });
  const created = document.querySelector('.title[data-mal-id="9"]');
  assert.ok(created, 'a grid item is created');
  assert.equal(created.dataset.status, 'following');
  assert.equal(created.hasAttribute('data-other-season'), true);
  assert.equal(created.dataset.format, 'movie');
  assert.equal(created.querySelector('.title__open').textContent, 'Title 9');
  assert.equal(created.querySelector('.chip').dataset.status, 'watching');
  assert.equal(created.querySelector('[data-set="following"]').getAttribute('aria-pressed'), 'true');
  assert.equal(count(document, 'following'), '1');
  assert.equal(created.hidden, true, 'not listed under All');
  assert.equal(document.getElementById('weekEmpty').textContent, 'None of your titles air in the next seven days.');

  document.getElementById('animeModal').close();
  await click(document.querySelector('.tab[data-tab="following"]'));
  assert.deepEqual(visibleIds(document), ['9']);

  // Clearing from the created grid item behaves like a server-rendered
  // out-of-season item: it leaves the tab and the count.
  await click(created.querySelector('[data-set="following"]'));
  assert.equal(created.dataset.status, '');
  assert.equal(count(document, 'following'), '0');
  assert.deepEqual(visibleIds(document), []);
  await click(document.querySelector('.tab[data-tab="all"]'));
  assert.deepEqual(visibleIds(document), ['1']);
  assert.match(document.getElementById('weekEmpty').textContent, /^Follow a title/);

  // A scheduled dialog-only title shows in the week, the tab and the count alike.
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));
  document.getElementById('animeModal').close();
  await click(document.querySelector('.title[data-mal-id="9"] .title__poster'));
  document.getElementById('animeModal').close();
  const openTen = document.createElement('button');
  openTen.dataset.openId = '10';
  document.body.appendChild(openTen);
  await click(openTen);
  await click(document.querySelector('#modalActions [data-set="watching"]'));
  assert.equal(count(document, 'watching'), '1');
  assert.deepEqual([...document.querySelectorAll('#weekDays .slot')].map((slot) => slot.dataset.openId), ['10']);
  await click(document.querySelector('#modalActions [data-set="watching"]'));
  assert.equal(count(document, 'watching'), '0');
  assert.equal(document.querySelectorAll('#weekDays .slot').length, 0);
});

test('client-created items match the server-rendered markup exactly', () => {
  const ui = getCatalog('ru');
  const data = {
    mal_id: 5, title_en: 'A & B <i>', title_jp: '題名', title_ru: 'Название "в кавычках"',
    poster_url: 'https://s4.anilist.co/x.jpg?a=1&b=2', score_mal: 8.25, score_anilist: 82, score_shiki: null,
    episodes_total: 1, airing_status: 'Finished Airing', next_ep_at: null, format: 'ova', popularity: 9,
    in_jellyfin: true
  };
  const options = { status: 'watched', partners: [{ username: 'anna', status: 'following' }], langPref: 'ru', ui, inSeason: false, eager: false, nowSeconds: 1_800_000_000 };
  const tree = TitleItem.titleTree(data, options);
  const html = TitleItem.toHtml(tree);
  const dom = new JSDOM('<ul id="list"></ul>');
  const list = dom.window.document.getElementById('list');
  list.appendChild(TitleItem.toDom(tree, dom.window.document));
  const parsed = new JSDOM(`<ul>${html}</ul>`).window.document.querySelector('li');
  // Same element tree; the server output only adds newlines between children.
  assert.equal(list.firstChild.outerHTML, parsed.outerHTML.replace(/>\n</g, '><').replace(/>\n</g, '><'));
  assert.equal(parsed.querySelector('.title__open').textContent, 'Название "в кавычках"');
});

// 3 ─ dialog actions reset per title

test('opening another title resets the dialog actions and keeps them disabled until its details load', async () => {
  const deferred = deferredFetch();
  const { document, fetchCalls } = await createSeasonDom({
    animeList: [anime(1, { in_jellyfin: 1 }), anime(2)], fetchHandler: deferred.handler
  });
  const dialog = document.getElementById('animeModal');
  const jellyfin = document.querySelector('#modalActions [data-set="jellyfin"]');

  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));
  assert.equal(jellyfin.disabled, true, 'disabled while loading');
  deferred.release('/api/anime/1', detail(1, { in_jellyfin: true, user_status: null }));
  await settle();
  assert.equal(pressed(jellyfin), 'true');
  assert.equal(jellyfin.disabled, false);

  dialog.close();
  await click(document.querySelector('.title[data-mal-id="2"] .title__open'));
  assert.equal(pressed(jellyfin), 'false', 'the previous title\'s state is gone');
  assert.ok([...document.querySelectorAll('#modalActions [data-set]')].every((button) => button.disabled));
  const writesBefore = fetchCalls.filter((call) => call.url !== '/api/anime/2').length;
  jellyfin.disabled = false;
  await click(jellyfin);
  assert.equal(fetchCalls.filter((call) => call.url !== '/api/anime/2').length, writesBefore, 'no write before details load');

  deferred.release('/api/anime/2', {}, { ok: false, status: 500 });
  await settle();
  assert.equal(document.getElementById('modalState').dataset.state, 'error');
  assert.ok([...document.querySelectorAll('#modalActions [data-set]')].every((button) => button.disabled), 'still disabled after a failure');
});

// 4 ─ detail payloads never undo newer writes

test('a detail payload does not overwrite a write that completed after its request started', async () => {
  const deferred = deferredFetch();
  const { document, fetchCalls } = await createSeasonDom({ animeList: [anime(1)], fetchHandler: deferred.handler });
  const item = document.querySelector('.title[data-mal-id="1"]');

  await click(item.querySelector('.title__open'));       // detail request starts
  await click(item.querySelector('[data-set="jellyfin"]')); // grid write while it is in flight
  await click(item.querySelector('[data-set="watching"]'));
  deferred.release('/api/jellyfin', jellyfinResponse);
  deferred.release(isMark(1), markResponse);
  await settle();
  assert.equal(item.hasAttribute('data-jellyfin'), true);
  assert.equal(item.dataset.status, 'watching');

  deferred.release('/api/anime/1', detail(1, { in_jellyfin: false, user_status: null })); // older payload
  await settle();
  assert.equal(item.hasAttribute('data-jellyfin'), true, 'grid keeps the newer value');
  assert.equal(item.dataset.status, 'watching');
  assert.equal(pressed(document.querySelector('#modalActions [data-set="jellyfin"]')), 'true', 'dialog shows the newer value');
  assert.equal(pressed(document.querySelector('#modalActions [data-set="watching"]')), 'true');
  assert.equal(count(document, 'watching'), '1');

  // The cached payload was corrected too: reopening needs no request and agrees.
  document.getElementById('animeModal').close();
  const detailRequests = fetchCalls.filter((call) => call.url === '/api/anime/1').length;
  await click(item.querySelector('.title__open'));
  assert.equal(fetchCalls.filter((call) => call.url === '/api/anime/1').length, detailRequests);
  assert.equal(pressed(document.querySelector('#modalActions [data-set="jellyfin"]')), 'true');

});

test('a detail payload requested after a write is authoritative', async () => {
  const deferred = deferredFetch();
  const { document } = await createSeasonDom({ animeList: [anime(1)], fetchHandler: deferred.handler });
  const item = document.querySelector('.title[data-mal-id="1"]');
  await click(item.querySelector('[data-set="jellyfin"]'));
  deferred.release('/api/jellyfin', jellyfinResponse);
  await settle();
  await click(item.querySelector('.title__open'));
  // Someone else turned it off in the meantime.
  deferred.release('/api/anime/1', detail(1, { in_jellyfin: false }));
  await settle();
  assert.equal(item.hasAttribute('data-jellyfin'), false);
});

// 5 ─ sort stays current

test('the minute tick re-sorts "Next episode" once an episode has aired, keeping focus', async () => {
  const now = localNoon();
  const seconds = Math.floor(now / 1000);
  const { document, clock, runTimers } = await createSeasonDom({
    now,
    animeList: [
      anime(1, { popularity: 100, next_ep_at: seconds + 2 * HOUR }),
      anime(2, { popularity: 50, next_ep_at: seconds + 30 }),
      anime(3, { popularity: 900 })
    ],
    storage: { 'anidiary.view': JSON.stringify({ sort: 'next_ep' }) }
  });
  const order = () => [...document.querySelectorAll('#catalogue > .title')].map((el) => el.dataset.malId);
  assert.deepEqual(order(), ['2', '1', '3']);
  const focused = document.querySelector('.title[data-mal-id="2"] .title__open');
  focused.focus();

  clock.now = now + 90 * 1000;
  runTimers(1000);
  assert.deepEqual(order(), ['1', '3', '2'], 'the aired episode falls behind future ones and untimed titles keep popularity order');
  assert.equal(document.querySelector('.title[data-mal-id="2"] .cd').textContent, 'Episode aired');
  assert.equal(document.activeElement, focused);
});

test('the minute tick leaves other sort orders alone', async () => {
  const now = localNoon();
  const seconds = Math.floor(now / 1000);
  const { document, clock, runTimers } = await createSeasonDom({
    now,
    animeList: [anime(1, { popularity: 10, next_ep_at: seconds + 30 }), anime(2, { popularity: 5, next_ep_at: seconds + HOUR })]
  });
  const order = () => [...document.querySelectorAll('#catalogue > .title')].map((el) => el.dataset.malId);
  clock.now = now + 90 * 1000;
  runTimers(1000);
  assert.deepEqual(order(), ['1', '2']);
});

// 6 ─ focus after closing

test('closing the dialog focuses the active tab when the opener was hidden by a filter', async () => {
  const { document } = await createSeasonDom({
    animeList: [anime(1), anime(2)],
    statuses: { 1: 'following' },
    details: { 1: detail(1, { user_status: 'following' }) }
  });
  const followingTab = document.querySelector('.tab[data-tab="following"]');
  await click(followingTab);
  const opener = document.querySelector('.title[data-mal-id="1"] .title__open');
  opener.focus();
  await click(opener);
  await click(document.querySelector('#modalActions [data-set="watched"]'));
  assert.equal(document.querySelector('.title[data-mal-id="1"]').hidden, true);

  document.getElementById('animeModal').close();
  assert.equal(document.activeElement, followingTab);
});

test('closing the dialog focuses the title in the grid when the week-strip opener was replaced', async () => {
  const now = localNoon();
  const { document } = await createSeasonDom({
    now,
    animeList: [anime(1, { next_ep_at: Math.floor(now / 1000) + HOUR })],
    statuses: { 1: 'following' },
    details: { 1: detail(1, { user_status: 'following', next_ep_at: Math.floor(now / 1000) + HOUR }) }
  });
  const slot = document.querySelector('#weekDays .slot');
  await click(slot);
  await click(document.querySelector('#modalActions [data-set="watching"]'));
  assert.equal(slot.isConnected, false, 'the week strip re-rendered');

  document.getElementById('animeModal').close();
  assert.equal(document.activeElement, document.querySelector('.title[data-mal-id="1"] .title__open'));
});

// Rapid navigation never shows a stale response.

test('a slow response for an earlier title never replaces a later one', async () => {
  const deferred = deferredFetch();
  const { window, document } = await createSeasonDom({ animeList: [anime(1), anime(2)], fetchHandler: deferred.handler });
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await click(document.querySelector('.title[data-mal-id="2"] .title__open'));

  deferred.release('/api/anime/2', detail(2, { in_jellyfin: true }));
  await settle();
  deferred.release('/api/anime/1', detail(1, { user_status: 'watched' }));
  await settle();
  assert.equal(document.getElementById('modalTitle').textContent, 'Title 2');
  assert.equal(pressed(document.querySelector('#modalActions [data-set="jellyfin"]')), 'true');
  assert.equal(pressed(document.querySelector('#modalActions [data-set="watched"]')), 'false');
  assert.equal(document.querySelector('.title[data-mal-id="1"]').dataset.status, '', 'a stale payload is not applied');
});
