import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, ref, get, set } from '/js/firebase.js';

// ── Aktuális felhasználó (más modulok is olvashatják) ──
export let currentUser = null;
export let currentProfile = null;

// ── Google bejelentkezés ──
export async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      console.error('Sign-in error:', e);
    }
  }
}

// ── Kijelentkezés ──
export async function signOutUser() {
  await signOut(auth);
}

// ── Profil betöltése a DB-ből ──
async function loadProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

// ── Profil létrehozása (első bejelentkezéskor) ──
export async function createProfile(uid, username) {
  const profile = {
    username,
    createdAt: Date.now(),
    stats: { totalGames: 0, bestScore: 0, totalScore: 0 },
  };
  await set(ref(db, `users/${uid}`), profile);
  await set(ref(db, `usernames/${username.toLowerCase()}`), uid);
  // Frissítjük az aktuális profilt is, hogy létrehozás után azonnal elérhető
  // legyen az importálóknak (pl. a játékbeli score-mentéshez).
  currentProfile = profile;
  return profile;
}

// ── Username foglaltság ellenőrzése ──
export async function isUsernameTaken(username) {
  const snap = await get(ref(db, `usernames/${username.toLowerCase()}`));
  return snap.exists();
}

// ── Auth állapot változás figyelése ──
export function initAuth(onSignedIn, onSignedOut) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      try {
        currentProfile = await loadProfile(user.uid);
        onSignedIn(user, currentProfile);
      } catch (e) {
        console.error('Profile load failed (check Firebase Security Rules):', e.message);
        currentUser = null;
        currentProfile = null;
        onSignedOut();
      }
    } else {
      currentUser = null;
      currentProfile = null;
      onSignedOut();
    }
  });
}
