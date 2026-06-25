// ── Közös kép-cache ──
// Korábban minden objektum (aszteroida, player, powerup, hunter, strike) a saját
// konstruktorában hozott létre egy új Image()-t és állította be a .src-t. Sok
// spawn/split = sok Image-objektum + ismételt dekód + GC, ráadásul az első
// rajzoláskor még nem volt kész a kép → „beugrás". Itt útvonalanként EGYSZER
// töltünk be egy képet, és minden példány ezt használja újra.

const cache = new Map();   // path -> HTMLImageElement

export function getImage(path) {
  let img = cache.get(path);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = path;
    cache.set(path, img);
  }
  return img;
}

// Több kép előtöltése; Promise-t ad vissza, ami akkor teljesül, ha mind betöltött
// (hibás kép is „kész"-nek számít, hogy a betöltő-kapu sose ragadjon be).
// Az opcionális onProgress minden egyes kép elkészültekor lefut (progress-hez).
export function preloadImages(paths, onProgress) {
  const promises = paths.map(p => {
    const img = getImage(p);
    if (img.complete && img.naturalWidth) {
      if (onProgress) onProgress(p, true);
      return Promise.resolve(img);
    }
    return new Promise(resolve => {
      const done = ok => { if (onProgress) onProgress(p, ok); resolve(img); };
      img.addEventListener('load', () => done(true), { once: true });
      img.addEventListener('error', () => done(false), { once: true });
    });
  });
  return Promise.all(promises);
}
