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

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
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

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  // Csak same-origin (a CDN-eket — Google Fonts, analytics — nem cache-eljük itt).
  if (url.origin !== self.location.origin) return;

  const isAsset = ASSET_RE.test(url.pathname);
  event.respondWith(isAsset ? cacheFirst(req) : networkFirst(req));
});
