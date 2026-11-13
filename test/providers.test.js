const test = require('node:test');
const assert = require('node:assert/strict');

const { createAniListClient, mapRelations, parseRetryAfter } = require('../src/services/anilist');
const { createShikimoriClient, cleanSynopsis } = require('../src/services/shikimori');
const { createRateLimiter } = require('../src/services/rateLimiter');
const { normalizeFormat } = require('../src/domain/formats');

const quiet = { log() {}, error() {} };

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body
  };
}

function seasonPage(media, hasNextPage = false) {
  return { data: { Page: { pageInfo: { hasNextPage, currentPage: 1 }, media } } };
}

function anilistClient(fetchImpl, overrides = {}) {
  const sleeps = [];
  const client = createAniListClient({
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    logger: quiet,
    minIntervalMs: 0,
    ...overrides
  });
  return { client, sleeps };
}

test('AniList honours Retry-After on 429 and then succeeds', async () => {
  let calls = 0;
  const { client, sleeps } = anilistClient(async () => {
    calls++;
    if (calls === 1) return response(429, { errors: [{ message: 'Too Many Requests.' }] }, { 'retry-after': '7' });
    return response(200, seasonPage([{ id: 10, idMal: 1, title: { english: 'One' }, status: 'RELEASING', format: 'TV' }]));
  });

  const result = await client.fetchSeason('fall', 2026);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [7000]);
  assert.equal(result.complete, true);
  assert.equal(result.records.get(1).title_en, 'One');
  assert.equal(result.records.get(1).format, 'tv');
});

test('AniList bounds Retry-After and gives up after limited retries', async () => {
  let calls = 0;
  const { client, sleeps } = anilistClient(async () => {
    calls++;
    return response(429, {}, { 'retry-after': '3600' });
  }, { maxRetries: 2, maxRetryAfterMs: 61000 });

  const result = await client.fetchSeason('fall', 2026);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [61000, 61000]);
  assert.equal(result.complete, false);
  assert.match(result.errors[0].message, /429/);
  assert.equal(result.records.size, 0);
});

test('AniList spaces consecutive requests to respect its rate limit', async () => {
  let clock = 0;
  const sleeps = [];
  const client = createAniListClient({
    fetchImpl: async () => response(200, seasonPage([], false)),
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    logger: quiet,
    minIntervalMs: 2000
  });
  clock = 10000;
  await client.fetchSeason('fall', 2026);
  clock += 500;
  await client.fetchSeason('winter', 2027);
  assert.deepEqual(sleeps, [1500]);
});

test('Retry-After accepts seconds or an HTTP date and defaults when absent', () => {
  assert.equal(parseRetryAfter('2', 0), 2000);
  assert.equal(parseRetryAfter(new Date(10000).toUTCString(), 4000), 6000);
  assert.equal(parseRetryAfter(null, 0), 60000);
});

test('AniList season records carry format, popularity, and MAL-keyed relations', async () => {
  const { client } = anilistClient(async () => response(200, seasonPage([{
    id: 10,
    idMal: 1,
    title: { romaji: 'Ichi', english: null, native: '一' },
    description: 'Text<br>more',
    nextAiringEpisode: null,
    episodes: 12,
    averageScore: 80,
    coverImage: { large: 'https://s4.anilist.co/x.jpg' },
    genres: ['Drama'],
    status: 'NOT_YET_RELEASED',
    format: 'TV_SHORT',
    popularity: 4321,
    relations: { edges: [
      { relationType: 'PREQUEL', node: { id: 11, idMal: 2, type: 'ANIME', title: { romaji: 'Zero', english: 'Zero EN' } } },
      { relationType: 'SOURCE', node: { id: 12, idMal: 3, type: 'MANGA', title: { romaji: 'Manga' } } },
      { relationType: 'SEQUEL', node: { id: 13, idMal: null, type: 'ANIME', title: { romaji: 'No MAL id' } } }
    ] }
  }])));

  const { records } = await client.fetchSeason('fall', 2026);
  const record = records.get(1);
  assert.equal(record.title_en, 'Ichi');
  assert.equal(record.format, 'tv_short');
  assert.equal(record.popularity, 4321);
  assert.equal(record.airing_status, 'Not yet aired');
  assert.equal(record.next_ep_at, null);
  assert.deepEqual(record.related, [
    { relation: 'Prequel', entries: [{ mal_id: 2, type: 'anime', title: 'Zero EN' }] },
    { relation: 'Adaptation', entries: [{ mal_id: 3, type: 'manga', title: 'Manga' }] }
  ]);
});

test('AniList relation names match the translated catalog keys', () => {
  const { relations } = require('../src/locales/en');
  const types = ['ADAPTATION', 'SOURCE', 'PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'CHARACTER',
    'SUMMARY', 'COMPILATION', 'CONTAINS', 'ALTERNATIVE', 'SPIN_OFF', 'OTHER', 'UNKNOWN_NEW_TYPE'];
  const mapped = mapRelations({ edges: types.map((relationType, index) => ({
    relationType, node: { idMal: index + 1, type: 'ANIME', title: { romaji: relationType } }
  })) });
  for (const group of mapped) assert.ok(relations[group.relation.toLowerCase()], group.relation);
});

test('AniList countdown lookup batches MAL ids by 50 and keeps other batches when one fails', async () => {
  const requests = [];
  const { client } = anilistClient(async (url, options) => {
    const { variables } = JSON.parse(options.body);
    requests.push(variables.ids);
    if (requests.length === 2) return response(500, {});
    return response(200, { data: { Page: { media: variables.ids.map((idMal) => ({
      idMal, status: 'RELEASING', episodes: 12, nextAiringEpisode: idMal === 1 ? null : { airingAt: 100 + idMal, episode: 3 }
    })) } } });
  });

  const ids = Array.from({ length: 120 }, (_, index) => index + 1);
  const result = await client.fetchByMalIds(ids);
  assert.deepEqual(requests.map((chunk) => chunk.length), [50, 50, 20]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors.map((error) => error.batch), [2]);
  assert.equal(result.records.size, 70);
  assert.deepEqual(result.records.get(1), { next_ep_num: null, next_ep_at: null, airing_status: 'Currently Airing', episodes_total: 12 });
  assert.equal(result.records.get(101).next_ep_at, 201);
  assert.equal(result.records.has(60), false);
});

test('Shikimori fetches up to 50 ids per GraphQL request and survives a failed batch', async () => {
  const requests = [];
  const client = createShikimoriClient({
    logger: quiet,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://shikimori.io/api/graphql');
      assert.equal(options.method, 'POST');
      assert.ok(options.headers['User-Agent']);
      const { variables } = JSON.parse(options.body);
      const ids = variables.ids.split(',').map(Number);
      requests.push(ids);
      if (requests.length === 2) return response(502, {});
      return response(200, { data: { animes: ids.map((id) => ({
        id: String(id), malId: String(id), russian: `Аниме ${id}`, score: id === 1 ? 0 : 7.5,
        descriptionHtml: '<div class="b-text_with_paragraphs">Текст</div>'
      })) } });
    }
  });

  const ids = Array.from({ length: 120 }, (_, index) => index + 1);
  const result = await client.fetchBatch([...ids, 1, -5, 2.5]);
  assert.deepEqual(requests.map((chunk) => chunk.length), [50, 50, 20]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors, [{ batch: 2, message: 'Shikimori error: 502' }]);
  assert.equal(result.records.size, 70);
  assert.deepEqual(result.records.get(2), { title_ru: 'Аниме 2', synopsis_ru: 'Текст', score_shiki: 7.5 });
  assert.equal(result.records.get(1).score_shiki, null);
  assert.equal(result.records.has(75), false);
});

test('Shikimori GraphQL errors fail only their batch', async () => {
  const client = createShikimoriClient({
    logger: quiet,
    fetchImpl: async () => response(200, { errors: [{ message: 'Rate limit' }] })
  });
  const result = await client.fetchBatch([1]);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].message, 'Rate limit');
});

test('Shikimori synopses lose markup, BB tags and entities, and repair mojibake', () => {
  const html = '<div class="b-text_with_paragraphs">Отряд <a href="https://shikimori.io/characters/1" '
    + 'class="bubbled">Химмеля</a> &amp; <b>друзья</b>.<br>Новая строка</div>';
  assert.equal(cleanSynopsis(html, null), 'Отряд Химмеля & друзья.\nНовая строка');
  assert.equal(
    cleanSynopsis(null, 'Героя [character=186854]Химмеля[/character] [i]ждут[/i] [spoiler=спойлер]тайны[/spoiler].'),
    'Героя Химмеля ждут тайны.'
  );
  const mojibake = Buffer.from('Фрирен', 'utf8').toString('latin1');
  assert.equal(cleanSynopsis(null, mojibake), 'Фрирен');
  assert.equal(cleanSynopsis('<div></div>', null), null);
});

test('formats from both providers normalize to one vocabulary', () => {
  assert.equal(normalizeFormat('TV'), 'tv');
  assert.equal(normalizeFormat('TV_SHORT'), 'tv_short');
  assert.equal(normalizeFormat('TV Special'), 'special');
  assert.equal(normalizeFormat('Movie'), 'movie');
  assert.equal(normalizeFormat('ONA'), 'ona');
  assert.equal(normalizeFormat('CM'), null);
  assert.equal(normalizeFormat(null), null);
});

test('Shikimori rows are matched by malId only, never by Shikimori id', async () => {
  const client = createShikimoriClient({
    logger: quiet,
    fetchImpl: async () => response(200, { data: { animes: [
      // Shikimori id 100 is a different title whose MAL id is 999 (not requested).
      { id: '100', malId: '999', russian: 'Чужое', score: 5, descriptionHtml: null },
      // Shikimori id 200 is MAL title 300, which was requested.
      { id: '200', malId: '300', russian: 'Нужное', score: 8, descriptionHtml: null },
      // No MAL id at all: dropped even though its Shikimori id was requested.
      { id: '400', malId: null, russian: 'Без MAL', score: 6, descriptionHtml: null }
    ] } })
  });
  const result = await client.fetchBatch([100, 300, 400]);
  assert.equal(result.complete, true);
  assert.deepEqual([...result.records.keys()], [300]);
  assert.equal(result.records.get(300).title_ru, 'Нужное');
  assert.equal(result.records.has(100), false);
  assert.equal(result.records.has(400), false);
});

test('Shikimori cleanup removes raw HTML and entity-encoded tags from either field', () => {
  assert.equal(cleanSynopsis(null, 'Сырой <b>HTML</b> текст<br>дальше'), 'Сырой HTML текст\nдальше');
  assert.equal(cleanSynopsis('&lt;div&gt;Закодированные &lt;i&gt;теги&lt;/i&gt;&lt;/div&gt;', null), 'Закодированные теги');
  assert.equal(cleanSynopsis(null, '&lt;b&gt;Жирный&lt;/b&gt; [character=1]Имя[/character] &amp; ещё'), 'Жирный Имя & ещё');
});

test('AniList relations are null when AniList sends no edge list', () => {
  assert.equal(mapRelations(null), null);
  assert.equal(mapRelations(undefined), null);
  assert.deepEqual(mapRelations({ edges: [] }), []);
});

const neverResolvingBody = () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: () => new Promise(() => {}),
  text: () => new Promise(() => {})
});

test('AniList times out while the response body is still being read', async () => {
  const { client } = anilistClient(async () => neverResolvingBody(), { timeoutMs: 20 });
  const started = Date.now();
  const result = await client.fetchSeason('fall', 2026);
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.complete, false);
  assert.match(result.errors[0].message, /timed out/);
});

test('rate-limited fetches (Jikan, Shikimori) time out while the body is still being read', async () => {
  let signal;
  const limitedFetch = createRateLimiter(0, 0, 20, async (url, options) => {
    signal = options.signal;
    return neverResolvingBody();
  });
  const started = Date.now();
  await assert.rejects(limitedFetch('https://example.test/'), /timed out/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal.aborted, true);
});

test('rate-limited fetches return a fully read body', async () => {
  const limitedFetch = createRateLimiter(0, 0, 1000, async () => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => '{"a":1}'
  }));
  const res = await limitedFetch('https://example.test/');
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { a: 1 });
});

test('AniList stops a season whose pagination never ends and reports it incomplete', async () => {
  let requests = 0;
  const { client } = anilistClient(async () => {
    requests++;
    return response(200, seasonPage([], true));
  });

  const result = await client.fetchSeason('fall', 2026);

  assert.equal(result.complete, false);
  assert.match(result.errors[0].message, /pagination did not end/);
  assert.equal(requests, 40);
});

test('Jikan stops a season whose pagination never ends and reports it incomplete', async () => {
  const { fetchSeasonWith } = require('../src/services/jikan');
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  let requests = 0;
  try {
    const result = await fetchSeasonWith(async () => {
      requests++;
      return response(200, { data: [], pagination: { has_next_page: true } });
    }, 2026, 'fall');

    assert.equal(result.complete, false);
    assert.match(result.errors[0].message, /pagination did not end/);
    assert.equal(requests, 40);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
