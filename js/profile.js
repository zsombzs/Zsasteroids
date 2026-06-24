import { initAuth, signOutUser } from '/js/auth.js';
import { db, ref, get } from '/js/firebase.js';

function renderProfile(user, profile) {
  const avatarImg = document.getElementById('profileAvatarImg');
  const avatarIcon = document.getElementById('profileAvatarIcon');

  if (user.photoURL) {
    avatarImg.src = user.photoURL;
    avatarImg.hidden = false;
    avatarIcon.hidden = true;
  } else {
    avatarImg.hidden = true;
    avatarIcon.hidden = false;
  }

  document.getElementById('profileUsername').textContent = profile.username;
  document.getElementById('profileEmail').textContent = user.email || '';

  const stats = profile.stats || {};
  document.getElementById('statGames').textContent = stats.totalGames ?? 0;
  document.getElementById('statBest').textContent = stats.bestScore ?? 0;
  document.getElementById('statTotal').textContent = stats.totalScore ?? 0;

  document.getElementById('profileSkeleton').hidden = true;
  document.getElementById('profileContentWrap').hidden = false;

  fetchPersonalTopScores(user.uid);
}

async function fetchPersonalTopScores(uid) {
  const tbody = document.getElementById('personalScoresBody');
  try {
    const snapshot = await get(ref(db, 'scores'));
    if (!snapshot.exists()) {
      tbody.innerHTML = '<tr class="score-loading"><td colspan="2">No games yet</td></tr>';
      return;
    }

    const entries = [];
    snapshot.forEach(child => {
      const val = child.val();
      if (val && val.uid === uid && typeof val.score === 'number') entries.push(val);
    });

    entries.sort((a, b) => b.score - a.score);
    const top3 = entries.slice(0, 3);

    tbody.innerHTML = '';

    if (top3.length === 0) {
      tbody.innerHTML = '<tr class="score-loading"><td colspan="2">No games yet</td></tr>';
      return;
    }

    top3.forEach((entry, i) => {
      const row = document.createElement('tr');
      if (i === 0) row.classList.add('gold');
      else if (i === 1) row.classList.add('silver');
      else if (i === 2) row.classList.add('bronze');

      const rankTd = document.createElement('td');
      const scoreTd = document.createElement('td');
      rankTd.textContent = `#${i + 1}`;
      scoreTd.textContent = entry.score;
      row.appendChild(rankTd);
      row.appendChild(scoreTd);
      tbody.appendChild(row);
    });
  } catch (e) {
    console.error('Failed to fetch personal scores:', e);
    tbody.innerHTML = '<tr class="score-error"><td colspan="2">Unavailable</td></tr>';
  }
}

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await signOutUser();
  window.location.href = '/index.html';
});

initAuth(
  (user, profile) => {
    if (!profile) {
      window.location.href = '/index.html';
      return;
    }
    renderProfile(user, profile);
  },
  () => {
    window.location.href = '/index.html';
  }
);
