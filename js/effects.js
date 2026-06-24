// js/effects.js
// ──────────────────────────────────────────────────────────────────────────
// Game feel / „juice" effektek (space-only): screen shake, részecske-robbanás,
// torkolattűz és lebegő, méretskálázó pont-számok. Mind tisztán rajzolt — NINCS
// asset és NINCS új hang.
//
// FONTOS: ez a modul SZÁNDÉKOSAN nem importál a main.js-ből (a player.js /
// asteroid.js körköros függőségének elkerülése). Mindent paraméterként kap.
//
// A screen shake tiszteletben tartja a `prefers-reduced-motion` beállítást
// (kikapcsol), a lokalizált effektek (részecske, villanás, pont-pop) maradnak.
// ──────────────────────────────────────────────────────────────────────────

const REDUCE_MOTION = typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A háttér ennyivel nagyobban rajzolódik shake közben, hogy a kamera-eltolás
// ne villantson fekete csíkot a képernyő szélén (lásd main.js háttér-rajz).
export const SHAKE_OVERSCAN = 20;

// ── Screen shake ───────────────────────────────────────────────────────────
let _shake = { intensity: 0, start: 0, duration: 1 };

function _currentShake(now) {
    if (!_shake.duration) return 0;
    const t = (now - _shake.start) / _shake.duration;
    if (t < 0 || t >= 1) return 0;
    return _shake.intensity * (1 - t);   // lineáris lecsengés
}

// Rázás indítása. Csak akkor írja felül a futó rázást, ha az újat erősebbnek
// érzékeljük a pillanatnyi (lecsengő) értéknél — így a kis találatok nem törlik
// egy nagy robbanás rázását.
export function shake(intensity, durationMs) {
    if (REDUCE_MOTION || intensity <= 0) return;
    const now = Date.now();
    if (intensity >= _currentShake(now)) {
        _shake = { intensity, start: now, duration: durationMs };
    }
}

// A game loop ezzel kéri le az aktuális kamera-eltolást (px), és tolja el a
// canvas-világot ctx.translate-tel.
export function getShakeOffset() {
    const mag = _currentShake(Date.now());
    if (mag <= 0) return { x: 0, y: 0 };
    return {
        x: (Math.random() * 2 - 1) * mag,
        y: (Math.random() * 2 - 1) * mag,
    };
}

// ── Részecskék (kő-törés / robbanás szilánkjai) ─────────────────────────────
let particles = [];

// x,y: kibocsátás középpontja; color: szilánk szín; count: darabszám.
// opts: { speedMin, speedMax, sizeMin, sizeMax, lifeMin, lifeMax, drag }
export function spawnExplosion(x, y, color = '#cdbfae', count = 10, opts = {}) {
    const speedMin = opts.speedMin ?? 80;
    const speedMax = opts.speedMax ?? 280;
    const sizeMin  = opts.sizeMin  ?? 2;
    const sizeMax  = opts.sizeMax  ?? 5;
    const lifeMin  = opts.lifeMin  ?? 0.4;
    const lifeMax  = opts.lifeMax  ?? 0.65;
    const drag     = opts.drag     ?? 2.4;
    for (let i = 0; i < count; i++) {
        const ang  = Math.random() * Math.PI * 2;
        const spd  = speedMin + Math.random() * (speedMax - speedMin);
        const life = lifeMin + Math.random() * (lifeMax - lifeMin);
        particles.push({
            x, y,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd,
            life, maxLife: life, drag,
            size: sizeMin + Math.random() * (sizeMax - sizeMin),
            color,
        });
    }
}

// ── Torkolattűz (lövéskor a hajó orránál) ───────────────────────────────────
const MUZZLE_DUR = 75;   // ms
let muzzles = [];

export function spawnMuzzleFlash(x, y, rotationDeg, color = '#bfefff') {
    muzzles.push({ x, y, rot: rotationDeg, t: Date.now(), color });
}

// ── Lökéshullám-gyűrű (robbanás / bomba) ─────────────────────────────────────
// Táguló, halványuló neon-gyűrű a megadott középponttól a maxRadius-ig. Tisztán
// rajzolt, nincs asset. (A robbanó kő 260 px-es hatósugarát vizualizálja.)
const SHOCK_DUR = 440;   // ms
let shockwaves = [];

export function spawnShockwave(x, y, maxRadius = 260, color = '#ff9b50') {
    shockwaves.push({ x, y, maxRadius, color, t: Date.now() });
}

// ── Lebegő pont-számok („+X", a pont nagyságával nő) ─────────────────────────
const POP_DUR = 850;   // ms
let pops = [];

export function spawnScorePop(x, y, amount, color = '#ffe9a8') {
    if (!amount || amount <= 0) return;
    pops.push({ x, y, amount, t: Date.now(), color });
}

// ── Frissítés (dt-alapú a részecskékre) ─────────────────────────────────────
export function updateEffects(dt) {
    if (dt > 0.1) dt = 0.1;   // tab-visszatérés / lag esetén ne ugorjon nagyot
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const damp = 1 - p.drag * dt;
        p.vx *= damp;
        p.vy *= damp;
    }
}

// ── Rajzolás (a game loop a shake-transzform alatt hívja, az objektumok után) ─
export function drawEffects(ctx) {
    const now = Date.now();

    // Lökéshullám-gyűrűk — táguló, halványuló neon-perem (a részecskék alatt)
    shockwaves = shockwaves.filter(s => now - s.t < SHOCK_DUR);
    for (const s of shockwaves) {
        const age = (now - s.t) / SHOCK_DUR;          // 0 → 1
        const r   = s.maxRadius * (0.18 + 0.82 * age);
        const a   = (1 - age) * 0.6;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = s.color;
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 14;
        ctx.lineWidth = 1 + 6 * (1 - age);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // Részecskék — halványuló, zsugorodó kis körök
    for (const p of particles) {
        const a = Math.max(0, p.life / p.maxLife);
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.35 + 0.65 * a), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // Torkolattűz — rövid, izzó villanás a hajó orránál (helyi -y irány)
    muzzles = muzzles.filter(m => now - m.t < MUZZLE_DUR);
    for (const m of muzzles) {
        const a = 1 - (now - m.t) / MUZZLE_DUR;
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(m.rot * Math.PI / 180);
        ctx.globalAlpha = a;
        ctx.shadowColor = m.color;
        ctx.shadowBlur = 16;
        ctx.fillStyle = m.color;
        ctx.beginPath();                       // kifelé nyúló láng
        ctx.moveTo(0, -4 - 16 * a);
        ctx.lineTo(-8 * a, 6);
        ctx.lineTo(8 * a, 6);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';             // fehér mag
        ctx.beginPath();
        ctx.arc(0, -2, 2 + 5 * a, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // Lebegő pont-számok — méret a pont/kombó nagyságával nő, felfelé halványul
    pops = pops.filter(p => now - p.t < POP_DUR);
    for (const p of pops) {
        const age   = (now - p.t) / POP_DUR;   // 0 → 1
        const alpha = 1 - age;
        const size  = 24 + Math.min(48, p.amount * 1.1);   // skálázódó méret
        const yy    = p.y - 28 - age * 72;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = 'center';
        ctx.font = `bold ${size}px Orbitron, Arial, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillStyle = p.color;
        ctx.strokeText(`+${p.amount}`, p.x, yy);
        ctx.fillText(`+${p.amount}`, p.x, yy);
        ctx.restore();
    }
}

// ── Reset (újraindításkor) ──────────────────────────────────────────────────
export function resetEffects() {
    particles = [];
    muzzles = [];
    pops = [];
    shockwaves = [];
    _shake = { intensity: 0, start: 0, duration: 1 };
}
