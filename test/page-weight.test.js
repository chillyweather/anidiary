const test = require('node:test');
const assert = require('node:assert/strict');

const { anime, renderSeasonHtml } = require('./helpers/season-dom');

// A realistic season item: long titles in three scripts, all three scores,
// an upcoming episode, a partner's state and a full synopsis and relations
// that must stay out of the page.
function realisticTitle(malId) {
  return anime(malId, {
    title_en: `The Apothecary Diaries Season ${malId}: A Rather Long English Title`,
    title_jp: `薬屋のひとりごと 第${malId}期 とても長い日本語のタイトル`,
    title_ru: `Монолог фармацевта: сезон ${malId}, довольно длинное название`,
    synopsis_en: `Visible summary ${'x'.repeat(600)} FULL_SYNOPSIS_TAIL`,
    synopsis_ru: `Описание ${'я'.repeat(600)}`,
    poster_url: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx${malId}-AbCdEfGh.jpg`,
    score_mal: 8.71, score_anilist: 87, score_shiki: 8.6, episodes_total: 24,
    next_ep_num: 7, next_ep_at: Math.floor(Date.now() / 1000) + 86400 * 2,
    genres: '["Drama","Mystery"]',
    related: '[{"relation":"Sequel","entries":[{"title":"RELATIONSHIP_SECRET"}]}]',
    in_jellyfin: 1, popularity: 123456
  });
}

test('season items leave out synopses and relations and stay under the per-title budget', async () => {
  const count = 100;
  const animeList = Array.from({ length: count }, (_, index) => realisticTitle(1000 + index));
  const partners = Object.fromEntries(animeList.map((entry) => [entry.mal_id, [{ username: 'anna', status: 'watching' }]]));
  const statuses = Object.fromEntries(animeList.map((entry) => [entry.mal_id, 'following']));
  const empty = await renderSeasonHtml({ animeList: [] });
  const full = await renderSeasonHtml({ animeList, partners, statuses });

  assert.doesNotMatch(full, /Visible summary|FULL_SYNOPSIS_TAIL|Описание/);
  assert.doesNotMatch(full, /RELATIONSHIP_SECRET/);
  assert.doesNotMatch(full, /data-modal=/);

  const perTitle = (Buffer.byteLength(full) - Buffer.byteLength(empty)) / count;
  // The pre-redesign card was ~1.7 KB per title. These titles are long in all
  // three scripts and carry every optional part; a typical title is ~1.2 KB.
  assert.ok(perTitle < 1600, `per-title HTML is ${Math.round(perTitle)} bytes`);
});

test('only the first row of posters loads eagerly, and every poster reserves its 2:3 box', async () => {
  const animeList = Array.from({ length: 12 }, (_, index) => anime(index + 1));
  animeList[10].poster_url = null;
  const html = await renderSeasonHtml({ animeList });
  const images = [...html.matchAll(/<img class="title__poster"[^>]*>/g)].map((match) => match[0]);
  assert.equal(images.length, 11);
  for (const image of images) assert.match(image, /width="200" height="300"/);
  assert.equal(images.filter((image) => !/loading="lazy"/.test(image)).length, 8);
  // A missing poster renders the neutral placeholder rather than a broken image.
  assert.match(html, /<span class="title__poster"><\/span>\s*<button class="title__open" aria-haspopup="dialog">Title 11<\/button>/);
});
