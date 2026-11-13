// Renders the real season view with fixture data and runs the page scripts in
// jsdom. jsdom has no showModal(), so a small shim stands in for the browser's
// <dialog>: showModal() opens and focuses the first control, close() fires
// `close`, and Escape fires `cancel` then closes, as browsers do.
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const { getCatalog } = require('../../src/locales');
const { getAdjacentSeasons } = require('../../src/domain/seasons');
const titleItem = require('../../public/js/title-item');

const root = path.join(__dirname, '../..');
const SCRIPTS = ['catalogue.js', 'title-item.js', 'detail-loader.js', 'modal-rendering.js', 'app.js'];

// Noon today in the process's local time zone, so "+1h" is always today.
function localNoon() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

function anime(malId, overrides = {}) {
  return {
    mal_id: malId, title_en: `Title ${malId}`, title_jp: `タイトル${malId}`, title_ru: `Название ${malId}`,
    synopsis_en: null, synopsis_ru: null, poster_url: `https://s4.anilist.co/poster-${malId}.jpg`,
    score_mal: null, score_anilist: null, score_shiki: null, episodes_total: 12,
    season: 'fall_2026', airing_status: 'Currently Airing', airing_day: null,
    next_ep_num: null, next_ep_at: null, anilist_id: null, genres: '[]', related: null,
    format: 'tv', popularity: 1000 - malId, in_jellyfin: 0,
    ...overrides
  };
}

async function renderSeasonHtml({
  animeList = [], tracked = [], statuses = {}, partners = {}, langPref = 'en', now = localNoon()
} = {}) {
  const ui = getCatalog(langPref);
  return ejs.renderFile(path.join(root, 'src/views/season.ejs'), {
    animeList,
    trackedAnimeOutsideSeason: tracked,
    userStatuses: new Map(Object.entries(statuses).map(([id, status]) => [Number(id), status])),
    partnerStatuses: new Map(Object.entries(partners).map(([id, list]) => [Number(id), list])),
    nowSeconds: Math.floor(now / 1000),
    titleItem,
    year: 2026,
    season: 'fall',
    adjacentSeasons: getAdjacentSeasons(2026, 'fall'),
    user: { userId: 1, username: 'dima', langPref },
    ui,
    localeJson: JSON.stringify(ui),
    csrfToken: 'csrf-token'
  });
}

function installDialogShim(window) {
  const proto = window.HTMLDialogElement.prototype;
  proto.showModal = function showModal() {
    this.setAttribute('open', '');
    this.querySelector('button:not([disabled]), [href], input, select')?.focus();
  };
  proto.close = function close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };
  window.document.addEventListener('keydown', (event) => {
    const open = window.document.querySelector('dialog[open]');
    if (event.key !== 'Escape' || !open) return;
    const cancel = new window.Event('cancel', { cancelable: true });
    if (open.dispatchEvent(cancel)) open.close();
  });
}

const openWindows = [];

function closeWindows() {
  while (openWindows.length) openWindows.pop().close();
}

// details: { [malId]: detail JSON } served by GET /api/anime/:id.
async function createSeasonDom({
  html, details = {}, fetchHandler, now = localNoon(), storage = null, ...renderOptions
} = {}) {
  const markup = html || await renderSeasonHtml({ now, ...renderOptions });
  const dom = new JSDOM(markup, {
    url: 'http://localhost/season/2026/fall',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const fetchCalls = [];
  const timeouts = [];
  const timers = [];
  const clock = { now };

  window.Date.now = () => clock.now;
  window.console.error = () => {};
  // Timers (the minute tick, the toast's auto-hide) are recorded, not run;
  // runTimers(minDelay) runs the recorded ones at least that long.
  window.setTimeout = (callback, delay) => {
    timeouts.push(delay);
    timers.push({ callback, delay });
    return 0;
  };
  const runTimers = (minDelay = 0) => {
    const due = timers.filter((timer) => timer.delay >= minDelay);
    timers.splice(0, timers.length, ...timers.filter((timer) => timer.delay < minDelay));
    due.forEach((timer) => timer.callback());
  };
  window.setInterval = () => { throw new Error('the page must not poll with setInterval'); };
  installDialogShim(window);
  if (storage) {
    for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  }

  window.fetch = async (url, options = {}) => {
    const call = { url, options, body: JSON.parse(options.body || '{}') };
    fetchCalls.push(call);
    if (fetchHandler) return fetchHandler(call);
    const detailMatch = String(url).match(/^\/api\/anime\/(\d+)$/);
    if (detailMatch) {
      const data = details[detailMatch[1]];
      if (!data) return { ok: false, status: 404, json: async () => ({ error: 'Anime not found' }) };
      return { ok: true, json: async () => structuredClone(data) };
    }
    if (url === '/api/mark') return { ok: true, json: async () => ({ ok: true, status: call.body.status === 'none' ? null : call.body.status }) };
    if (url === '/api/jellyfin') return { ok: true, json: async () => ({ ok: true, available: call.body.available }) };
    throw new Error(`Unexpected fetch: ${url}`);
  };

  for (const script of SCRIPTS) {
    window.eval(fs.readFileSync(path.join(root, 'public/js', script), 'utf8'));
  }

  openWindows.push(window);
  return { window, document: window.document, fetchCalls, timeouts, runTimers, clock, now };
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function click(element) {
  element.dispatchEvent(new element.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  await settle();
}

// A fetch handler whose responses are released by hand: deferred.release(url
// pattern, body) resolves the oldest pending request matching it.
function deferredFetch() {
  const pending = [];
  const handler = (call) => new Promise((resolve) => pending.push({ call, resolve }));
  const release = (match, body, { ok = true, status = 200 } = {}) => {
    const index = pending.findIndex(({ call }) => (typeof match === 'function' ? match(call) : call.url === match));
    if (index < 0) throw new Error(`No pending request for ${match}`);
    const [{ call, resolve }] = pending.splice(index, 1);
    const payload = typeof body === 'function' ? body(call) : body;
    resolve({ ok, status, json: async () => structuredClone(payload) });
  };
  return { handler, release, pending };
}

module.exports = { anime, renderSeasonHtml, createSeasonDom, closeWindows, click, settle, localNoon, deferredFetch };
