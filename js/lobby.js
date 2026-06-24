// js/lobby.js — Multiplayer co-op lobby Firebase CRUD (1. fázis)
//
// Felelősség: a `lobbies/{code}` node létrehozása / csatlakozás / törlés / figyelés.
// A játéklogika (pozíció-sync, aszteroidák, revive) NEM itt van — az a 3+. fázisok.
//
// Identitás: ha be van jelentkezve a játékos, a Firebase uid-et használjuk; ha nincs,
// egy stabil "vendég-id"-t (localStorage), hogy anonim játékosok is tudjanak co-opozni.
// A megjelenített név bejelentkezve a profil username, egyébként null → "Anonymous".

import { db, ref, get, set, update, remove, onValue, onDisconnect, serverTimestamp } from '/js/firebase.js';
import { currentUser, currentProfile } from '/js/auth.js';

// 0/O és 1/I kihagyva, hogy a kód könnyen felolvasható/begépelhető legyen.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CODE_GEN_ATTEMPTS = 8;

// ── Identitás ────────────────────────────────────────────────────────────────
// Élő (live binding) import: a currentUser/currentProfile az auth.js-ben async
// frissül, ezért mindig hívás-időben olvassuk ki az aktuális értéket.
export function getPlayerId() {
  if (currentUser && currentUser.uid) return currentUser.uid;
  let id = localStorage.getItem('zsa_guest_id');
  if (!id) {
    id = 'guest_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('zsa_guest_id', id);
  }
  return id;
}

export function getPlayerName() {
  return (currentProfile && currentProfile.username) ? currentProfile.username : null;
}

// ── Kódgenerálás ───────────────────────────────────────────────────────────────
function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

// Ütközésmentes kód: néhányszor próbálkozunk, get-tel ellenőrizve.
async function generateUniqueCode() {
  for (let attempt = 0; attempt < CODE_GEN_ATTEMPTS; attempt++) {
    const code = randomCode();
    const snap = await get(ref(db, `lobbies/${code}`));
    if (!snap.exists()) return code;
  }
  const e = new Error('no_free_code');
  e.code = 'no_free_code';
  throw e;
}

// ── Lobby létrehozás (host) ──────────────────────────────────────────────────
// Visszaadja a tényleges, ütközésmentes szobakódot.
export async function createLobby(theme, hostId, hostName) {
  const code = await generateUniqueCode();
  await set(ref(db, `lobbies/${code}`), {
    host: hostId,
    hostName: hostName || 'Anonymous',
    theme,
    status: 'waiting',
    score: 0,
    createdAt: serverTimestamp(),
  });
  // Ha a host a waiting alatt bezárja a tabot / lecsatlakozik, takarítsuk el az
  // árva lobbyt (a szerver oldalon regisztrált esemény).
  try { onDisconnect(ref(db, `lobbies/${code}`)).remove(); } catch (e) { /* no-op */ }
  return code;
}

// ── Csatlakozás (guest) ──────────────────────────────────────────────────────
// Sikerkor visszaadja a lobby theme-jét (a navigációhoz). Hibakódok:
//   'not_found'    — nincs ilyen szoba
//   'full'         — már van guest
//   'not_joinable' — a státusz nem 'waiting' (pl. már elindult / véget ért)
export async function joinLobby(code, guestId, guestName) {
  const lobbyRef = ref(db, `lobbies/${code}`);
  const snap = await get(lobbyRef);

  if (!snap.exists()) { const e = new Error('not_found');    e.code = 'not_found';    throw e; }
  const lobby = snap.val();
  if (lobby.guest)               { const e = new Error('full');         e.code = 'full';         throw e; }
  if (lobby.status !== 'waiting'){ const e = new Error('not_joinable'); e.code = 'not_joinable'; throw e; }

  await update(lobbyRef, {
    guest: guestId,
    guestName: guestName || 'Anonymous',
    status: 'playing',
    startedAt: serverTimestamp(),
  });
  return lobby.theme;
}

// ── Lobby törlés ─────────────────────────────────────────────────────────────
export async function deleteLobby(code) {
  // A host onDisconnect-cleanupját szándékos törléskor lemondjuk, hogy ne fusson le
  // duplán / a navigáció után.
  try { await onDisconnect(ref(db, `lobbies/${code}`)).cancel(); } catch (e) { /* no-op */ }
  await remove(ref(db, `lobbies/${code}`));
}

// ── Waiting-onDisconnect lemondása ───────────────────────────────────────────
// A createLobby a host lecsatlakozására beállít egy "lobby törlés" eseményt (hogy
// ne maradjon árva waiting-szoba). Amikor viszont szándékosan a JÁTÉKBA navigálunk,
// ezt le kell mondani, különben a navigáció (= lecsatlakozás) törölné a lobbyt a
// meccs indulásakor. A játékoldal (main.js) utána újra regisztrál saját cleanupot.
export async function cancelLobbyCleanup(code) {
  try { await onDisconnect(ref(db, `lobbies/${code}`)).cancel(); } catch (e) { /* no-op */ }
}

// ── Lobby figyelése ──────────────────────────────────────────────────────────
// A callback a teljes lobby objektumot kapja (vagy null-t, ha törölve). Visszaadja
// az unsubscribe függvényt, amit a hívónak meg KELL hívnia takarításkor.
export function listenLobby(code, callback) {
  const lobbyRef = ref(db, `lobbies/${code}`);
  return onValue(lobbyRef, (snap) => callback(snap.val()));
}
