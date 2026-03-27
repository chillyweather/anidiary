// Countdown timers
function updateCountdowns() {
  document.querySelectorAll('.countdown-timer').forEach(el => {
    const target = parseInt(el.dataset.timestamp) * 1000;
    const diff = target - Date.now();
    
    if (diff <= 0) {
      el.textContent = 'Released';
      return;
    }
    
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) /3600000);
    const mins = Math.floor((diff% 3600000) / 60000);
    
    if (days > 0) {
      el.textContent = `in ${days}d ${hrs}h`;
    } else if (hrs > 0) {
      el.textContent = `in ${hrs}h ${mins}m`;
    } else {
      el.textContent = `in ${mins}m`;
    }
  });
}

// Status toggle buttons
function initStatusButtons() {
  document.querySelectorAll('.card__actions button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const malId = parseInt(card.dataset.malId);
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
          // Remove active from all sibling buttons
          btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          
          if (newStatus !== 'none') {
            btn.classList.add('active');
            card.dataset.followed = 'true';
          } else {
            card.dataset.followed = 'false';
          }
          
          // Update following count
          updateFollowingCount();
        }
      } catch (err) {
        console.error('Failed to update status:', err);
      }
    });
  });
}

// Tab switching
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabType = tab.dataset.tab;
      
      // Update active tab
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Show/hide cards
      document.querySelectorAll('.card').forEach(card => {
        if (tabType === 'all') {
          card.classList.remove('card--hidden');
        } else {
          if (card.dataset.followed === 'true') {
            card.classList.remove('card--hidden');
          } else {
            card.classList.add('card--hidden');
          }
        }
      });
    });
  });
}

// Sorting
function initSorting() {
  const sortSelect = document.getElementById('sort-select');
  if (!sortSelect) return;
  
  sortSelect.addEventListener('change', () => {
    const sortBy = sortSelect.value;
    const container = document.querySelector('.card-grid');
    const cards = Array.from(container.querySelectorAll('.card'));
    
    cards.sort((a, b) => {
      if (sortBy === 'title') {
        const titleA = a.querySelector('.card__title').textContent;
        const titleB = b.querySelector('.card__title').textContent;
        return titleA.localeCompare(titleB);
      } else if (sortBy === 'next_ep') {
        const epA = parseInt(a.dataset.nextEpAt) || 9999999999;
        const epB = parseInt(b.dataset.nextEpAt) || 9999999999;
        return epA - epB;
      } else {
        const scoreFieldMap = {
          score_mal: 'scoreMal',
          score_anilist: 'scoreAnilist',
          score_shiki: 'scoreShiki'
        };
        const key = scoreFieldMap[sortBy];
        const scoreA = parseFloat(a.dataset[key]) || 0;
        const scoreB = parseFloat(b.dataset[key]) || 0;
        return scoreB - scoreA;
      }
    });
    
    cards.forEach(card => container.appendChild(card));
  });
}

// Language toggle
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
        
        if (res.ok) {
          window.location.reload();
        }
      } catch (err) {
        console.error('Failed to change language:', err);
      }
    });
  });
}

// Update following count in tab
function updateFollowingCount() {
  const followingTab = document.querySelector('.tab[data-tab="following"]');
  if (!followingTab) return;
  
  const count = document.querySelectorAll('.card[data-followed="true"]').length;
  followingTab.textContent = `Following (${count})`;
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  updateCountdowns();
  setInterval(updateCountdowns, 1000);
  
  initStatusButtons();
  initTabs();
  initSorting();
  initLanguageToggle();
});
