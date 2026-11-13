const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const en = require('../src/locales/en');
const ru = require('../src/locales/ru');
const { anime, renderSeasonHtml } = require('./helpers/season-dom');

test('shared authenticated shell preserves navigation controls in every interface mode', async () => {
  for (const language of ['en', 'jp', 'ru']) {
    const html = await renderSeasonHtml({ langPref: language });
    assert.equal((html.match(/<header class="nav"/g) || []).length, 1);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one page heading');
    assert.match(html, /class="nav__logo" href="\/"/);
    assert.match(html, /rel="prev" href="\/season\/2026\/summer"/);
    assert.match(html, /rel="next" href="\/season\/2027\/winter"/);
    const pressed = [...html.matchAll(/data-lang="(\w+)" aria-pressed="true"/g)].map((match) => match[1]);
    assert.deepEqual(pressed, [language]);
    assert.match(html, /class="account-menu"/);
    assert.match(html, /action="\/logout"/);
    assert.match(html, /<meta name="csrf-token" content="csrf-token">/);
    assert.match(html, /<input type="hidden" name="_csrf" value="csrf-token">/);
    assert.match(html, /<dialog class="detail" id="animeModal" aria-labelledby="modalTitle"/);
    assert.doesNotMatch(html, /style="|onclick=|<script>(?!\s*$)/, 'no inline styles or scripts');
  }
  const russian = await renderSeasonHtml({ langPref: 'ru' });
  assert.match(russian, /<h1 class="nav__season">Осень 2026<\/h1>/);
  assert.match(russian, /aria-label="Язык названий"/);
  assert.match(russian, /aria-label="Закрыть"/);
  assert.match(await renderSeasonHtml({ langPref: 'jp' }), /aria-label="Close"/);
});

test('items render state as data, pressed buttons and a partner chip with accessible text', async () => {
  const html = await renderSeasonHtml({
    animeList: [anime(1, { in_jellyfin: 1 }), anime(2)],
    statuses: { 1: 'watching' },
    partners: { 1: [{ username: 'anna', status: 'following' }] }
  });
  const first = html.match(/<li class="title" data-mal-id="1"[\s\S]*?<\/li>/)[0];
  assert.match(first, /data-status="watching"/);
  assert.match(first, / data-jellyfin[ >]/);
  assert.match(first, /data-set="watching" aria-pressed="true" aria-label="Watching"/);
  assert.match(first, /data-set="following" aria-pressed="false"/);
  assert.match(first, /data-set="jellyfin" aria-pressed="true" aria-label="In Jellyfin"/);
  assert.match(first, /<span class="chip" data-status="following" title="anna: following"><span aria-hidden="true">A<\/span><span class="vh">anna: following<\/span><\/span>/);
  const second = html.match(/<li class="title" data-mal-id="2"[\s\S]*?<\/li>/)[0];
  assert.doesNotMatch(second, /class="chip"/);
  assert.doesNotMatch(second, /data-jellyfin[ >]/);
});

test('both interface catalogs define the same strings', () => {
  const shape = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
    : typeof value);
  assert.deepEqual(shape(ru), shape(en));
});

test('the stylesheet covers phone layouts and never asks for remote fonts', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.catalogue \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*scroll-snap-type: x mandatory/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /scroll-behavior: smooth/);
  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|@import/);
  assert.doesNotMatch(css, /\.card[\s_{-]|btn--more|modal-backdrop|modal__/, 'old card and modal styles are gone');
});

test('shared document head renders authentication and error pages without remote fonts', async () => {
  const views = path.join(__dirname, '../src/views');
  const login = await ejs.renderFile(path.join(views, 'login.ejs'), { error: null, csrfToken: 'token' });
  const register = await ejs.renderFile(path.join(views, 'register.ejs'), { error: 'That username is taken.', csrfToken: 'token' });
  const error = await ejs.renderFile(path.join(views, 'error.ejs'), { error: 'This page does not exist.', csrfToken: 'token' });
  assert.match(login, /<title>Log in - anidiary<\/title>/);
  assert.match(login, /<h1 class="auth-card__title">Log in<\/h1>/);
  assert.match(login, /<img class="auth__mascot" src="\/img\/mascot\.webp" width="214" height="256" alt="">/);
  assert.match(register, /<title>Create account - anidiary<\/title>/);
  assert.match(register, /role="alert">That username is taken\.</);
  assert.doesNotMatch(register, /mascot/, 'the mascot appears once, on the login page');
  assert.match(error, /<title>Error - anidiary<\/title>/);
  assert.match(error, /<h1 class="auth-card__title">This page does not exist\.<\/h1>/);
  for (const html of [login, register, error]) {
    assert.doesNotMatch(html, /googleapis|gstatic|anidiary\.png/);
    assert.match(html, /<link rel="preload" href="\/fonts\/onest\.woff2[^"]*" as="font" type="font\/woff2" crossorigin>/);
  }
});
