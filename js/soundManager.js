// ── Hangkezelés: Web Audio API ──
// Korábban minden effekt HTML5 Audio elemmel ment. Ott minden hang ELSŐ
// lejátszása ~0.5s-et késett, mert (1) a lap első hangjánál felpörög az
// audio-kimenet pipeline, és (2) az Audio elem csak az első play()-nél dekódolja
// az MP3-at. A Web Audio API ezt megszünteti: minden fájlt egyszer, betöltéskor
// dekódolunk AudioBuffer-be, és rövid életű AudioBufferSourceNode-okkal játszunk
// le — közel nulla késleltetés, korlátlan átfedés, minimális CPU.
// A kifelé adott függvények (playSound, preloadSounds, getMuted, …) szignatúrája
// változatlan, így a hívási helyeket nem kell módosítani.

let isSoundMuted = false;

export function setMuted(muted) {
  isSoundMuted = muted;
}

export function toggleMuted() {
  isSoundMuted = !isSoundMuted;
  return isSoundMuted;
}

export function getMuted() {
  return isSoundMuted;
}

// ── AudioContext (lazy + fallback) ──
const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
let webAudioOK = !!AC;
let ctx = null;
let masterGain = null;

function getCtx() {
  if (!webAudioOK) return null;
  if (!ctx) {
    try {
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(ctx.destination);
    } catch (e) {
      webAudioOK = false;
      ctx = null;
    }
  }
  return ctx;
}

// A böngésző az AudioContext-et "suspended" állapotban indítja, amíg nincs
// user-gesztus. Az első interakciónál felébresztjük (resume) + lejátszunk egy
// néma buffert, ami egyszer bemelegíti a hangkimenetet — így a játék első
// effektje sem akad meg.
function unlock() {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  try {
    const buf = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch (e) { /* nem kritikus */ }
}

if (webAudioOK && typeof window !== 'undefined') {
  const onGesture = () => {
    unlock();
    const c = getCtx();
    if (c) {
      c.resume().then(() => {
        if (c.state === 'running') {
          window.removeEventListener('pointerdown', onGesture);
          window.removeEventListener('keydown', onGesture);
          window.removeEventListener('touchstart', onGesture);
        }
      }).catch(() => {});
    }
  };
  window.addEventListener('pointerdown', onGesture, { passive: true });
  window.addEventListener('keydown', onGesture, { passive: true });
  window.addEventListener('touchstart', onGesture, { passive: true });
}

// ── Buffer-tár + dekódolás ──
const buffers = new Map();   // path -> AudioBuffer
const decoding = new Map();  // path -> Promise<AudioBuffer|null> (folyamatban lévő dekódok deduplikálása)

function loadBuffer(path) {
  if (buffers.has(path)) return Promise.resolve(buffers.get(path));
  if (decoding.has(path)) return decoding.get(path);
  const c = getCtx();
  if (!c) return Promise.resolve(null);
  const p = fetch(path)
    .then(r => r.arrayBuffer())
    .then(ab => c.decodeAudioData(ab))
    .then(buf => { buffers.set(path, buf); decoding.delete(path); return buf; })
    .catch(e => { decoding.delete(path); console.log(`Sound decode error (${path}):`, e); return null; });
  decoding.set(path, p);
  return p;
}

// Hangok előtöltése + dekódolása (pl. játék indulásakor), hogy az első
// megszólalás se akadjon meg. A dekódolás a betöltéshez kerül, nem az első
// lejátszáshoz.
export function preloadSounds(paths) {
  for (const path of paths) loadBuffer(path);
}

function playBuffer(c, buf, volume) {
  try {
    if (c.state === 'suspended') c.resume().catch(() => {});
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(masterGain || c.destination);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    src.start(0);
  } catch (e) {
    console.log('Sound play error:', e);
  }
}

// HTML5 Audio fallback, ha a Web Audio nem elérhető (nagyon régi böngésző),
// vagy ha egy fájl dekódolása végül elhasal.
function playFallback(path, volume) {
  try {
    const a = new Audio(path);
    a.volume = volume;
    a.play().catch(() => {});
  } catch (e) { /* nincs mit tenni */ }
}

export function playSound(path, volume = 0.5) {
  if (isSoundMuted) return;
  const c = getCtx();
  if (!c) { playFallback(path, volume); return; }

  const buf = buffers.get(path);
  if (buf) {
    playBuffer(c, buf, volume);
    return;
  }
  // Még nincs dekódolva (nem volt a preload-listán) → dekódol, és ha kész,
  // lejátssza. Ez csak az adott hang legelső megszólalásánál okoz pici késést.
  loadBuffer(path).then(b => {
    if (isSoundMuted) return;
    if (b) playBuffer(getCtx(), b, volume);
    else playFallback(path, volume);
  });
}

// A háttérzene (loopolt, hosszú) marad HTML5 Audio-n — ott a késleltetés
// irreleváns, a Web Audio csak fölös bonyolítás lenne.
export function createLoopedSound(path, volume = 1.0) {
  const audio = new Audio(path);
  audio.loop = true;
  audio.volume = volume;

  const play = () => {
    if (!isSoundMuted) audio.play().catch(() => {});
  };

  const stop = () => {
    audio.pause();
    audio.currentTime = 0;
  };

  return { play, stop, audio };
}

let adibodizs = false;

export function toggleSoundVariant() {
  adibodizs = !adibodizs;
  return adibodizs;
}

export function getSoundVariant() {
  return adibodizs;
}
