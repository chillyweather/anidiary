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
  card.classList.remove('card--following', 'card--jellyfin', 'card--watched');
  if (status && status !== 'none') {
    card.classList.add(`card--${status}`);
  }
}

function initStatusButtons() {
  document.querySelectorAll('.card__actions button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card   = btn.closest('.card');
      const malId  = parseInt(card.dataset.malId, 10);
      const status = btn.dataset.status;
      const isActive = btn.classList.contains('active');
      const newStatus = isActive ? 'none' : status;

      try {
        const res = await fetch('/api/mark', {
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
          card.dataset.followed = newStatus !== 'none' ? 'true' : 'false';
          updateFollowingCount();
        }
      } catch (err) {
        console.error('Failed to update status:', err);
      }
    });
  });
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabType = tab.dataset.tab;

      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.card').forEach(card => {
        if (tabType === 'all') {
          card.classList.remove('card--hidden');
        } else {
          card.classList.toggle('card--hidden', card.dataset.followed !== 'true');
        }
      });
    });
  });
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
      const key   = scoreMap[sortBy];
      const sA    = parseFloat(a.dataset[key]) || 0;
      const sB    = parseFloat(b.dataset[key]) || 0;
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
  initTabs();
  initSorting();
  initLanguageToggle();
});