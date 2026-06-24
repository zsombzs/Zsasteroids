import { db, ref, get } from '/js/firebase.js';

async function fetchTopScores() {
  const tbody = document.getElementById('scores-body');
  try {
    const snapshot = await get(ref(db, 'scores'));

    tbody.innerHTML = '';

    if (!snapshot.exists()) {
      tbody.innerHTML = '<tr class="score-loading"><td colspan="3">No scores yet. Be the first!</td></tr>';
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

      if (rank > 5) row.classList.add('score-row--hidden');

      const rankTd = document.createElement('td');
      const nameTd = document.createElement('td');
      const scoreTd = document.createElement('td');

      rankTd.textContent = `#${rank}`;
      nameTd.textContent = entry.name || 'Anonymous';
      scoreTd.textContent = entry.score;

      row.appendChild(rankTd);
      row.appendChild(nameTd);
      row.appendChild(scoreTd);
      tbody.appendChild(row);
    });

    if (top20.length > 5) {
      document.getElementById('view-all-btn').hidden = false;
    }
  } catch (e) {
    console.error('Failed to fetch scores:', e);
    tbody.innerHTML = '<tr class="score-error"><td colspan="3">Scores unavailable</td></tr>';
  }
}

async function fetchStats() {
  try {
    const snapshot = await get(ref(db, 'scores'));
    if (!snapshot.exists()) return;

    let totalScore = 0;
    let count = 0;
    snapshot.forEach(child => {
      totalScore += child.val().score;
      count++;
    });

    document.getElementById('total-games').textContent = `${count} games played`;
    document.getElementById('total-scores').textContent = `${totalScore.toLocaleString()} total points`;
  } catch (e) {
    // silently ignore stats fetch errors
  }
}

fetchTopScores();
fetchStats();

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    fetchTopScores();
    fetchStats();
  }
});
