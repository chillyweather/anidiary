let currentModalMalId = null;
let currentModalStatus = '';
const localeCatalog = JSON.parse(document.getElementById('localeCatalog')?.textContent || '{}');
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
const detailLoader = window.DetailLoader.createDetailLoader(fetchAnimeDetails);
let modalFocusController = null;

function jsonHeaders() {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

function showActionError(message) {
  let error = document.getElementById('actionError');
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
  showActionError.timeoutId = setTimeout(() => {
    error.hidden = true;
  }, 5000);
}

function setButtonPending(button, pending) {
  button.disabled = pending;
  button.setAttribute('aria-busy', pending ? 'true' : 'false');
}

function getCurrentLang() {
  const active = document.querySelector('.lang-toggle button.active');
  return active ? active.dataset.lang : 'en';
}

function uiText(key, values = {}) {
  const template = key.split('.').reduce((value, part) => value?.[part], localeCatalog) || key;
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template
  );
}

function formatSeasonLabel(seasonValue) {
  if (!seasonValue) return '';

  const [season, year] = String(seasonValue).split('_');
  if (!season || !year) return String(seasonValue);

  return `${localeCatalog.seasons?.[season] || season} ${year}`;
}

function translateAiringStatus(status) {
  return localeCatalog.airingStatuses?.[status] || status || '';
}

function translateRelation(relation) {
  return localeCatalog.relations?.[String(relation || '').toLowerCase()] || relation || '';
}

function formatEpisodeCount(count) {
  const numericCount = Number(count);
  if (localeCatalog.code !== 'ru') {
    const noun = numericCount === 1 ? localeCatalog.episodeForms[0] : localeCatalog.episodeForms[1];
    return `${count} ${noun}`;
  }
  const mod10 = numericCount % 10;
  const mod100 = numericCount % 100;
  let noun = localeCatalog.episodeForms[2];

  if (mod10 === 1 && mod100 !== 11) noun = localeCatalog.episodeForms[0];
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) noun = localeCatalog.episodeForms[1];

  return `${count} ${noun}`;
}

function getAnimeDisplayTitle(data) {
  const currentLang = getCurrentLang();

  if (currentLang === 'jp') {
    return data.title_jp || data.title_en || data.title_ru || '';
  }

  if (currentLang === 'ru') {
    return data.title_ru || data.title_en || data.title_jp || '';
  }

  return data.title_en || data.title_jp || data.title_ru || '';
}

function getCardByMalId(malId) {
  return document.querySelector(`.card[data-mal-id="${malId}"]`);
}

function updateCountdowns() {
  document.querySelectorAll('.countdown-timer').forEach(el => {
    const target = parseInt(el.dataset.timestamp, 10) * 1000;
    if (!target) return;
    const diff = target - Date.now();

    if (diff <= 0) {
      el.textContent = uiText('released');
      return;
    }

    const days = Math.floor(diff / 86400000);
    const hrs  = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);

    if (days > 0) {
      el.textContent = uiText('countdown.days', { days, hours: hrs });
    } else if (hrs > 0) {
      el.textContent = uiText('countdown.hours', { hours: hrs, minutes: mins });
    } else {
      el.textContent = uiText('countdown.minutes', { minutes: mins });
    }
  });
}

function setCardStatusClass(card, status) {
  card.classList.remove('card--following', 'card--watched');

  const statusClassMap = {
    following: 'card--following',
    watched: 'card--watched'
  };

  const className = statusClassMap[status];
  if (className) {
    card.classList.add(className);
  }
}

function initStatusButtons() {
  document.querySelectorAll('.card__actions button[data-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card    = btn.closest('.card');
      const malId   = parseInt(card.dataset.malId, 10);
      const status  = btn.dataset.status;
      const isActive = btn.classList.contains('active');
      const newStatus = isActive ? 'none' : status;

      try {
        setButtonPending(btn, true);
        const data = await postJson('/api/mark', { mal_id: malId, status: newStatus });

        if (data.ok) {
          btn.closest('.card__actions').querySelectorAll('button[data-status]').forEach(b => b.classList.remove('active'));
          if (newStatus !== 'none') {
            btn.classList.add('active');
          }
          setCardStatusClass(card, newStatus);
          card.dataset.followed   = newStatus !== 'none' ? 'true' : 'false';
          card.dataset.status     = newStatus !== 'none' ? newStatus : '';
          updateFollowingCount();
          if (typeof window.applyTabFilter === 'function') {
            window.applyTabFilter();
          }
          syncModalStatus(malId, newStatus);
        }
      } catch (err) {
        console.error('Failed to update status:', err);
        showActionError(err.message);
      } finally {
        setButtonPending(btn, false);
      }
    });
  });
}

function setJellyfinState(malId, available) {
  const card = getCardByMalId(malId);
  if (card) {
    card.classList.toggle('card--jellyfin', available);
    const button = card.querySelector('[data-jellyfin]');
    if (button) button.classList.toggle('active', available);
  }
  if (currentModalMalId === malId) {
    document.querySelector('#modalActions [data-jellyfin]')?.classList.toggle('active', available);
  }
  const cached = detailLoader.cache.get(malId);
  if (cached) cached.in_jellyfin = available;
}

function initJellyfinButtons() {
  document.querySelectorAll('[data-jellyfin]').forEach((button) => {
    button.addEventListener('click', async () => {
      const card = button.closest('.card');
      const malId = card ? Number(card.dataset.malId) : currentModalMalId;
      const available = !button.classList.contains('active');
      try {
        setButtonPending(button, true);
        const result = await postJson('/api/jellyfin', { mal_id: malId, available });
        if (result.ok) setJellyfinState(malId, result.available);
      } catch (error) {
        console.error('Failed to update Jellyfin availability:', error);
        showActionError(error.message);
      } finally {
        setButtonPending(button, false);
      }
    });
  });
}

function syncModalStatus(malId, status) {
  const cached = detailLoader.cache.get(malId);
  if (cached) {
    cached.user_status = status || null;
  }

  if (currentModalMalId !== malId) return;

  currentModalStatus = status || '';
  document.querySelectorAll('#modalActions button[data-status]').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.status === status) btn.classList.add('active');
  });
}

function setModalActionState(status) {
  document.querySelectorAll('#modalActions button[data-status]').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.status === status) btn.classList.add('active');
  });
}

function renderSeriesButton(button, target, label) {
  const labelEl = button.querySelector('.modal__series-label');
  const titleEl = button.querySelector('.modal__series-title');
  const metaEl = button.querySelector('.modal__series-meta');

  labelEl.textContent = label;

  if (!target) {
    button.hidden = true;
    button.disabled = false;
    button.dataset.malId = '';
    titleEl.textContent = '';
    metaEl.textContent = '';
    return;
  }

  button.hidden = false;
  button.dataset.malId = String(target.mal_id);
  titleEl.textContent = getAnimeDisplayTitle(target);
  metaEl.textContent = formatSeasonLabel(target.season) || target.season_label || '';
}

function renderSeriesNavigation(seriesNav) {
  const container = document.getElementById('modalSeriesNav');
  const prevBtn = document.getElementById('modalPrevSeries');
  const nextBtn = document.getElementById('modalNextSeries');

  renderSeriesButton(prevBtn, seriesNav?.previous || null, `← ${uiText('previousSeries')}`);
  renderSeriesButton(nextBtn, seriesNav?.next || null, `${uiText('nextSeries')} →`);

  container.hidden = prevBtn.hidden && nextBtn.hidden;
}

function setSeriesNavigationDisabled(disabled) {
  document.querySelectorAll('.modal__series-btn').forEach(btn => {
    if (!btn.hidden) {
      btn.disabled = disabled;
    }
  });
}

function renderModalData(data, userStatus) {
  const currentLang = getCurrentLang();

  currentModalMalId = data.mal_id;
  currentModalStatus = userStatus || '';

  const backdrop = document.getElementById('modalBackdrop');
  const title    = document.getElementById('modalTitle');
  const titleJp  = document.getElementById('modalTitleJp');
  const titleRu  = document.getElementById('modalTitleRu');
  const poster   = document.getElementById('modalPoster');
  const synEn    = document.getElementById('modalSynopsisEn');
  const synRu    = document.getElementById('modalSynopsisRu');
  const genres   = document.getElementById('modalGenres');
  const scores   = document.getElementById('modalScores');
  const related  = document.getElementById('modalRelated');
  const countdown= document.getElementById('modalCountdown');
  const statusBadge = document.getElementById('modalStatus');
  const episodes = document.getElementById('modalEpisodes');
  const state = document.getElementById('modalState');

  title.textContent = getAnimeDisplayTitle(data);
  titleJp.textContent = currentLang === 'jp' ? '' : (data.title_jp || '');
  titleRu.textContent = currentLang === 'ru' ? '' : (data.title_ru || '');
  poster.src = data.poster_url || '';
  poster.alt = title.textContent;

  if (currentLang === 'ru') {
    synRu.hidden = !data.synopsis_ru;
    synRu.textContent = data.synopsis_ru || '';
    synEn.hidden = Boolean(data.synopsis_ru) || !data.synopsis_en;
    synEn.textContent = data.synopsis_ru ? '' : (data.synopsis_en || '');
  } else {
    synEn.hidden = !(data.synopsis_en || data.synopsis_ru);
    synEn.textContent = data.synopsis_en || data.synopsis_ru || '';
    synRu.hidden = true;
    synRu.textContent = '';
  }

  genres.innerHTML = '';
  (data.genres || []).forEach(g => {
    const span = document.createElement('span');
    span.className = 'modal__genre';
    span.textContent = g;
    genres.appendChild(span);
  });

  scores.innerHTML = '';
  if (data.score_mal) {
    scores.innerHTML += `
      <a class="modal__score-item" href="https://myanimelist.net/anime/${data.mal_id}" target="_blank" rel="noopener">
        <span class="modal__score-label">MAL</span>
        <span class="modal__score-value modal__score-value--mal">${parseFloat(data.score_mal).toFixed(1)}</span>
      </a>`;
  }
  if (data.score_anilist && data.anilist_id) {
    scores.innerHTML += `
      <a class="modal__score-item" href="https://anilist.co/anime/${data.anilist_id}" target="_blank" rel="noopener">
        <span class="modal__score-label">AniList</span>
        <span class="modal__score-value modal__score-value--al">${data.score_anilist}</span>
      </a>`;
  }
  if (data.score_shiki) {
    scores.innerHTML += `
      <a class="modal__score-item" href="https://shikimori.one/animes/${data.mal_id}" target="_blank" rel="noopener">
        <span class="modal__score-label">Shikimori</span>
        <span class="modal__score-value modal__score-value--shiki">${parseFloat(data.score_shiki).toFixed(1)}</span>
      </a>`;
  }

  const now = Math.floor(Date.now() / 1000);
  if (data.next_ep_at && data.next_ep_at > now) {
    countdown.innerHTML = `<span class="countdown-timer" data-timestamp="${data.next_ep_at}">${uiText('loading')}</span>`;
    countdown.className = 'card__countdown';
    episodes.textContent = `${uiText('episode')} ${data.next_ep_num || '?'}/${data.episodes_total || '?'}`;
    episodes.hidden = false;
  } else {
    countdown.innerHTML = '';
    if (data.airing_status === 'Finished Airing') {
      countdown.innerHTML = `<span class="card__countdown countdown--released"><span>${uiText('released')}</span></span>`;
    } else if (data.airing_status === 'Not yet aired') {
      countdown.innerHTML = `<span class="card__countdown countdown--not-aired"><span>${uiText('notAired')}</span></span>`;
    } else {
      countdown.innerHTML = `<span class="card__countdown countdown--tba"><span>${uiText('tba')}</span></span>`;
    }
    episodes.textContent = formatEpisodeCount(data.episodes_total || '?');
    episodes.hidden = false;
  }
  statusBadge.textContent = translateAiringStatus(data.airing_status);
  statusBadge.hidden = !data.airing_status;

  related.innerHTML = '';
  if (data.related && data.related.length > 0) {
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'modal__section-title';
    sectionTitle.textContent = uiText('relatedSeries');
    related.appendChild(sectionTitle);
    const items = document.createElement('div');
    related.appendChild(items);
    window.ModalRendering.renderRelated(items, data.related, translateRelation);
  }

  renderSeriesNavigation(data.series_nav || null);
  setModalActionState(currentModalStatus);
  setJellyfinState(data.mal_id, Boolean(data.in_jellyfin));

  const hasAdditionalDetails = Boolean(
    data.synopsis_en || data.synopsis_ru || data.genres?.length || data.related?.length
    || data.score_mal || data.score_anilist || data.score_shiki
  );
  state.hidden = hasAdditionalDetails;
  state.dataset.state = hasAdditionalDetails ? 'success' : 'empty';
  state.textContent = hasAdditionalDetails ? '' : uiText('noDetails');
  document.getElementById('animeModal').setAttribute('aria-busy', 'false');

  backdrop.classList.add('open');
  document.body.classList.add('modal-open');
  updateCountdowns();
}

async function fetchAnimeDetails(malId) {
  const res = await fetch(`/api/anime/${malId}`);
  if (!res.ok) {
    throw new Error(`Failed to load anime ${malId}: ${res.status}`);
  }

  const data = await res.json();
  return data;
}

function showModalLoading(malId, status, { preserveNavigation = false } = {}) {
  currentModalMalId = malId;
  currentModalStatus = status || '';
  document.getElementById('modalTitle').textContent = '';
  document.getElementById('modalTitleJp').textContent = '';
  document.getElementById('modalTitleRu').textContent = '';
  document.getElementById('modalPoster').removeAttribute('src');
  document.getElementById('modalSynopsisEn').textContent = '';
  document.getElementById('modalSynopsisRu').textContent = '';
  document.getElementById('modalGenres').replaceChildren();
  document.getElementById('modalScores').replaceChildren();
  document.getElementById('modalRelated').replaceChildren();
  document.getElementById('modalCountdown').replaceChildren();
  document.getElementById('modalStatus').textContent = '';
  document.getElementById('modalEpisodes').textContent = '';
  if (!preserveNavigation) renderSeriesNavigation(null);
  setModalActionState(currentModalStatus);

  const state = document.getElementById('modalState');
  state.hidden = false;
  state.dataset.state = 'loading';
  state.textContent = uiText('loading');
  document.getElementById('animeModal').setAttribute('aria-busy', 'true');
  document.getElementById('modalBackdrop').classList.add('open');
  document.body.classList.add('modal-open');
}

async function hydrateModalData(malId, { focusAfterLoad = false } = {}) {
  const { requestId, promise } = detailLoader.begin(malId);
  setSeriesNavigationDisabled(true);

  try {
    const data = await promise;
    if (!detailLoader.isCurrent(requestId)) return;

    renderModalData(data, data.user_status);
    if (focusAfterLoad) modalFocusController.focusInitial();
  } catch (err) {
    if (detailLoader.isCurrent(requestId)) {
      console.error('Failed to load anime details:', err);
      const state = document.getElementById('modalState');
      state.hidden = false;
      state.dataset.state = 'error';
      state.textContent = uiText('loadDetailsFailed');
      document.getElementById('animeModal').setAttribute('aria-busy', 'false');
    }
  } finally {
    if (detailLoader.isCurrent(requestId)) {
      setSeriesNavigationDisabled(false);
    }
  }
}

function navigateModalTo(malId) {
  const card = getCardByMalId(malId);
  showModalLoading(malId, card?.dataset.status || '', { preserveNavigation: true });
  hydrateModalData(malId, { focusAfterLoad: true });
}

function openModal(card, opener) {
  const malId = parseInt(card.dataset.malId, 10);
  if (!malId) return;
  showModalLoading(malId, card.dataset.status || '');
  modalFocusController.open(opener);
  hydrateModalData(malId);
}

function hideModal() {
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.classList.remove('open');
  document.body.classList.remove('modal-open');
  currentModalMalId = null;
  currentModalStatus = '';
  detailLoader.cancel();
}

function closeModal() {
  if (modalFocusController) modalFocusController.close();
  else hideModal();
}

function initModal() {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('animeModal');
  const closeBtn = document.getElementById('modalClose');
  modalFocusController = window.ModalFocus.createModalFocus({ backdrop, modal, onClose: hideModal });

  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', modalFocusController.handleKeydown);

  document.querySelectorAll('.btn--more').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.card');
      openModal(card, btn);
    });
  });

  document.querySelectorAll('.modal__series-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetMalId = parseInt(btn.dataset.malId, 10);
      if (!targetMalId) return;

      navigateModalTo(targetMalId);
    });
  });

  document.getElementById('modalActions').querySelectorAll('button[data-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const malId     = currentModalMalId;
      const status   = btn.dataset.status;
      const isActive  = btn.classList.contains('active');
      const newStatus = isActive ? 'none' : status;

      try {
        setButtonPending(btn, true);
        const data = await postJson('/api/mark', { mal_id: malId, status: newStatus });
        if (data.ok) {
          const card = document.querySelector(`.card[data-mal-id="${malId}"]`);
          if (card) {
            card.querySelectorAll('.card__actions button[data-status]').forEach(b => b.classList.remove('active'));
            if (newStatus !== 'none') {
              btn.classList.add('active');
              const cardButton = card.querySelector(`.card__actions button[data-status="${newStatus}"]`);
              if (cardButton) cardButton.classList.add('active');
            }
            setCardStatusClass(card, newStatus);
            card.dataset.followed = newStatus !== 'none' ? 'true' : 'false';
            card.dataset.status   = newStatus !== 'none' ? newStatus : '';
            updateFollowingCount();
            if (typeof window.applyTabFilter === 'function') {
              window.applyTabFilter();
            }
          }
          syncModalStatus(malId, newStatus);
        }
      } catch (err) {
        console.error('Failed to update status:', err);
        showActionError(err.message);
      } finally {
        setButtonPending(btn, false);
      }
    });
  });
}

function initTabs() {
  const applyTabFilter = () => {
    const activeTab = document.querySelector('.tab.active');
    if (!activeTab) return;

    const tabType = activeTab.dataset.tab;
    document.querySelectorAll('.card').forEach(card => {
      const isFollowed = card.dataset.followed === 'true';
      const isCurrentSeason = card.dataset.inCurrentSeason !== 'false';

      if (tabType === 'all') {
        card.classList.toggle('card--hidden', !isCurrentSeason);
      } else {
        card.classList.toggle('card--hidden', !isFollowed);
      }
    });
  };

  window.applyTabFilter = applyTabFilter;

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      applyTabFilter();
    });
  });

  applyTabFilter();
}

function initSorting() {
  const sortSelect = document.getElementById('sort-select');
  if (!sortSelect) return;

  sortSelect.addEventListener('change', () => {
    const sortBy    = sortSelect.value;
    const container = document.querySelector('.card-grid');
    const cards     = Array.from(container.querySelectorAll('.card'));

    cards.sort((a, b) => {
      if (sortBy === 'title') {
        const tA = a.querySelector('.card__title').textContent;
        const tB = b.querySelector('.card__title').textContent;
        return tA.localeCompare(tB);
      }
      if (sortBy === 'next_ep') {
        return (parseInt(a.dataset.nextEpAt, 10) || 9999999999)
             - (parseInt(b.dataset.nextEpAt, 10) || 9999999999);
      }
      const scoreMap = {
        score_mal:     'scoreMal',
        score_anilist: 'scoreAnilist',
        score_shiki:   'scoreShiki'
      };
      const key = scoreMap[sortBy];
      const sA  = parseFloat(a.dataset[key]) || 0;
      const sB  = parseFloat(b.dataset[key]) || 0;
      return sB - sA;
    });

    cards.forEach(card => container.appendChild(card));
  });
}

function initLanguageToggle() {
  const setLanguage = async (lang) => {
    try {
      const res = await fetch('/api/lang', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ lang })
      });
      if (res.ok) window.location.reload();
    } catch (err) {
      console.error('Failed to change language:', err);
    }
  };

  document.querySelectorAll('.lang-toggle button').forEach(btn => {
    btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
  });

  document.querySelectorAll('.language-select').forEach(select => {
    select.addEventListener('change', () => setLanguage(select.value));
  });
}

function initSeasonSelect() {
  document.querySelectorAll('.season-select').forEach(select => {
    select.addEventListener('change', () => window.location.assign(select.value));
  });
}

function updateFollowingCount() {
  const tab = document.querySelector('.tab[data-tab="following"]');
  if (!tab) return;
  const count = document.querySelectorAll('.card[data-followed="true"]').length;
  tab.textContent = `${uiText('following')} (${count})`;
}

document.addEventListener('DOMContentLoaded', () => {
  updateCountdowns();
  setInterval(updateCountdowns, 1000);

  initStatusButtons();
  initJellyfinButtons();
  initModal();
  initTabs();
  initSorting();
  initLanguageToggle();
  initSeasonSelect();
});
