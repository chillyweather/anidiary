let currentModalMalId = null;
let currentModalStatus = '';
let currentModalRequestId = 0;
const modalAnimeCache = new Map();

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function getCurrentLang() {
  const active = document.querySelector('.lang-toggle button.active');
  return active ? active.dataset.lang : 'en';
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

function parseCardModalData(card) {
  const raw = card?.dataset.modal;
  if (!raw) return null;

  try {
    return JSON.parse(decodeBase64Utf8(raw));
  } catch (err) {
    console.error('Failed to parse modal data:', err);
    return null;
  }
}

function updateCountdowns() {
  document.querySelectorAll('.countdown-timer').forEach(el => {
    const target = parseInt(el.dataset.timestamp, 10) * 1000;
    if (!target) return;
    const diff = target - Date.now();

    if (diff <= 0) {
      el.textContent = 'Released';
      return;
    }

    const days = Math.floor(diff / 86400000);
    const hrs  = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);

    if (days > 0) {
      el.textContent = `in ${days}d ${hrs}h`;
    } else if (hrs > 0) {
      el.textContent = `in ${hrs}h ${mins}m`;
    } else {
      el.textContent = `in ${mins}m`;
    }
  });
}

function setCardStatusClass(card, status) {
  card.classList.remove('card--following', 'card--jellyfin', 'card--watched', 'card--in_jellyfin');

  const statusClassMap = {
    following: 'card--following',
    in_jellyfin: 'card--jellyfin',
    watched: 'card--watched'
  };

  const className = statusClassMap[status];
  if (className) {
    card.classList.add(className);
  }
}

function initStatusButtons() {
  document.querySelectorAll('.card__actions button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card    = btn.closest('.card');
      const malId   = parseInt(card.dataset.malId, 10);
      const status  = btn.dataset.status;
      const isActive = btn.classList.contains('active');
      const newStatus = isActive ? 'none' : status;

      try {
        const res  = await fetch('/api/mark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mal_id: malId, status: newStatus })
        });
        const data = await res.json();

        if (data.ok) {
          btn.closest('.card__actions').querySelectorAll('button').forEach(b => b.classList.remove('active'));
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
      }
    });
  });
}

function syncModalStatus(malId, status) {
  const cached = modalAnimeCache.get(malId);
  if (cached) {
    cached.user_status = status || null;
  }

  if (currentModalMalId !== malId) return;

  currentModalStatus = status || '';
  document.querySelectorAll('#modalActions button').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.status === status) btn.classList.add('active');
  });
}

function setModalActionState(status) {
  document.querySelectorAll('#modalActions button').forEach(btn => {
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
  metaEl.textContent = target.season_label || '';
}

function renderSeriesNavigation(seriesNav) {
  const container = document.getElementById('modalSeriesNav');
  const prevBtn = document.getElementById('modalPrevSeries');
  const nextBtn = document.getElementById('modalNextSeries');

  renderSeriesButton(prevBtn, seriesNav?.previous || null, '← Previous');
  renderSeriesButton(nextBtn, seriesNav?.next || null, 'Next →');

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

  title.textContent = getAnimeDisplayTitle(data);
  titleJp.textContent = currentLang === 'jp' ? '' : (data.title_jp || '');
  titleRu.textContent = currentLang === 'ru' ? '' : (data.title_ru || '');
  poster.src = data.poster_url || '';
  poster.alt = title.textContent;

  if (currentLang === 'ru') {
    synRu.style.display = data.synopsis_ru ? 'block' : 'none';
    synRu.textContent = data.synopsis_ru || '';
    synEn.style.display = data.synopsis_ru ? 'none' : (data.synopsis_en ? 'block' : 'none');
    synEn.textContent = data.synopsis_ru ? '' : (data.synopsis_en || '');
  } else {
    synEn.style.display = data.synopsis_en ? 'block' : (data.synopsis_ru ? 'block' : 'none');
    synEn.textContent = data.synopsis_en || data.synopsis_ru || '';
    synRu.style.display = 'none';
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
    countdown.innerHTML = `<span class="countdown-timer" data-timestamp="${data.next_ep_at}">loading…</span>`;
    countdown.className = 'card__countdown';
    episodes.textContent = `Episode ${data.next_ep_num || '?'}/${data.episodes_total || '?'}`;
    episodes.style.display = 'inline';
  } else {
    countdown.innerHTML = '';
    if (data.airing_status === 'Finished Airing') {
      countdown.innerHTML = '<span class="card__countdown countdown--released"><span>Released</span></span>';
    } else if (data.airing_status === 'Not yet aired') {
      countdown.innerHTML = '<span class="card__countdown countdown--not-aired"><span>Not aired</span></span>';
    } else {
      countdown.innerHTML = '<span class="card__countdown countdown--tba"><span>TBA</span></span>';
    }
    episodes.textContent = `${data.episodes_total || '?'} eps`;
    episodes.style.display = 'inline';
  }
  statusBadge.textContent = data.airing_status || '';
  statusBadge.style.display = data.airing_status ? 'inline' : 'none';

  related.innerHTML = '';
  if (data.related && data.related.length > 0) {
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'modal__section-title';
    sectionTitle.textContent = 'Related Series';
    related.appendChild(sectionTitle);
    data.related.forEach(r => {
      r.entries && r.entries.forEach(e => {
        const item = document.createElement('div');
        item.className = 'modal__related-item';
        item.innerHTML = `
          <span class="modal__related-type">${r.relation}</span>
          <span class="modal__related-title">${e.title}</span>
        `;
        related.appendChild(item);
      });
    });
  }

  renderSeriesNavigation(data.series_nav || null);
  setModalActionState(currentModalStatus);

  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  updateCountdowns();
}

async function fetchAnimeDetails(malId) {
  if (modalAnimeCache.has(malId)) {
    return modalAnimeCache.get(malId);
  }

  const res = await fetch(`/api/anime/${malId}`);
  if (!res.ok) {
    throw new Error(`Failed to load anime ${malId}: ${res.status}`);
  }

  const data = await res.json();
  modalAnimeCache.set(malId, data);
  return data;
}

async function hydrateModalData(malId) {
  const requestId = ++currentModalRequestId;
  setSeriesNavigationDisabled(true);

  try {
    const data = await fetchAnimeDetails(malId);
    if (requestId !== currentModalRequestId) return;

    renderModalData(data, data.user_status);
  } catch (err) {
    if (requestId === currentModalRequestId) {
      console.error('Failed to load anime details:', err);
    }
  } finally {
    if (requestId === currentModalRequestId) {
      setSeriesNavigationDisabled(false);
    }
  }
}

function navigateModalTo(malId) {
  const card = getCardByMalId(malId);
  const fallbackData = parseCardModalData(card);

  if (fallbackData) {
    renderModalData({ ...fallbackData, series_nav: null }, card.dataset.status || '');
  }

  hydrateModalData(malId);
}

function openModal(card) {
  const data = parseCardModalData(card);
  if (!data) return;

  renderModalData({ ...data, series_nav: null }, card.dataset.status || '');
  hydrateModalData(data.mal_id);
}

function closeModal() {
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.classList.remove('open');
  document.body.style.overflow = '';
  currentModalMalId = null;
  currentModalStatus = '';
  currentModalRequestId++;
}

function initModal() {
  const backdrop = document.getElementById('modalBackdrop');
  const closeBtn = document.getElementById('modalClose');

  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  document.querySelectorAll('.btn--more').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.card');
      openModal(card);
    });
  });

  document.querySelectorAll('.modal__series-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetMalId = parseInt(btn.dataset.malId, 10);
      if (!targetMalId) return;

      navigateModalTo(targetMalId);
    });
  });

  document.getElementById('modalActions').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const malId     = currentModalMalId;
      const status   = btn.dataset.status;
      const isActive  = btn.classList.contains('active');
      const newStatus = isActive ? 'none' : status;

      try {
        const res  = await fetch('/api/mark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mal_id: malId, status: newStatus })
        });
        const data = await res.json();
        if (data.ok) {
          const card = document.querySelector(`.card[data-mal-id="${malId}"]`);
          if (card) {
            card.querySelectorAll('.card__actions button').forEach(b => b.classList.remove('active'));
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
  document.querySelectorAll('.lang-toggle button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      try {
        const res = await fetch('/api/lang', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang })
        });
        if (res.ok) window.location.reload();
      } catch (err) {
        console.error('Failed to change language:', err);
      }
    });
  });
}

function updateFollowingCount() {
  const tab = document.querySelector('.tab[data-tab="following"]');
  if (!tab) return;
  const count = document.querySelectorAll('.card[data-followed="true"]').length;
  tab.textContent = `Following (${count})`;
}

document.addEventListener('DOMContentLoaded', () => {
  updateCountdowns();
  setInterval(updateCountdowns, 1000);

  initStatusButtons();
  initModal();
  initTabs();
  initSorting();
  initLanguageToggle();
});
