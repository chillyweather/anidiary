const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const { getCatalog } = require('../src/locales');
const { getAdjacentSeasons } = require('../src/domain/seasons');

async function renderSeason(langPref) {
  const ui = getCatalog(langPref);
  return ejs.renderFile(path.join(__dirname, '../src/views/season.ejs'), {
    animeList: [],
    followedAnimeOutsideSeason: [],
    userStatuses: new Map(),
    year: 2026,
    season: 'spring',
    adjacentSeasons: getAdjacentSeasons(2026, 'spring'),
    user: { userId: 1, username: 'tester', langPref },
    ui,
    localeJson: JSON.stringify(ui),
    csrfToken: 'test-token'
  });
}

test('shared authenticated shell preserves navigation controls in every interface mode', async () => {
  for (const language of ['en', 'jp', 'ru']) {
    const html = await renderSeason(language);
    assert.equal((html.match(/<nav class="nav"/g) || []).length, 1);
    assert.match(html, /class="nav__logo" href="\/"/);
    assert.match(html, /class="nav-select season-select"/);
    assert.match(html, /class="nav-select language-select"/);
    assert.match(html, /class="account-menu"/);
    assert.match(html, /action="\/logout"/);
    assert.match(html, /<meta name="csrf-token" content="test-token">/);
    assert.match(html, /<input type="hidden" name="_csrf" value="test-token">/);
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="modalTitle"/);
  }
  assert.match(await renderSeason('ru'), />Язык</);
  assert.match(await renderSeason('ru'), /aria-label="Закрыть"/);
  assert.match(await renderSeason('jp'), />Language</);
  assert.match(await renderSeason('jp'), /aria-label="Close"/);
});

test('responsive stylesheet keeps mobile selectors through 320px layouts', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.season-select/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*\.language-select/);
});

test('shared document head renders authentication and error pages', async () => {
  const views = path.join(__dirname, '../src/views');
  const login = await ejs.renderFile(path.join(views, 'login.ejs'), { error: null, csrfToken: 'token' });
  const register = await ejs.renderFile(path.join(views, 'register.ejs'), { error: null, csrfToken: 'token' });
  const error = await ejs.renderFile(path.join(views, 'error.ejs'), { error: 'Failure', csrfToken: 'token' });
  assert.match(login, /<title>Login - anidiary<\/title>/);
  assert.match(register, /<title>Register - anidiary<\/title>/);
  assert.match(error, /<title>Error - anidiary<\/title>/);
});
