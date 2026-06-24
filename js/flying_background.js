const images = [
  'themes/space/boost.png',
  'themes/space/spaceship.png',
  'themes/space/asteroid.png',
  'themes/ocean/spaceship.png',
  'themes/ocean/asteroid.png',
  'themes/ocean/boost.png',
  'themes/jungle/boost.png',
  'themes/jungle/spaceship.png',
  'themes/jungle/asteroid.png',
  'themes/ww2/boost.png',
  'themes/ww2/spaceship.png',
  'themes/ww2/asteroid.png',
  '/assets/images/zsasteroids_icon_no_bg.png',
  'themes/space/multishot.png',
  'themes/ocean/multishot.png',
  'themes/jungle/multishot.png',
  'themes/ww2/multishot.png',
  'themes/space/strike.png',
  'themes/ocean/strike.png',
  'themes/jungle/strike.png',
  'themes/ww2/strike.png',
  'themes/city/asteroid.png',
  'themes/city/spaceship.png',
  'themes/city/boost.png',
  'themes/city/multishot.png',
  'themes/city/strike.png',
];

const BG_KEY = 'bgParticles';
let activeParticles = [];

function spawnNew() {
  const container = document.querySelector('.background-container');
  if (!container) return;

  const img = document.createElement('img');
  const src = images[Math.floor(Math.random() * images.length)];
  img.src = src;
  img.className = 'floating-image';
  container.appendChild(img);

  const scaleValue = (src.endsWith('boost.png') || src.endsWith('multishot.png')) ? 0.7 : 1.2;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const side = Math.floor(Math.random() * 4);
  let x, y, targetX, targetY;

  if (side === 0)      { x = -100;     y = Math.random() * vh; targetX = vw + 100; targetY = Math.random() * vh; }
  else if (side === 1) { x = vw + 100; y = Math.random() * vh; targetX = -100;     targetY = Math.random() * vh; }
  else if (side === 2) { x = Math.random() * vw; y = -100;     targetX = Math.random() * vw; targetY = vh + 100; }
  else                 { x = Math.random() * vw; y = vh + 100; targetX = Math.random() * vw; targetY = -100; }

  img.style.left = `${x}px`;
  img.style.top  = `${y}px`;

  const deltaX = targetX - x;
  const deltaY = targetY - y;
  const angle  = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
  img.style.transform = `scale(${scaleValue}) rotate(${angle}deg)`;

  const totalDuration = (10 + Math.random() * 5) * 1000;
  const startTime     = Date.now();

  img.animate([
    { transform: `translate(0px, 0px) scale(${scaleValue}) rotate(${angle}deg)` },
    { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleValue}) rotate(${angle}deg)` },
  ], { duration: totalDuration, easing: 'linear' });

  const state = { src, x, y, deltaX, deltaY, scaleValue, angle, totalDuration, startTime };
  activeParticles.push(state);
  setTimeout(() => {
    img.remove();
    activeParticles = activeParticles.filter(p => p !== state);
  }, totalDuration);
}

function restoreParticle(state) {
  const container = document.querySelector('.background-container');
  if (!container) return;

  const elapsed = Date.now() - state.startTime;
  if (elapsed >= state.totalDuration) return;

  const img = document.createElement('img');
  img.src = state.src;
  img.className = 'floating-image';
  container.appendChild(img);

  const progress        = elapsed / state.totalDuration;
  const currentX        = state.x + state.deltaX * progress;
  const currentY        = state.y + state.deltaY * progress;
  const remainingDeltaX = state.deltaX * (1 - progress);
  const remainingDeltaY = state.deltaY * (1 - progress);
  const remaining       = state.totalDuration - elapsed;

  img.style.left      = `${currentX}px`;
  img.style.top       = `${currentY}px`;
  img.style.transform = `scale(${state.scaleValue}) rotate(${state.angle}deg)`;

  img.animate([
    { transform: `translate(0px, 0px) scale(${state.scaleValue}) rotate(${state.angle}deg)` },
    { transform: `translate(${remainingDeltaX}px, ${remainingDeltaY}px) scale(${state.scaleValue}) rotate(${state.angle}deg)` },
  ], { duration: remaining, easing: 'linear' });

  activeParticles.push(state);
  setTimeout(() => {
    img.remove();
    activeParticles = activeParticles.filter(p => p !== state);
  }, remaining);
}

// Save particle state before leaving the page
window.addEventListener('pagehide', () => {
  const alive = activeParticles.filter(p => Date.now() - p.startTime < p.totalDuration);
  sessionStorage.setItem(BG_KEY, JSON.stringify(alive));
});

// Restore or start fresh
const savedRaw = sessionStorage.getItem(BG_KEY);
if (savedRaw) {
  const saved = JSON.parse(savedRaw);
  const alive = saved.filter(p => Date.now() - p.startTime < p.totalDuration);
  alive.forEach(state => restoreParticle(state));
  // Spawn extra only if fewer than 4 particles survived the transition
  const extra = Math.max(0, 4 - alive.length);
  for (let i = 0; i < extra; i++) setTimeout(spawnNew, i * 400);
} else {
  for (let i = 0; i < 6; i++) setTimeout(spawnNew, i * 300);
}

setInterval(spawnNew, 2000);
