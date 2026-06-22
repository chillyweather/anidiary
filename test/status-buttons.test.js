const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function loadScript(window, file) {
  window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
}

function createDom({ fetchHandler } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html>
    <html>
      <head><meta name="csrf-token" content="csrf-token"></head>
      <body>
        <script id="localeCatalog" type="application/json">
          {"code":"en","following":"Following","loading":"Loading","released":"Released","episode":"Episode","episodeForms":["episode","episodes"],"countdown":{"days":"{days}d {hours}h","hours":"{hours}h {minutes}m","minutes":"{minutes}m"}}
        </script>
        <button class="tab active" data-tab="all">All</button>
        <button class="tab" data-tab="following">Following (0)</button>
        <div class="card-grid">
          <div class="card" data-mal-id="1" data-followed="false" data-in-current-season="true" data-status="">
            <button class="btn btn--more" data-moreless="more">More</button>
            <div class="card__actions">
              <button class="btn btn--follow" data-status="following">Follow</button>
              <button class="btn btn--jellyfin" data-jellyfin="true">Jellyfin</button>
              <button class="btn btn--watched" data-status="watched">Watched</button>
            </div>
          </div>
        </div>
        <div class="modal-backdrop" id="modalBackdrop">
          <div class="modal" id="animeModal" tabindex="-1">
            <button id="modalClose"></button>
            <div id="modalTitle"></div>
            <div id="modalTitleJp"></div>
            <div id="modalTitleRu"></div>
            <img id="modalPoster">
            <div id="modalSynopsisEn"></div>
            <div id="modalSynopsisRu"></div>
            <div id="modalGenres"></div>
            <div id="modalScores"></div>
            <div id="modalRelated"></div>
            <div id="modalCountdown"></div>
            <div id="modalStatus"></div>
            <div id="modalEpisodes"></div>
            <div id="modalState"></div>
            <div id="modalSeriesNav" hidden>
              <button class="modal__series-btn" id="modalPrevSeries" hidden><span class="modal__series-label"></span><span class="modal__series-title"></span><span class="modal__series-meta"></span></button>
              <button class="modal__series-btn" id="modalNextSeries" hidden><span class="modal__series-label"></span><span class="modal__series-title"></span><span class="modal__series-meta"></span></button>
            </div>
            <div id="modalActions">
              <button class="btn btn--follow" data-status="following">Follow</button>
              <button class="btn btn--jellyfin" data-jellyfin="true">Jellyfin</button>
              <button class="btn btn--watched" data-status="watched">Watched</button>
            </div>
          </div>
        </div>
        <select id="sort-select"></select>
      </body>
    </html>`, {
    url: 'http://localhost/season/2026/spring',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const fetchCalls = [];
  dom.window.setInterval = () => 0;
  dom.window.console.error = () => {};
  dom.window.fetch = fetchHandler || (async (url, options = {}) => {
    fetchCalls.push({ url, options, body: JSON.parse(options.body || '{}') });
    if (url === '/api/anime/1') {
      return {
        ok: true,
        json: async () => ({
          mal_id: 1,
          title_en: 'Test anime',
          title_jp: '',
          title_ru: '',
          synopsis_en: '',
          synopsis_ru: '',
          poster_url: '',
          genres: [],
          related: [],
          in_jellyfin: false,
          user_status: null,
          series_nav: null
        })
      };
    }
    if (url === '/api/mark') {
      return { ok: true, json: async () => ({ ok: true, status: fetchCalls.at(-1).body.status }) };
    }
    if (url === '/api/jellyfin') {
      return { ok: true, json: async () => ({ ok: true, available: fetchCalls.at(-1).body.available }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  loadScript(dom.window, 'public/js/detail-loader.js');
  loadScript(dom.window, 'public/js/modal-rendering.js');
  loadScript(dom.window, 'public/js/modal-focus.js');
  loadScript(dom.window, 'public/js/app.js');
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));

  return { window: dom.window, document: dom.window.document, fetchCalls };
}

async function click(button) {
  button.dispatchEvent(new button.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('card status buttons send requests and update visible state', async () => {
  const { document, fetchCalls } = createDom();
  const card = document.querySelector('.card');

  await click(document.querySelector('.card__actions [data-status="following"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'following' });
  assert.equal(fetchCalls.at(-1).options.headers['X-CSRF-Token'], 'csrf-token');
  assert.equal(card.dataset.status, 'following');
  assert.equal(card.dataset.followed, 'true');
  assert.equal(card.classList.contains('card--following'), true);
  assert.equal(document.querySelector('.card__actions [data-status="following"]').classList.contains('active'), true);

  await click(document.querySelector('.card__actions [data-jellyfin]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, available: true });
  assert.equal(card.classList.contains('card--jellyfin'), true);
  assert.equal(document.querySelector('.card__actions [data-jellyfin]').classList.contains('active'), true);

  await click(document.querySelector('.card__actions [data-status="watched"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'watched' });
  assert.equal(card.dataset.status, 'watched');
  assert.equal(card.classList.contains('card--following'), false);
  assert.equal(card.classList.contains('card--watched'), true);
  assert.equal(document.querySelector('.card__actions [data-status="following"]').classList.contains('active'), false);
  assert.equal(document.querySelector('.card__actions [data-status="watched"]').classList.contains('active'), true);
});

test('modal status buttons send requests and sync card state', async () => {
  const { document, fetchCalls } = createDom();
  const card = document.querySelector('.card');

  await click(document.querySelector('.btn--more'));
  await Promise.resolve();

  await click(document.querySelector('#modalActions [data-status="following"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'following' });
  assert.equal(card.dataset.status, 'following');
  assert.equal(document.querySelector('#modalActions [data-status="following"]').classList.contains('active'), true);
  assert.equal(document.querySelector('.card__actions [data-status="following"]').classList.contains('active'), true);

  await click(document.querySelector('#modalActions [data-jellyfin]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, available: true });
  assert.equal(card.classList.contains('card--jellyfin'), true);
  assert.equal(document.querySelector('#modalActions [data-jellyfin]').classList.contains('active'), true);

  await click(document.querySelector('#modalActions [data-status="watched"]'));
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'watched' });
  assert.equal(card.dataset.status, 'watched');
  assert.equal(document.querySelector('#modalActions [data-status="following"]').classList.contains('active'), false);
  assert.equal(document.querySelector('#modalActions [data-status="watched"]').classList.contains('active'), true);
  assert.equal(document.querySelector('.card__actions [data-status="following"]').classList.contains('active'), false);
  assert.equal(document.querySelector('.card__actions [data-status="watched"]').classList.contains('active'), true);
});

test('failed status updates show a visible action error', async () => {
  const fetchCalls = [];
  const { document } = createDom({
    fetchHandler: async (url, options = {}) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body || '{}') });
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: 'Invalid CSRF token' })
      };
    }
  });

  await click(document.querySelector('.card__actions [data-status="following"]'));

  const error = document.getElementById('actionError');
  assert.deepEqual(fetchCalls.at(-1).body, { mal_id: 1, status: 'following' });
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, 'Invalid CSRF token');
  assert.equal(document.querySelector('.card').dataset.status, '');
});
