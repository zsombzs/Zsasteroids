// ── Service Worker: offline / gyenge-net cache ──
// Statikus assetek (JS, CSS, képek, hang, font) cache-first → első látogatás után
// azonnal, cache-ből töltődnek, flaky vagy lassú neten is stabil, akár offline.
// A HTML network-first (online: friss, offline: cache), hogy a frissítések
// megjelenjenek. Asset-csere után emeld a CACHE verziót (a régit az activate törli).

const CACHE = 'zsasteroids-v1';

self.addEventListener('install', (event) => {
  // Azonnal vegye át az irányítást, ne várjon a régi SW lejártára.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Csak TELJES (200) same-origin választ cache-elünk. A 206 (Partial Content —
// pl. egy <audio>/<video> Range-kérése) NEM tárolható a Cache API-ban (hibát dob),
// ezért kihagyjuk; a put-ot is becsomagoljuk, hogy semmilyen hiba ne szálljon el.
function cacheable(res) {
  return res && res.status === 200 && res.type === 'basic';
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (cacheable(res)) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    const idx = await cache.match('/index.html');
    if (idx) return idx;
    throw e;
  }
}

// Nagy, ritkán változó assetek (kép, hang, font) → cache-first (ezek a lényeg
// gyenge neten). A kód (HTML, JS, CSS) → network-first: online mindig friss,
// offline a cache-ből. Így a fejlesztés közbeni változások nem ragadnak be.
const ASSET_RE = /\.(png|jpe?g|webp|gif|svg|ico|mp3|ogg|wav|m4a|woff2?|ttf|otf|eot)$/i;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Range-kéréseket (audio/video részleges letöltés) hagyjuk a böngészőre — ne
  // menjenek a cache-en át, mert a 206 válasz nem tárolható/kezelhető jól.
  if (req.headers.has('range')) return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  // Csak same-origin (a CDN-eket — Google Fonts, analytics — nem cache-eljük itt).
  if (url.origin !== self.location.origin) return;

  const isAsset = ASSET_RE.test(url.pathname);
  event.respondWith(isAsset ? cacheFirst(req) : networkFirst(req));
});
