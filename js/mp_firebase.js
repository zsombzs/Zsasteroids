// js/mp_firebase.js — Co-op (multiplayer) leaderboard az index.html-en.
// Ugyanaz a logika/design mint a main_firebase.js (single player), de az `mpScores`
// node-ból olvas, és a "Players" oszlopban az "A + B" összevont nevet mutatja.

import { db, ref, get } from '/js/firebase.js';

async function fetchTopScores() {
  const tbody = document.getElementById('mp-scores-body');
  try {
    const snapshot = await get(ref(db, 'mpScores'));

    tbody.innerHTML = '';

    if (!snapshot.exists()) {
      tbody.innerHTML = '<tr class="score-loading"><td colspan="3">No co-op scores yet. Grab a friend!</td></tr>';
      return;
    }

    const entries = [];
    snapshot.forEach(child => {
      const val = child.val();
      if (val && typeof val.score === 'number') entries.push(val);
    });
    entries.sort((a, b) => b.score - a.score);
    const top20 = entries.slice(0, 20);

    top20.forEach((entry, index) => {
      const row = document.createElement('tr');
      const rank = index + 1;

      if (rank === 1) row.classList.add('gold');
      else if (rank === 2) row.classList.add('silver');
      else if (rank === 3) row.classList.add('bronze');

      if (rank > 5) row.classList.add('mp-score-row--hidden');

      const rankTd = document.createElement('td');
      const nameTd = document.createElement('td');
      const scoreTd = document.createElement('td');

      rankTd.textContent = `#${rank}`;
      nameTd.textContent = entry.name || 'Anonymous + Anonymous';
      scoreTd.textContent = entry.score;

      row.appendChild(rankTd);
      row.appendChild(nameTd);
      row.appendChild(scoreTd);
      tbody.appendChild(row);
    });

    if (top20.length > 5) {
      document.getElementById('mp-view-all-btn').hidden = false;
    }
  } catch (e) {
    console.error('Failed to fetch co-op scores:', e);
    tbody.innerHTML = '<tr class="score-error"><td colspan="3">Scores unavailable</td></tr>';
  }
}

async function fetchStats() {
  try {
    const snapshot = await get(ref(db, 'mpScores'));
    if (!snapshot.exists()) return;

    let totalScore = 0;
    let count = 0;
    snapshot.forEach(child => {
      totalScore += child.val().score;
      count++;
    });

    document.getElementById('mp-total-games').textContent = `${count} games played`;
    document.getElementById('mp-total-scores').textContent = `${totalScore.toLocaleString()} total points`;
  } catch (e) {
    // silently ignore stats fetch errors
  }
}

// ── "View all" kapcsoló (saját, hogy a single-player táblát ne befolyásolja) ──
let mpAllVisible = false;
const mpViewAllBtn = document.getElementById('mp-view-all-btn');
if (mpViewAllBtn) {
  mpViewAllBtn.addEventListener('click', () => {
    mpAllVisible = !mpAllVisible;
    document.querySelectorAll('.mp-score-row--hidden').forEach(row => {
      row.style.display = mpAllVisible ? 'table-row' : 'none';
    });
    mpViewAllBtn.innerHTML = mpAllVisible
      ? 'Show less <i class="fas fa-chevron-up" id="mp-view-all-icon"></i>'
      : 'View all 20 scores <i class="fas fa-chevron-down" id="mp-view-all-icon"></i>';
  });
}

fetchTopScores();
fetchStats();

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    fetchTopScores();
    fetchStats();
  }
});
