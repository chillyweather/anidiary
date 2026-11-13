// One rendering path for a catalogue item. titleTree() describes the item as
// a small element tree; the server serializes it to escaped HTML (toHtml) and
// the browser builds the same markup with DOM APIs and textContent (toDom), so
// server-rendered and client-created items cannot drift apart.
(function exposeTitleItem(root, factory) {
  const catalogue = typeof module === 'object' && module.exports ? require('./catalogue') : root.Catalogue;
  const api = factory(catalogue);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TitleItem = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTitleItem(Catalogue) {
  const STATUS_BUTTONS = [['following', 'follow'], ['watching', 'watching'], ['watched', 'watched']];

  // Node: [tag, [[name, value], ...], ...children]; a child string is text.
  // An attribute value of true renders bare; null, undefined or false is left out.
  const el = (tag, attrs, ...children) => [tag, attrs.filter(([, value]) => value !== null && value !== undefined && value !== false), ...children];

  function displayTitle(anime, langPref) {
    if (langPref === 'jp') return anime.title_jp || anime.title_en || anime.title_ru || '';
    if (langPref === 'ru') return anime.title_ru || anime.title_en || anime.title_jp || '';
    return anime.title_en || anime.title_jp || anime.title_ru || '';
  }

  // anime: a stored anime row or the detail API payload.
  // options: { status, partners, langPref, ui, inSeason, eager, nowSeconds }
  function titleTree(anime, { status = '', partners = [], langPref = 'en', ui, inSeason = true, eager = false, nowSeconds }) {
    const name = displayTitle(anime, langPref);
    const upcoming = Number(anime.next_ep_at) > nowSeconds;
    const scores = [
      ['MAL', anime.score_mal && Number(anime.score_mal).toFixed(1)],
      ['AL', anime.score_anilist],
      ['Shiki', anime.score_shiki && Number(anime.score_shiki).toFixed(1)]
    ].filter(([, value]) => value);
    const airingLabel = anime.airing_status === 'Finished Airing' ? ui.finished
      : anime.airing_status === 'Not yet aired' ? ui.notAired : ui.tba;
    const partnerText = (other) => Catalogue.fill(ui.partnerStatus, { name: other.username, status: ui.partnerStates[other.status] });

    const meta = upcoming
      ? [
        el('span', [['class', 'cd'], ['data-ts', anime.next_ep_at]], Catalogue.formatCountdown(anime.next_ep_at, nowSeconds * 1000, ui.countdown)),
        ' ',
        el('span', [], Catalogue.fill(ui.episodeProgress, { n: anime.next_ep_num || '?', total: anime.episodes_total || '?' }))
      ]
      : [
        el('span', [], airingLabel),
        ...(anime.episodes_total ? [' ', el('span', [], Catalogue.formatEpisodeCount(anime.episodes_total, ui))] : [])
      ];

    const children = [
      anime.poster_url
        ? el('img', [['class', 'title__poster'], ['src', anime.poster_url], ['alt', ''], ['width', '200'], ['height', '300'], ['loading', eager ? null : 'lazy']])
        : el('span', [['class', 'title__poster']]),
      el('button', [['class', 'title__open'], ['aria-haspopup', 'dialog'],
        ['lang', langPref === 'jp' && anime.title_jp && name === anime.title_jp ? 'ja' : null]], name),
      el('p', [['class', 'title__meta']], ...meta)
    ];
    if (scores.length) {
      children.push(el('p', [['class', 'title__scores']],
        ...scores.map(([label, value]) => el('span', [], `${label} `, el('b', [], String(value))))));
    }
    if (partners.length) {
      children.push(el('span', [['class', 'title__partners']], ...partners.map((other) => el('span',
        [['class', 'chip'], ['data-status', other.status], ['title', partnerText(other)]],
        el('span', [['aria-hidden', 'true']], String(other.username).charAt(0).toUpperCase()),
        el('span', [['class', 'vh']], partnerText(other))))));
    }
    children.push(el('div', [['class', 'title__acts']],
      el('span', [['class', 'seg']], ...STATUS_BUTTONS.map(([value, key]) => el('button',
        [['data-set', value], ['aria-pressed', String(status === value)], ['aria-label', ui[key]]]))),
      el('button', [['data-set', 'jellyfin'], ['aria-pressed', String(Boolean(anime.in_jellyfin))], ['aria-label', ui.inJellyfin]])));

    return el('li', [
      ['class', 'title'], ['data-mal-id', anime.mal_id], ['data-status', status || ''],
      ['data-format', anime.format || ''], ['data-popularity', anime.popularity || 0],
      ['data-score-mal', anime.score_mal || null], ['data-score-anilist', anime.score_anilist || null],
      ['data-score-shiki', anime.score_shiki || null],
      ['data-next-ep-at', upcoming ? anime.next_ep_at : null], ['data-next-ep', upcoming ? (anime.next_ep_num || '') : null],
      ['data-search', Catalogue.searchText(anime, name)],
      ['data-jellyfin', Boolean(anime.in_jellyfin)],
      ['data-other-season', !inSeason], ['hidden', !inSeason]
    ], ...children);
  }

  const VOID = new Set(['img']);
  const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttribute = (value) => escapeText(value).replace(/"/g, '&#34;');

  // Top-level children of the item are separated by newlines, like a template.
  function toHtml(node, depth = 0) {
    if (typeof node === 'string') return escapeText(node);
    const [tag, attrs, ...children] = node;
    const attributes = attrs.map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`)).join('');
    if (VOID.has(tag)) return `<${tag}${attributes}>`;
    const inner = children.map((child) => toHtml(child, depth + 1)).join(depth === 0 ? '\n' : '');
    return depth === 0 ? `<${tag}${attributes}>\n${inner}\n</${tag}>` : `<${tag}${attributes}>${inner}</${tag}>`;
  }

  function toDom(node, documentRef) {
    if (typeof node === 'string') return documentRef.createTextNode(node);
    const [tag, attrs, ...children] = node;
    const element = documentRef.createElement(tag);
    for (const [name, value] of attrs) element.setAttribute(name, value === true ? '' : String(value));
    for (const child of children) element.appendChild(toDom(child, documentRef));
    return element;
  }

  return { titleTree, toHtml, toDom, displayTitle };
});
