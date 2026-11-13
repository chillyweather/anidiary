// Season page wiring: one delegated click handler for the catalogue, the week
// strip and the detail dialog; filters and sort; minute-aligned countdowns.
//
// State lives in one per-title store (`titles`): counts, tabs, filters, sort and
// the week strip all read it, and every grid item is a rendering of a record.
// Writes are coordinated per title (`writes`): one status write and one
// Jellyfin write at a time, each completed write bumps a revision, and a detail
// payload never overwrites a value written after its request started.
(function startSeasonPage() {
  const { Catalogue, DetailLoader, ModalRendering, TitleItem } = window;
  const ui = JSON.parse(document.getElementById('localeCatalog')?.textContent || '{}');
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const detailLoader = DetailLoader.createDetailLoader(fetchAnimeDetails);
  const STORAGE_KEY = 'anidiary.view';
  const PERSISTED = ['tab', 'format', 'hideWatched', 'sort'];
  const TABS = ['all', 'following', 'watching'];

  const view = { tab: 'all', format: 'all', hideWatched: false, sort: 'popularity', query: '' };
  const titles = new Map();
  const writes = new Map();
  let currentModalMalId = null;
  // The dialog's actions are usable only once the open title's details loaded.
  let dialogReady = false;
  let dialogOpener = null;
  let dialogOpenerMalId = null;
  let weekSignature = '';

  const byId = (id) => document.getElementById(id);
  const catalogueEl = () => byId('catalogue');
  const dialog = () => byId('animeModal');
  const nowMs = () => Date.now();
  const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  function uiText(key, values = {}) {
    const template = key.split('.').reduce((value, part) => value?.[part], ui) ?? key;
    return Catalogue.fill(template, values);
  }

  // ─── Requests ──────────────────────────────────────────────

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  async function fetchAnimeDetails(malId) {
    const response = await fetch(`/api/anime/${malId}`);
    if (!response.ok) throw new Error(`Failed to load anime ${malId}: ${response.status}`);
    return response.json();
  }

  function showActionError(message) {
    let error = byId('actionError');
    if (!error) {
      error = document.createElement('div');
      error.id = 'actionError';
      error.className = 'action-error';
      error.setAttribute('role', 'alert');
      document.body.appendChild(error);
    }
    error.textContent = message;
    error.hidden = false;
    clearTimeout(showActionError.timeoutId);
    showActionError.timeoutId = setTimeout(() => { error.hidden = true; }, 5000);
  }

  // ─── Titles ────────────────────────────────────────────────

  function currentLang() {
    return document.querySelector('.lang-toggle [aria-pressed="true"]')?.dataset.lang || 'en';
  }

  function displayTitle(data) {
    const lang = currentLang();
    if (lang === 'jp') return data.title_jp || data.title_en || data.title_ru || '';
    if (lang === 'ru') return data.title_ru || data.title_en || data.title_jp || '';
    return data.title_en || data.title_jp || data.title_ru || '';
  }

  // Japanese titles in JP mode are marked so the right glyphs and voice are used.
  function titleLang(data) {
    return currentLang() === 'jp' && data.title_jp && displayTitle(data) === data.title_jp ? 'ja' : '';
  }

  const records = () => [...titles.values()];
  const itemFor = (malId) => titles.get(Number(malId))?.element || null;

  function writeStateFor(malId) {
    if (!writes.has(malId)) {
      writes.set(malId, {
        status: { pending: false, revision: 0, value: null },
        jellyfin: { pending: false, revision: 0, value: null }
      });
    }
    return writes.get(malId);
  }

  function register(element) {
    const record = readItem(element);
    titles.set(record.malId, record);
    return record;
  }

  function readItem(element) {
    const data = element.dataset;
    const title = element.querySelector('.title__open')?.textContent || '';
    return {
      element,
      malId: Number(data.malId),
      status: data.status || '',
      jellyfin: element.hasAttribute('data-jellyfin'),
      format: data.format || '',
      search: `${Catalogue.normalizeText(title)}\n${data.search || ''}`,
      inSeason: !element.hasAttribute('data-other-season'),
      popularity: Number(data.popularity) || 0,
      scoreMal: Number(data.scoreMal) || 0,
      scoreAnilist: Number(data.scoreAnilist) || 0,
      scoreShiki: Number(data.scoreShiki) || 0,
      nextEpAt: Number(data.nextEpAt) || 0,
      nextEp: data.nextEp || '',
      title,
      lang: element.querySelector('.title__open')?.lang || '',
      poster: element.querySelector('img.title__poster')?.getAttribute('src') || ''
    };
  }

  // ─── Filters, sort and counts ──────────────────────────────

  function loadPreferences() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      if (TABS.includes(saved.tab)) view.tab = saved.tab;
      if (['all', ...Object.keys(Catalogue.FORMAT_GROUPS)].includes(saved.format)) view.format = saved.format;
      if (typeof saved.hideWatched === 'boolean') view.hideWatched = saved.hideWatched;
      if (byId('sort-select')?.querySelector(`option[value="${saved.sort}"]`)) view.sort = saved.sort;
    } catch {
      // Storage may be unavailable (private mode, blocked); defaults apply.
    }
  }

  function savePreferences() {
    try {
      const saved = Object.fromEntries(PERSISTED.map((key) => [key, view[key]]));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Not remembered; the page still works.
    }
  }

  function syncControls() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.setAttribute('aria-pressed', String(tab.dataset.tab === view.tab));
    });
    const format = byId('format-filter');
    if (format) format.value = view.format;
    const hide = byId('hide-watched');
    if (hide) hide.checked = view.hideWatched;
    const sort = byId('sort-select');
    if (sort) sort.value = view.sort;
  }

  function applyView() {
    let visible = 0;
    for (const record of records()) {
      const shown = Catalogue.matches(record, view);
      record.element.hidden = !shown;
      if (shown) visible++;
    }
    const empty = byId('noMatch');
    const seasonHasTitles = records().some((record) => record.inSeason);
    if (empty) empty.hidden = visible > 0 || (view.tab === 'all' && !seasonHasTitles && !view.query);
  }

  // Reorders only when the order changed, keeping focus on the focused item.
  function applySort() {
    const list = catalogueEl();
    if (!list) return;
    const sorted = records().sort(Catalogue.comparator(view.sort, Math.floor(nowMs() / 1000), ui.intlLocale));
    const current = [...list.children];
    if (sorted.every((record, index) => record.element === current[index])) return;
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    for (const record of sorted) list.appendChild(record.element);
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  function updateTabCounts() {
    for (const status of ['following', 'watching']) {
      const count = document.querySelector(`.tab[data-tab="${status}"] .tab__count`);
      if (count) count.textContent = String(records().filter((record) => record.status === status).length);
    }
  }

  // ─── Countdowns ────────────────────────────────────────────

  const absoluteFormat = () => new Intl.DateTimeFormat(ui.intlLocale, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });

  const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function updateCountdowns() {
    const formatter = absoluteFormat();
    document.querySelectorAll('.cd[data-ts]').forEach((element) => {
      const seconds = Number(element.dataset.ts);
      if (!seconds) return;
      element.textContent = Catalogue.formatCountdown(seconds, nowMs(), ui.countdown || {}) || uiText('aired');
      if (!element.title) element.title = capitalize(formatter.format(new Date(seconds * 1000)));
    });
  }

  // One update per minute, aligned to the minute boundary.
  function scheduleMinuteTick() {
    const delay = 60000 - (nowMs() % 60000) + 50;
    setTimeout(() => {
      updateCountdowns();
      // An episode that has aired falls behind future ones.
      if (view.sort === 'next_ep') applySort();
      renderWeek();
      scheduleMinuteTick();
    }, delay);
  }

  // ─── Week strip ────────────────────────────────────────────

  const trackedEntries = () => records().filter((record) => Catalogue.TRACKED.includes(record.status));

  function weekEntryElement(entry, timeFormatter) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot';
    button.dataset.openId = String(entry.malId);
    button.dataset.status = entry.status;

    if (Catalogue.safeImageUrl(entry.poster)) {
      const image = document.createElement('img');
      image.className = 'slot__thumb';
      image.src = entry.poster;
      image.alt = '';
      image.width = 40;
      image.height = 60;
      image.loading = 'lazy';
      button.appendChild(image);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'slot__thumb';
      button.appendChild(placeholder);
    }

    const text = document.createElement('span');
    text.className = 'slot__text';
    const time = document.createElement('span');
    time.className = 'slot__time';
    time.textContent = timeFormatter.format(new Date(entry.nextEpAt * 1000));
    if (entry.nextEp) {
      const episode = document.createElement('span');
      episode.className = 'slot__ep';
      episode.textContent = uiText('episodeShort', { n: entry.nextEp });
      time.append(' ', episode);
    }
    const title = document.createElement('span');
    title.className = 'slot__title';
    title.textContent = entry.title;
    if (entry.lang) title.lang = entry.lang;
    text.append(time, title);
    button.appendChild(text);
    item.appendChild(button);
    return item;
  }

  function renderWeek({ force = false } = {}) {
    const days = byId('weekDays');
    const empty = byId('weekEmpty');
    if (!days || !empty) return;

    const tracked = trackedEntries();
    const zone = timeZone();
    const week = Catalogue.groupWeek(tracked, { now: nowMs(), timeZone: zone });
    const signature = JSON.stringify([
      currentLang(), week[0].key, tracked.length,
      week.map((day) => day.entries.map((entry) => [entry.malId, entry.nextEpAt, entry.status, entry.title]))
    ]);
    if (!force && signature === weekSignature) return;
    weekSignature = signature;

    const scheduled = week.reduce((count, day) => count + day.entries.length, 0);
    if (scheduled === 0) {
      days.hidden = true;
      days.replaceChildren();
      empty.hidden = false;
      empty.textContent = tracked.length ? uiText('weekQuiet') : uiText('weekEmpty');
      return;
    }

    const weekdayFormat = new Intl.DateTimeFormat(ui.intlLocale, { weekday: 'short', timeZone: 'UTC' });
    const dateFormat = new Intl.DateTimeFormat(ui.intlLocale, { day: 'numeric', timeZone: 'UTC' });
    const timeFormat = new Intl.DateTimeFormat(ui.intlLocale, { hour: '2-digit', minute: '2-digit', timeZone: zone });

    const columns = week.map((day) => {
      const column = document.createElement('li');
      column.className = 'day';
      if (day.isToday) column.setAttribute('aria-current', 'date');
      if (!day.entries.length) column.classList.add('day--quiet');

      const heading = document.createElement('h3');
      heading.className = 'day__head';
      const name = document.createElement('span');
      name.className = 'day__name';
      name.textContent = day.isToday ? uiText('today') : capitalize(weekdayFormat.format(day.date).replace('.', ''));
      const date = document.createElement('span');
      date.className = 'day__date';
      date.textContent = dateFormat.format(day.date);
      heading.append(name, ' ', date);
      column.appendChild(heading);

      if (day.entries.length) {
        const list = document.createElement('ul');
        list.className = 'day__slots';
        day.entries.forEach((entry) => list.appendChild(weekEntryElement(entry, timeFormat)));
        column.appendChild(list);
      } else {
        const none = document.createElement('p');
        none.className = 'day__none';
        none.textContent = uiText('noEpisodes');
        column.appendChild(none);
      }
      return column;
    });

    days.replaceChildren(...columns);
    days.hidden = false;
    empty.hidden = true;
  }

  // ─── Status and Jellyfin ───────────────────────────────────

  function setPressed(container, status) {
    container?.querySelectorAll('[data-set]:not([data-set="jellyfin"])').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.set === status));
    });
  }

  // Enables or disables a title's controls in the grid and, when it is the open
  // title, in the dialog: a group is disabled while its write is pending, and
  // the dialog's actions until the title's details have loaded.
  function syncWriteControls(malId) {
    const state = writeStateFor(malId);
    const groups = [itemFor(malId)?.querySelector('.title__acts')];
    if (currentModalMalId === malId) groups.push(byId('modalActions'));
    for (const group of groups) {
      if (!group) continue;
      const locked = group.id === 'modalActions' && !dialogReady;
      group.querySelectorAll('[data-set]').forEach((button) => {
        const pending = state[button.dataset.set === 'jellyfin' ? 'jellyfin' : 'status'].pending;
        button.disabled = locked || pending;
        button.setAttribute('aria-busy', String(pending));
      });
    }
  }

  // A title followed from the dialog that has no grid item gets one, rendered
  // like the server's (out of this season: listed only under its tab).
  function createItem(data, status) {
    const tree = TitleItem.titleTree(data, {
      status, partners: data.partners || [], langPref: currentLang(), ui,
      inSeason: false, eager: false, nowSeconds: Math.floor(nowMs() / 1000)
    });
    const element = TitleItem.toDom(tree, document);
    catalogueEl().appendChild(element);
    const record = register(element);
    updateCountdowns();
    applySort();
    return record;
  }

  function setTitleStatus(malId, status) {
    let record = titles.get(malId);
    const cached = detailLoader.cache.get(malId);
    if (cached) cached.user_status = status || null;
    if (!record && Catalogue.TRACKED.includes(status) && cached) record = createItem(cached, status);
    if (record) {
      record.status = status || '';
      record.element.dataset.status = record.status;
      setPressed(record.element.querySelector('.title__acts'), record.status);
    }
    if (currentModalMalId === malId && dialogReady) setPressed(byId('modalActions'), status || '');
    updateTabCounts();
    applyView();
    renderWeek();
  }

  function setTitleJellyfin(malId, available) {
    const record = titles.get(malId);
    if (record) {
      record.jellyfin = available;
      record.element.toggleAttribute('data-jellyfin', available);
      record.element.querySelector('[data-set="jellyfin"]')?.setAttribute('aria-pressed', String(available));
    }
    if (currentModalMalId === malId && dialogReady) {
      byId('modalActions').querySelector('[data-set="jellyfin"]').setAttribute('aria-pressed', String(available));
    }
    const cached = detailLoader.cache.get(malId);
    if (cached) cached.in_jellyfin = available;
  }

  // The request completes before any state changes; pressing the active
  // status clears it. One write per title and kind at a time: a second click
  // while one is pending is ignored.
  async function handleSetButton(button) {
    const inDialog = Boolean(button.closest('#modalActions'));
    if (inDialog && !dialogReady) return;
    const malId = inDialog ? currentModalMalId : Number(button.closest('.title')?.dataset.malId);
    if (!malId) return;
    const kind = button.dataset.set === 'jellyfin' ? 'jellyfin' : 'status';
    const state = writeStateFor(malId)[kind];
    if (state.pending) return;
    const pressed = button.getAttribute('aria-pressed') === 'true';

    state.pending = true;
    syncWriteControls(malId);
    try {
      if (kind === 'jellyfin') {
        const result = await postJson('/api/jellyfin', { mal_id: malId, available: !pressed });
        state.revision++;
        state.value = result.available;
        setTitleJellyfin(malId, result.available);
      } else {
        const result = await postJson('/api/mark', { mal_id: malId, status: pressed ? 'none' : button.dataset.set });
        state.revision++;
        state.value = result.status || '';
        setTitleStatus(malId, state.value);
      }
    } catch (error) {
      console.error('Failed to update status:', error);
      showActionError(error.message);
    } finally {
      state.pending = false;
      syncWriteControls(malId);
    }
  }

  // ─── Detail dialog ─────────────────────────────────────────

  function clearDialog() {
    for (const id of ['modalTitle', 'modalTitleJp', 'modalTitleRu', 'modalSynopsisEn', 'modalSynopsisRu',
      'modalCountdown', 'modalStatus', 'modalEpisodes']) {
      byId(id).textContent = '';
    }
    byId('modalPoster').removeAttribute('src');
    for (const id of ['modalGenres', 'modalScores', 'modalRelated', 'modalPartners']) byId(id).replaceChildren();
    byId('modalPartners').hidden = true;
  }

  function setDialogState(state, text) {
    const element = byId('modalState');
    element.dataset.state = state;
    element.textContent = text || '';
    element.hidden = !text;
    dialog().setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  }

  function renderSeriesButton(button, target, label) {
    button.querySelector('.detail__series-label').textContent = label;
    if (!target) {
      button.hidden = true;
      delete button.dataset.openId;
      button.querySelector('.detail__series-title').textContent = '';
      button.querySelector('.detail__series-meta').textContent = '';
      return;
    }
    button.hidden = false;
    button.dataset.openId = String(target.mal_id);
    button.querySelector('.detail__series-title').textContent = displayTitle(target);
    const [season, year] = String(target.season || '').split('_');
    button.querySelector('.detail__series-meta').textContent =
      season && year ? `${ui.seasons?.[season] || season} ${year}` : (target.season_label || '');
  }

  function renderSeriesNavigation(seriesNav) {
    const previous = byId('modalPrevSeries');
    const next = byId('modalNextSeries');
    renderSeriesButton(previous, seriesNav?.previous || null, uiText('previousSeries'));
    renderSeriesButton(next, seriesNav?.next || null, uiText('nextSeries'));
    byId('modalSeriesNav').hidden = previous.hidden && next.hidden;
  }

  function scoreLink(label, value, href) {
    const link = document.createElement('a');
    link.className = 'score-link';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    const name = document.createElement('span');
    name.textContent = label;
    const number = document.createElement('b');
    number.textContent = value;
    link.append(name, ' ', number);
    return link;
  }

  function renderDetail(data) {
    const lang = currentLang();
    currentModalMalId = data.mal_id;

    const title = displayTitle(data);
    byId('modalTitle').textContent = title;
    if (titleLang(data)) byId('modalTitle').lang = 'ja';
    else byId('modalTitle').removeAttribute('lang');
    byId('modalTitleJp').textContent = lang === 'jp' || data.title_jp === title ? '' : (data.title_jp || '');
    byId('modalTitleRu').textContent = lang === 'ru' || data.title_ru === title ? '' : (data.title_ru || '');
    const poster = byId('modalPoster');
    if (Catalogue.safeImageUrl(data.poster_url)) poster.src = data.poster_url;
    else poster.removeAttribute('src');

    const synopsisEn = byId('modalSynopsisEn');
    const synopsisRu = byId('modalSynopsisRu');
    const preferRu = lang === 'ru' && data.synopsis_ru;
    synopsisRu.textContent = preferRu ? data.synopsis_ru : '';
    synopsisRu.hidden = !preferRu;
    synopsisEn.textContent = preferRu ? '' : (data.synopsis_en || data.synopsis_ru || '');
    synopsisEn.hidden = !synopsisEn.textContent;

    const genres = byId('modalGenres');
    genres.replaceChildren(...(data.genres || []).map((genre) => {
      const item = document.createElement('li');
      item.textContent = genre;
      return item;
    }));
    genres.hidden = !genres.children.length;

    const scores = byId('modalScores');
    const links = [];
    if (data.score_mal) links.push(scoreLink('MAL', Number(data.score_mal).toFixed(1), `https://myanimelist.net/anime/${Number(data.mal_id)}`));
    if (data.score_anilist && data.anilist_id) links.push(scoreLink('AniList', String(data.score_anilist), `https://anilist.co/anime/${Number(data.anilist_id)}`));
    if (data.score_shiki) links.push(scoreLink('Shikimori', Number(data.score_shiki).toFixed(1), `https://shikimori.io/animes/${Number(data.mal_id)}`));
    scores.replaceChildren(...links);
    scores.hidden = !links.length;

    const countdown = byId('modalCountdown');
    const episodes = byId('modalEpisodes');
    countdown.replaceChildren();
    if (data.next_ep_at && data.next_ep_at * 1000 > nowMs()) {
      const timer = document.createElement('span');
      timer.className = 'cd';
      timer.dataset.ts = String(data.next_ep_at);
      const when = document.createElement('span');
      when.className = 'detail__date';
      when.textContent = capitalize(absoluteFormat().format(new Date(data.next_ep_at * 1000)));
      countdown.append(when, ' ', timer);
      episodes.textContent = uiText('episodeProgress', { n: data.next_ep_num || '?', total: data.episodes_total || '?' });
    } else {
      countdown.textContent = data.airing_status === 'Finished Airing' ? uiText('finished')
        : data.airing_status === 'Not yet aired' ? uiText('notAired') : uiText('tba');
      episodes.textContent = data.episodes_total ? formatEpisodeCount(data.episodes_total) : '';
    }
    byId('modalStatus').textContent = ui.airingStatuses?.[data.airing_status] || data.airing_status || '';

    const partners = byId('modalPartners');
    partners.replaceChildren(...(data.partners || []).map((partner) => {
      const chip = document.createElement('span');
      chip.className = 'chip chip--labelled';
      chip.dataset.status = partner.status;
      const initial = document.createElement('span');
      initial.className = 'chip__initial';
      initial.setAttribute('aria-hidden', 'true');
      initial.textContent = String(partner.username || '?').charAt(0).toUpperCase();
      const text = document.createElement('span');
      text.textContent = uiText('partnerStatus', { name: partner.username, status: ui.partnerStates?.[partner.status] || partner.status });
      chip.append(initial, text);
      return chip;
    }));
    partners.hidden = !partners.children.length;

    const related = byId('modalRelated');
    related.replaceChildren();
    if (data.related?.some((relation) => relation?.entries?.length)) {
      const heading = document.createElement('h3');
      heading.className = 'detail__section';
      heading.textContent = uiText('relatedSeries');
      const list = document.createElement('ul');
      list.className = 'related';
      ModalRendering.renderRelated(list, data.related, translateRelation, document, displayTitle);
      related.append(heading, list);
    }

    renderSeriesNavigation(data.series_nav || null);
    dialogReady = true;
    setPressed(byId('modalActions'), data.user_status || '');
    byId('modalActions').querySelector('[data-set="jellyfin"]').setAttribute('aria-pressed', String(Boolean(data.in_jellyfin)));
    syncWriteControls(data.mal_id);

    const hasDetails = Boolean(data.synopsis_en || data.synopsis_ru || data.genres?.length || data.related?.length
      || data.score_mal || data.score_anilist || data.score_shiki);
    setDialogState(hasDetails ? 'success' : 'empty', hasDetails ? '' : uiText('noDetails'));
    updateCountdowns();
  }

  function translateRelation(relation) {
    return ui.relations?.[String(relation || '').toLowerCase()] || relation || '';
  }

  const formatEpisodeCount = (count) => Catalogue.formatEpisodeCount(count, ui);

  // Nothing of the previous title's actions survives: every action is reset
  // and disabled until this title's details arrive (and stays so on failure).
  function showLoading(malId, { keepNavigation = false } = {}) {
    currentModalMalId = malId;
    dialogReady = false;
    clearDialog();
    if (!keepNavigation) renderSeriesNavigation(null);
    byId('modalActions').querySelectorAll('[data-set]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    syncWriteControls(malId);
    setDialogState('loading', uiText('loading'));
  }

  // A detail payload is authoritative except for values written after its
  // request started; those keep the newer value (in the payload and the cache).
  function keepNewerWrites(data, startRevisions) {
    const state = writeStateFor(data.mal_id);
    if (state.status.revision !== startRevisions.status) data.user_status = state.status.value || null;
    if (state.jellyfin.revision !== startRevisions.jellyfin) data.in_jellyfin = state.jellyfin.value;
  }

  function reconcile(data, startRevisions) {
    keepNewerWrites(data, startRevisions);
    setTitleJellyfin(data.mal_id, Boolean(data.in_jellyfin));
    if ((titles.get(data.mal_id)?.status || '') !== (data.user_status || '')) setTitleStatus(data.mal_id, data.user_status || '');
  }

  async function loadDetail(malId, { focusTitle = false } = {}) {
    const state = writeStateFor(malId);
    const startRevisions = { status: state.status.revision, jellyfin: state.jellyfin.revision };
    const { requestId, promise } = detailLoader.begin(malId);
    const navButtons = [...document.querySelectorAll('.detail__series-btn:not([hidden])')];
    navButtons.forEach((button) => { button.disabled = true; });
    try {
      const data = await promise;
      // Corrected even when the dialog has moved on or closed: the payload is
      // cached, and a stale one would undo a newer write when it is reopened.
      keepNewerWrites(data, startRevisions);
      if (!detailLoader.isCurrent(requestId)) return;
      reconcile(data, startRevisions);
      renderDetail(data);
      if (focusTitle) byId('modalTitle').focus();
    } catch (error) {
      if (!detailLoader.isCurrent(requestId)) return;
      console.error('Failed to load anime details:', error);
      setDialogState('error', uiText('loadDetailsFailed'));
      syncWriteControls(malId);
    } finally {
      if (detailLoader.isCurrent(requestId)) navButtons.forEach((button) => { button.disabled = false; });
    }
  }

  function openDetail(malId, opener) {
    if (!malId) return;
    const element = dialog();
    if (element.open) {
      showLoading(malId, { keepNavigation: true });
      loadDetail(malId, { focusTitle: true });
      return;
    }
    dialogOpener = opener || document.activeElement;
    dialogOpenerMalId = malId;
    showLoading(malId);
    element.showModal();
    loadDetail(malId);
  }

  const focusable = (element) => Boolean(element?.isConnected && !element.closest('[hidden]') && !element.disabled);

  // Esc, the close button and a backdrop click all end in the native close
  // event. Focus returns to the opener if it is still on the page and visible;
  // otherwise to the same title's button in the grid; otherwise the active tab.
  function onDialogClose() {
    currentModalMalId = null;
    dialogReady = false;
    detailLoader.cancel();
    const candidates = [
      dialogOpener,
      itemFor(dialogOpenerMalId)?.querySelector('.title__open'),
      document.querySelector('.tab[aria-pressed="true"]')
    ];
    dialogOpener = null;
    dialogOpenerMalId = null;
    candidates.find(focusable)?.focus();
  }

  // ─── Language ──────────────────────────────────────────────

  async function setLanguage(lang) {
    try {
      const response = await fetch('/api/lang', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ lang })
      });
      if (response.ok) window.location.reload();
    } catch (error) {
      console.error('Failed to change language:', error);
    }
  }

  // ─── Events ────────────────────────────────────────────────

  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const element = dialog();
    if (target === element) { element.close(); return; }
    if (target.closest('#modalClose')) { element.close(); return; }

    const setButton = target.closest('button[data-set]');
    if (setButton) { handleSetButton(setButton); return; }

    const openButton = target.closest('[data-open-id]');
    if (openButton) { openDetail(Number(openButton.dataset.openId), openButton); return; }

    const title = target.closest('.title');
    if (title && (target.closest('.title__open') || target.closest('.title__poster'))) {
      openDetail(Number(title.dataset.malId), title.querySelector('.title__open'));
      return;
    }

    const tab = target.closest('.tab');
    if (tab) {
      view.tab = tab.dataset.tab;
      syncControls();
      savePreferences();
      applyView();
      return;
    }

    const lang = target.closest('.lang-toggle [data-lang]');
    if (lang && lang.getAttribute('aria-pressed') !== 'true') setLanguage(lang.dataset.lang);
  }

  function onChange(event) {
    const { id } = event.target;
    if (id === 'format-filter') view.format = event.target.value;
    else if (id === 'hide-watched') view.hideWatched = event.target.checked;
    else if (id === 'sort-select') { view.sort = event.target.value; applySort(); }
    else return;
    savePreferences();
    applyView();
  }

  function onInput(event) {
    if (event.target.id !== 'title-search') return;
    view.query = event.target.value;
    applyView();
  }

  // A poster that fails to load becomes the neutral placeholder.
  function onImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches('.title__poster, .slot__thumb')) return;
    const placeholder = document.createElement('span');
    placeholder.className = image.className;
    image.replaceWith(placeholder);
    const record = titles.get(Number(placeholder.closest('.title')?.dataset.malId));
    if (record && image.classList.contains('title__poster')) record.poster = '';
  }

  function init() {
    catalogueEl()?.querySelectorAll(':scope > .title').forEach(register);
    loadPreferences();
    syncControls();
    if (view.sort !== 'popularity') applySort();
    applyView();
    updateCountdowns();
    renderWeek({ force: true });
    scheduleMinuteTick();

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('error', onImageError, true);
    dialog()?.addEventListener('close', onDialogClose);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
