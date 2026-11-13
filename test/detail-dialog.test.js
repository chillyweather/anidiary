const test = require('node:test');
const assert = require('node:assert/strict');

const { anime, createSeasonDom, closeWindows, click, settle, localNoon } = require('./helpers/season-dom');

test.afterEach(closeWindows);

const HOUR = 3600;

function detail(malId, overrides = {}) {
  return {
    mal_id: malId, title_en: `Title ${malId}`, title_jp: `タイトル${malId}`, title_ru: `Название ${malId}`,
    synopsis_en: `Synopsis ${malId}`, synopsis_ru: null, poster_url: `https://s4.anilist.co/poster-${malId}.jpg`,
    score_mal: 8.1, score_anilist: 80, score_shiki: null, episodes_total: 12, season: 'fall_2026',
    airing_status: 'Currently Airing', next_ep_num: null, next_ep_at: null, anilist_id: 77,
    genres: ['Drama'], related: [], in_jellyfin: false, user_status: null, partners: [],
    series_nav: { previous: null, next: null },
    ...overrides
  };
}

async function setup(options = {}) {
  const now = localNoon();
  return createSeasonDom({
    now,
    animeList: [anime(1), anime(2)],
    details: {
      1: detail(1, {
        related: [
          { relation: 'Sequel', entries: [{ mal_id: 9, type: 'anime', title: 'Provider sequel', local: { mal_id: 9, title_en: 'Title 9', season: 'winter_2027' } }] },
          { relation: 'Adaptation', entries: [{ mal_id: 500, type: 'manga', title: 'The manga' }] }
        ],
        series_nav: { previous: null, next: { mal_id: 9, title_en: 'Title 9', season: 'winter_2027' } },
        partners: [{ username: 'anna', status: 'watching' }]
      }),
      9: detail(9, { season: 'winter_2027', next_ep_at: Math.floor(now / 1000) + 3 * HOUR, next_ep_num: 1 })
    },
    ...options
  });
}

test('the title opens the dialog, Escape closes it and focus returns to the opener', async () => {
  const { window, document, fetchCalls } = await setup();
  const dialog = document.getElementById('animeModal');
  const opener = document.querySelector('.title[data-mal-id="1"] .title__open');
  opener.focus();

  await click(opener);
  assert.equal(dialog.open, true);
  assert.ok(dialog.contains(document.activeElement), 'focus moves into the dialog');
  assert.equal(fetchCalls.at(-1).url, '/api/anime/1');
  assert.equal(document.getElementById('modalTitle').textContent, 'Title 1');
  assert.equal(document.getElementById('modalSynopsisEn').textContent, 'Synopsis 1');
  assert.equal(document.getElementById('modalState').dataset.state, 'success');
  assert.equal(dialog.getAttribute('aria-busy'), 'false');
  assert.deepEqual([...document.querySelectorAll('#modalScores a')].map((link) => link.href),
    ['https://myanimelist.net/anime/1', 'https://anilist.co/anime/77']);

  // The other household member's state, as text.
  const partner = document.querySelector('#modalPartners .chip');
  assert.equal(partner.dataset.status, 'watching');
  assert.equal(partner.textContent, 'Aanna: watching');
  assert.equal(document.getElementById('modalPartners').hidden, false);

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, opener);
});

test('the close button and a backdrop click close the dialog', async () => {
  const { document } = await setup();
  const dialog = document.getElementById('animeModal');
  const poster = document.querySelector('.title[data-mal-id="2"] .title__poster');

  await click(poster);
  assert.equal(dialog.open, true);
  await click(document.getElementById('modalClose'));
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, document.querySelector('.title[data-mal-id="2"] .title__open'),
    'a poster click returns focus to the title button');

  await click(poster);
  await click(document.querySelector('#animeModal .detail__sheet'));
  assert.equal(dialog.open, true, 'a click inside the sheet does not close');
  await click(dialog);
  assert.equal(dialog.open, false);
});

test('related titles in our catalogue open in the dialog; others are plain text', async () => {
  const { document, fetchCalls } = await setup();
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));

  const titles = [...document.querySelectorAll('#modalRelated .related__title')];
  assert.deepEqual(titles.map((element) => element.tagName), ['BUTTON', 'SPAN']);
  assert.equal(titles[1].textContent, 'The manga');

  await click(titles[0]);
  assert.equal(fetchCalls.at(-1).url, '/api/anime/9');
  assert.equal(document.getElementById('animeModal').open, true);
  assert.equal(document.getElementById('modalTitle').textContent, 'Title 9');
  assert.equal(document.activeElement, document.getElementById('modalTitle'));
});

test('prequel and sequel buttons navigate within the dialog', async () => {
  const { document, fetchCalls } = await setup();
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));

  const next = document.getElementById('modalNextSeries');
  assert.equal(next.hidden, false);
  assert.equal(document.getElementById('modalPrevSeries').hidden, true);
  assert.equal(next.querySelector('.detail__series-title').textContent, 'Title 9');
  assert.equal(next.querySelector('.detail__series-meta').textContent, 'Winter 2027');

  await click(next);
  assert.equal(fetchCalls.at(-1).url, '/api/anime/9');
  assert.equal(document.getElementById('modalTitle').textContent, 'Title 9');
  assert.equal(document.getElementById('modalSeriesNav').hidden, true);
});

test('loading and error states are announced in the dialog', async () => {
  let fail;
  const { document } = await setup({
    fetchHandler: () => new Promise((resolve, reject) => { fail = () => reject(new Error('offline')); })
  });
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));
  const state = document.getElementById('modalState');
  assert.equal(state.dataset.state, 'loading');
  assert.equal(state.textContent, 'Loading details…');
  assert.equal(document.getElementById('animeModal').getAttribute('aria-busy'), 'true');

  fail();
  await settle();
  assert.equal(state.dataset.state, 'error');
  assert.match(state.textContent, /could not be loaded/);
  assert.equal(document.getElementById('animeModal').getAttribute('aria-busy'), 'false');
});

test('a title with no details shows the empty state', async () => {
  const { document } = await setup({
    details: { 1: detail(1, { synopsis_en: null, genres: [], score_mal: null, score_anilist: null }) }
  });
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));
  const state = document.getElementById('modalState');
  assert.equal(state.dataset.state, 'empty');
  assert.equal(state.textContent, 'There is no synopsis or score for this title yet.');
});

test('status changes in the dialog update the item, counts and the week strip', async () => {
  const { document, fetchCalls } = await setup();
  await click(document.querySelector('.title[data-mal-id="1"] .title__open'));

  const follow = document.querySelector('#modalActions [data-set="following"]');
  await click(follow);
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'following' });
  assert.equal(follow.getAttribute('aria-pressed'), 'true');
  const item = document.querySelector('.title[data-mal-id="1"]');
  assert.equal(item.dataset.status, 'following');
  assert.equal(item.querySelector('[data-set="following"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('.tab[data-tab="following"] .tab__count').textContent, '1');

  const jellyfin = document.querySelector('#modalActions [data-set="jellyfin"]');
  await click(jellyfin);
  assert.equal(jellyfin.getAttribute('aria-pressed'), 'true');
  assert.equal(item.hasAttribute('data-jellyfin'), true);

  // A related title that is not on this page joins the week once followed.
  await click(document.querySelector('#modalRelated button.related__title'));
  await click(document.querySelector('#modalActions [data-set="watching"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 9, status: 'watching' });
  const slots = [...document.querySelectorAll('#weekDays .slot')];
  assert.deepEqual(slots.map((slot) => slot.dataset.openId), ['9']);
  assert.equal(slots[0].querySelector('.slot__title').textContent, 'Title 9');
  assert.equal(slots[0].dataset.status, 'watching');

  await click(document.querySelector('#modalActions [data-set="watching"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 9, status: 'none' });
  assert.equal(document.querySelectorAll('#weekDays .slot').length, 0);
});

test('week strip entries open their title in the dialog', async () => {
  const now = localNoon();
  const { document, fetchCalls } = await setup({
    animeList: [anime(1, { next_ep_at: Math.floor(now / 1000) + HOUR })],
    statuses: { 1: 'following' },
    details: { 1: detail(1, { user_status: 'following', next_ep_at: Math.floor(now / 1000) + HOUR }) }
  });
  const slot = document.querySelector('#weekDays .slot');
  await click(slot);
  assert.equal(document.getElementById('animeModal').open, true);
  assert.equal(fetchCalls.at(-1).url, '/api/anime/1');
  document.getElementById('animeModal').close();
  assert.equal(document.activeElement, slot);
});
