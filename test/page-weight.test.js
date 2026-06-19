const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const { getCatalog } = require('../src/locales');

test('season card output excludes full detail and relationship payloads', async () => {
  const synopsis = `Visible summary ${'x'.repeat(130)} FULL_SYNOPSIS_TAIL`;
  const html = await ejs.renderFile(path.join(__dirname, '../src/views/partials/card.ejs'), {
    anime: {
      mal_id: 1, title_en: 'Title', title_jp: 'タイトル', title_ru: 'Название',
      synopsis_en: synopsis, synopsis_ru: null, poster_url: '/poster.jpg',
      score_mal: 8, score_anilist: 80, score_shiki: null, episodes_total: 12,
      season: 'spring_2026', airing_status: 'Currently Airing', airing_day: 'monday',
      next_ep_num: 2, next_ep_at: Math.floor(Date.now() / 1000) + 3600,
      anilist_id: 2, genres: '["Drama"]',
      related: '[{"relation":"Sequel","entries":[{"title":"RELATIONSHIP_SECRET"}]}]'
    },
    userStatus: null,
    langPref: 'en',
    ui: getCatalog('en'),
    isCurrentSeason: true,
    initiallyHidden: false
  });

  assert.match(html, /Visible summary/);
  assert.doesNotMatch(html, /FULL_SYNOPSIS_TAIL/);
  assert.doesNotMatch(html, /RELATIONSHIP_SECRET/);
  assert.doesNotMatch(html, /data-modal=/);
});
