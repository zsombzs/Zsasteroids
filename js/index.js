import { initAuth, signInWithGoogle, createProfile, isUsernameTaken, currentUser } from '/js/auth.js';
import { createLobby, joinLobby, deleteLobby, listenLobby, cancelLobbyCleanup, getPlayerId, getPlayerName } from '/js/lobby.js';

// Service Worker: offline / gyenge-net cache (lásd /sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ── Modal helpers ──
function openModal(id) {
  document.getElementById(id).hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
  document.body.style.overflow = '';
  // Ha a co-op modalt zárjuk be, miközben függőben van egy létrehozott (waiting)
  // lobby, takarítsuk el (törlés + listener leiratkozás).
  if (id === 'coopModal') leaveLobby();
}

// Close on overlay click (skip persistent modals)
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay && !overlay.dataset.persistent) closeModal(overlay.id);
  });
});

// Close on × button
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Close on Escape (skip persistent modals)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => {
      if (!m.dataset.persistent) closeModal(m.id);
    });
  }
});

// ── Solo Play ──
document.getElementById('soloPlayBtn').addEventListener('click', () => openModal('soloModal'));

// ── Co-op ──
document.getElementById('coopBtn').addEventListener('click', () => {
  showCoopScreen('coopScreen1');
  openModal('coopModal');
});

function showCoopScreen(id) {
  document.querySelectorAll('.coop-screen').forEach(s => s.hidden = true);
  document.getElementById(id).hidden = false;
  // A waiting képernyő szélesebb panelt kap, hogy a "Waiting for Player 2"
  // egy sorba férjen.
  const coopModalBox = document.querySelector('#coopModal .modal');
  if (coopModalBox) coopModalBox.classList.toggle('modal--wide', id === 'coopScreen3Waiting');
}

document.getElementById('createLobbyBtn').addEventListener('click', () => showCoopScreen('coopScreen2Create'));
document.getElementById('joinLobbyBtn').addEventListener('click', () => showCoopScreen('coopScreen2Join'));
document.getElementById('backFromCreate').addEventListener('click', () => showCoopScreen('coopScreen1'));
document.getElementById('backFromJoin').addEventListener('click', () => showCoopScreen('coopScreen1'));

// ── Lobby állapot ──
let activeLobbyCode = null;   // a host által létrehozott, még waiting lobby kódja
let lobbyUnsub = null;        // a listenLobby unsubscribe függvénye
let isCreatingLobby = false;  // dupla-kattintás védelem

function stopLobbyListener() {
  if (lobbyUnsub) { lobbyUnsub(); lobbyUnsub = null; }
}

// Függőben lévő (waiting) lobby eltakarítása: listener le + lobby törlés.
function leaveLobby() {
  stopLobbyListener();
  const code = activeLobbyCode;
  activeLobbyCode = null;
  if (code) {
    deleteLobby(code).catch(err => console.error('deleteLobby failed:', err));
  }
}

function navigateToGame(theme, code, role) {
  window.location.href = `themes/${theme}/${theme}.html?theme=${theme}&lobby=${code}&role=${role}`;
}

// Create path: téma kiválasztása → lobby létrehozás → várakozás a guestre.
document.querySelectorAll('.theme-card--btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (isCreatingLobby) return;
    isCreatingLobby = true;

    const theme = btn.dataset.theme;
    document.getElementById('roomCodeDisplay').textContent = '…';
    document.getElementById('roomThemeDisplay').textContent = `Theme: ${theme}`;
    showCoopScreen('coopScreen3Waiting');

    try {
      const code = await createLobby(theme, getPlayerId(), getPlayerName());
      activeLobbyCode = code;
      document.getElementById('roomCodeDisplay').textContent = code;

      // Amint a guest csatlakozik (status → 'playing'), mindkét fél a játékba navigál.
      lobbyUnsub = listenLobby(code, async (lobby) => {
        if (lobby && lobby.guest && lobby.status === 'playing') {
          stopLobbyListener();
          activeLobbyCode = null;   // ne törölje a leaveLobby a most induló meccset
          // A waiting-cleanupot lemondjuk, hogy a lobby megmaradjon a meccs idejére.
          await cancelLobbyCleanup(code);
          navigateToGame(theme, code, 'host');
        }
      });
    } catch (err) {
      console.error('createLobby failed:', err);
      showCoopScreen('coopScreen2Create');
    } finally {
      isCreatingLobby = false;
    }
  });
});

document.getElementById('cancelLobbyBtn').addEventListener('click', () => {
  leaveLobby();
  showCoopScreen('coopScreen1');
});

// Join path
document.getElementById('joinRoomBtn').addEventListener('click', handleJoinClick);
document.getElementById('roomCodeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleJoinClick();
});

async function handleJoinClick() {
  const input = document.getElementById('roomCodeInput');
  const errorEl = document.getElementById('joinError');
  const joinBtn = document.getElementById('joinRoomBtn');
  const code = input.value.trim().toUpperCase();

  // Szigorú formátum: pontosan 4 nagybetűs alfanumerikus karakter. Ez egyben
  // megakadályozza, hogy veszélyes path-karakter kerüljön a Firebase-útvonalba.
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    errorEl.textContent = 'Enter a valid 4-character room code (letters and numbers).';
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;
  joinBtn.disabled = true;
  const prevLabel = joinBtn.textContent;
  joinBtn.textContent = 'Joining…';

  try {
    const theme = await joinLobby(code, getPlayerId(), getPlayerName());
    navigateToGame(theme, code, 'guest');   // siker → navigálunk (az oldal elhagyja)
  } catch (err) {
    let msg = 'Room not found. Check the code and try again.';
    if (err.code === 'full') msg = 'This room is already full.';
    else if (err.code === 'not_joinable') msg = 'This game has already started.';
    errorEl.textContent = msg;
    errorEl.hidden = false;
    joinBtn.disabled = false;
    joinBtn.textContent = prevLabel;
  }
}

// ── How to Play collapsible ──
const howToPlayBtn = document.getElementById('howToPlayBtn');
const howToPlayContent = document.getElementById('howToPlayContent');

howToPlayBtn.addEventListener('click', () => {
  const isOpen = howToPlayBtn.getAttribute('aria-expanded') === 'true';
  howToPlayBtn.setAttribute('aria-expanded', !isOpen);
  howToPlayContent.classList.toggle('is-open', !isOpen);
});

// ── Scoreboard: View all toggle ──
let allScoresVisible = false;
const viewAllBtn = document.getElementById('view-all-btn');

viewAllBtn.addEventListener('click', () => {
  allScoresVisible = !allScoresVisible;
  document.querySelectorAll('.score-row--hidden').forEach(row => {
    row.style.display = allScoresVisible ? 'table-row' : 'none';
  });
  viewAllBtn.innerHTML = allScoresVisible
    ? 'Show less <i class="fas fa-chevron-up" id="view-all-icon"></i>'
    : 'View all 20 scores <i class="fas fa-chevron-down" id="view-all-icon"></i>';
});

// ── Auth UI ──
const authDropdown = document.getElementById('authDropdown');

function setAuthUI(user, profile) {
  const authUserLink = document.getElementById('authUserLink');
  const authGuest = document.getElementById('authGuest');

  if (user && profile) {
    authUserLink.hidden = false;
    authGuest.hidden = true;
    document.getElementById('authDisplayName').textContent = profile.username;
    const avatarImg = document.getElementById('authAvatar');
    const avatarFallback = document.getElementById('authAvatarFallback');
    if (user.photoURL) {
      avatarImg.src = user.photoURL;
      avatarImg.hidden = false;
      avatarFallback.hidden = true;
    } else {
      avatarImg.hidden = true;
      avatarFallback.hidden = false;
    }
  } else if (user && !profile) {
    authUserLink.hidden = true;
    authGuest.hidden = false;
    openModal('usernameModal');
  } else {
    authUserLink.hidden = true;
    authGuest.hidden = false;
  }
}

initAuth(
  (user, profile) => setAuthUI(user, profile),
  () => setAuthUI(null, null)
);

document.getElementById('signUpBtn').addEventListener('click', signInWithGoogle);
document.getElementById('logInBtn').addEventListener('click', signInWithGoogle);

document.getElementById('authProfileBtn').addEventListener('click', e => {
  e.stopPropagation();
  authDropdown.hidden = !authDropdown.hidden;
});

document.addEventListener('click', () => { authDropdown.hidden = true; });

// ── Username picker ──
const usernameInput = document.getElementById('usernameInput');
const usernameError = document.getElementById('usernameError');
const usernameSubmitBtn = document.getElementById('usernameSubmitBtn');

usernameSubmitBtn.addEventListener('click', submitUsername);
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitUsername(); });

async function submitUsername() {
  const raw = usernameInput.value.trim();
  const err = validateUsername(raw);
  if (err) { showUsernameError(err); return; }

  usernameSubmitBtn.disabled = true;
  usernameSubmitBtn.textContent = 'Checking…';
  usernameError.hidden = true;

  try {
    const taken = await isUsernameTaken(raw);
    if (taken) { showUsernameError('Username is already taken.'); return; }

    const profile = await createProfile(currentUser.uid, raw);
    closeModal('usernameModal');
    setAuthUI(currentUser, profile);
  } catch {
    showUsernameError('Something went wrong. Please try again.');
  } finally {
    usernameSubmitBtn.disabled = false;
    usernameSubmitBtn.textContent = 'Confirm';
  }
}

function validateUsername(name) {
  if (name.length < 3) return 'At least 3 characters required.';
  if (name.length > 16) return 'Maximum 16 characters allowed.';
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return 'Only letters, numbers and underscores allowed.';
  return null;
}

function showUsernameError(msg) {
  usernameError.textContent = msg;
  usernameError.hidden = false;
  usernameSubmitBtn.disabled = false;
  usernameSubmitBtn.textContent = 'Confirm';
}
