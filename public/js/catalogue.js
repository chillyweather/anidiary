// Pure catalogue logic shared by the browser (window.Catalogue), the server
// views and the tests: search/format/tab filtering, sort order, countdown text
// and grouping tracked episodes into the viewer's week.
(function exposeCatalogue(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Catalogue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCatalogue() {
  const FORMAT_GROUPS = Object.freeze({
    tv: ['tv', 'tv_short'],
    movie: ['movie'],
    other: ['ova', 'ona', 'special', 'music', '']
  });
  const TRACKED = ['following', 'watching'];
  const DAY_MS = 86400000;

  // Lower-case, NFKC (full-width to ASCII), and ё → е so Russian searches match.
  function normalizeText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').trim();
  }

  // The other titles of an anime for search; the displayed one is left out
  // because the page already carries it (the item's title button).
  function searchText(anime, displayed = '') {
    const shown = normalizeText(displayed);
    const titles = [anime.title_en, anime.title_jp, anime.title_ru].map(normalizeText)
      .filter((title) => title && title !== shown);
    return [...new Set(titles)].join('\n');
  }

  // item: { status, format, search, inSeason }
  // view: { tab: 'all'|'following'|'watching', format, hideWatched, query }
  function matches(item, view) {
    const tab = view.tab || 'all';
    if (tab === 'all') {
      if (!item.inSeason) return false;
    } else if (item.status !== tab) {
      return false;
    }
    if (view.hideWatched && item.status === 'watched') return false;

    const format = view.format || 'all';
    if (format !== 'all') {
      const group = FORMAT_GROUPS[format];
      if (group && !group.includes(item.format || '')) return false;
    }

    const query = normalizeText(view.query);
    if (query && !String(item.search || '').includes(query)) return false;
    return true;
  }

  const SCORE_KEYS = Object.freeze({
    popularity: 'popularity', score_mal: 'scoreMal', score_anilist: 'scoreAnilist', score_shiki: 'scoreShiki'
  });

  // Returns a comparator over { popularity, scoreMal, scoreAnilist, scoreShiki,
  // nextEpAt (seconds), title }. "next_ep" puts titles with a future episode
  // first, soonest first; everything else follows in popularity order.
  function comparator(sort, nowSeconds, locale) {
    const byPopularity = (a, b) => (b.popularity || 0) - (a.popularity || 0);
    if (sort === 'title') {
      return (a, b) => String(a.title || '').localeCompare(String(b.title || ''), locale, { sensitivity: 'base' });
    }
    if (sort === 'next_ep') {
      return (a, b) => {
        const aNext = a.nextEpAt > nowSeconds ? a.nextEpAt : Infinity;
        const bNext = b.nextEpAt > nowSeconds ? b.nextEpAt : Infinity;
        if (aNext !== bNext) return aNext < bNext ? -1 : 1;
        return byPopularity(a, b);
      };
    }
    const key = SCORE_KEYS[sort] || 'popularity';
    return (a, b) => ((b[key] || 0) - (a[key] || 0)) || byPopularity(a, b);
  }

  function fill(template, values) {
    return Object.entries(values).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      String(template || '')
    );
  }

  // Relative countdown such as "in 2d 4h"; null once the time has passed.
  function formatCountdown(targetSeconds, nowMs, templates) {
    const diff = targetSeconds * 1000 - nowMs;
    if (!(diff > 0)) return null;
    const days = Math.floor(diff / DAY_MS);
    const hours = Math.floor((diff % DAY_MS) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return fill(templates.days, { days, hours });
    if (hours > 0) return fill(templates.hours, { hours, minutes });
    return fill(templates.minutes, { minutes: Math.max(1, minutes) });
  }

  function dayKey(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(ms));
    const part = (type) => parts.find((entry) => entry.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  // Groups entries ({ nextEpAt: seconds, ... }) into `days` local days starting
  // today in `timeZone`. Each day: { key: 'YYYY-MM-DD', date (UTC noon of that
  // calendar day, for formatting with timeZone 'UTC'), isToday, entries }.
  // Entries already aired or beyond the last day are left out.
  function groupWeek(entries, { now, timeZone, days = 7 } = {}) {
    const today = dayKey(now, timeZone);
    const [year, month, day] = today.split('-').map(Number);
    const week = [];
    const byKey = new Map();
    for (let offset = 0; offset < days; offset++) {
      const date = new Date(Date.UTC(year, month - 1, day + offset, 12));
      const key = date.toISOString().slice(0, 10);
      const entry = { key, date, isToday: offset === 0, entries: [] };
      week.push(entry);
      byKey.set(key, entry);
    }
    for (const item of entries) {
      const at = Number(item.nextEpAt) * 1000;
      if (!(at > now)) continue;
      const target = byKey.get(dayKey(at, timeZone));
      if (target) target.entries.push(item);
    }
    for (const entry of week) entry.entries.sort((a, b) => a.nextEpAt - b.nextEpAt);
    return week;
  }

  // "12 episodes" / "12 серий": English singular/plural, Russian three forms.
  function formatEpisodeCount(count, catalog) {
    const number = Number(count);
    const forms = catalog.episodeForms;
    if (catalog.code !== 'ru') return `${count} ${number === 1 ? forms[0] : forms[1]}`;
    const mod10 = number % 10;
    const mod100 = number % 100;
    const index = mod10 === 1 && mod100 !== 11
      ? 0
      : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 1 : 2);
    return `${count} ${forms[index]}`;
  }

  // Poster URLs come from third-party providers: only https or a same-origin path is used.
  function safeImageUrl(url) {
    return typeof url === 'string' && /^(https:\/\/|\/(?!\/))/i.test(url) ? url : '';
  }

  return {
    safeImageUrl,
    FORMAT_GROUPS, TRACKED, normalizeText, searchText, matches, comparator, formatCountdown, groupWeek, dayKey, fill,
    formatEpisodeCount
  };
});
