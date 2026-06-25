// js/remote_player.js — A partner (másik játékos) hajójának megjelenítése
//
// CSAK rajzol + interpolál. Nincs input, nincs fizika, nincs ütközés-detektálás.
// A pozíciót + vizuál-állapotot (lövedékek, pajzs, dash, hajtómű-láng) a main.js
// Firebase-listenere tölti (update()), a draw() pedig minden frame-ben lágyan a
// célpozíció felé húz, a lövedékeket a sebességükkel extrapolálja.
//
// FONTOS: NEM importál a main.js-ből (körkörös függőség elkerülése).

import { SCREEN_WIDTH, SCREEN_HEIGHT, SHOT_RADIUS } from './constants.js';

const LERP = 0.3;             // pozíció-interpoláció erőssége (0..1) frame-enként
const WRAP_JUMP = 600;        // ekkora ugrásnál teleportálunk (pálya-széli wrap)

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export class RemotePlayer {
    constructor(spritePath, radius = 65.25, scale = 0.82, shotColor = '#7fe0ff') {
        this.position = { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 };
        this.target   = { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 };
        this.rotation = 0;
        this.targetRotation = 0;
        this.radius = radius;
        this.scale = scale;
        this.shotColor = shotColor;
        this.state = 'alive';
        this.reviveProgress = 0;  // 0..1 — a partner roncsának revive-gyűrűjéhez
        this.reviveCdUntil = 0;   // a partner revive-cooldownjának vége (a reviver nézi)
        this.visible = false;     // amíg nem érkezett első adat, ne rajzoljunk

        // Partner-vizuálok (Firebase-ből szinkronizálva).
        this.shield = false;
        this.dashing = false;
        this.thrust = false;      // előre halad (W) → hajtómű-láng
        this.shots = [];          // [{x, y, vx, vy}] — a partner aktív lövedékei
        this.shotsAt = 0;         // utolsó lövedék-frissítés ideje (extrapolációhoz)
        this._prevShotCount = 0;
        this._muzzleUntil = 0;    // torkolattűz-villanás vége (új lövésnél)

        // FONTOS: nem onload/imageLoaded flagre építünk (Safariban a cache-elt kép
        // már `complete` lehet, mire az onload-ot beállítjuk → sosem sülne el).
        // Helyette rajzoláskor a `complete && naturalWidth`-et nézzük.
        this.image = new Image();
        this.image.decoding = 'async';
        this.image.src = spritePath;
    }

    // Firebase-adatból: célpozíció + rotáció + állapot + (opcionálisan) vizuál-állapot.
    update(x, y, rotation, state, extra) {
        if (typeof x !== 'number' || typeof y !== 'number') return;
        this.target.x = x;
        this.target.y = y;
        this.targetRotation = (typeof rotation === 'number') ? rotation : this.targetRotation;
        this.state = state || 'alive';
        this.visible = true;

        if (extra) {
            this.shield  = !!extra.shield;
            this.dashing = !!extra.dash;
            this.thrust  = !!extra.thrust;
            const shots = Array.isArray(extra.shots) ? extra.shots : [];
            if (shots.length > this._prevShotCount) this._muzzleUntil = _now() + 90;
            this._prevShotCount = shots.length;
            this.shots = shots;
            this.shotsAt = _now();
        }
        if (this.state === 'down') {
            this.shots = []; this.shield = false; this.dashing = false; this.thrust = false;
        }
    }

    _interpolate() {
        const dx = this.target.x - this.position.x;
        const dy = this.target.y - this.position.y;
        if (Math.abs(dx) > WRAP_JUMP || Math.abs(dy) > WRAP_JUMP) {
            this.position.x = this.target.x;
            this.position.y = this.target.y;
        } else {
            this.position.x += dx * LERP;
            this.position.y += dy * LERP;
        }
        let dr = this.targetRotation - this.rotation;
        while (dr > 180) dr -= 360;
        while (dr < -180) dr += 360;
        this.rotation += dr * LERP;
    }

    draw(ctx) {
        if (!this.visible) return;
        this._interpolate();

        const now = _now();
        const s = this.scale;
        const rad = this.rotation * Math.PI / 180;
        const imgOK = this.image.complete && this.image.naturalWidth;
        const alive = this.state !== 'down';

        // ── Partner lövedékei (vx/vy-vel extrapolálva) ── (kép nélkül is megy)
        if (alive && this.shots.length) {
            const dt = Math.min(0.3, (now - this.shotsAt) / 1000);
            ctx.save();
            ctx.fillStyle = this.shotColor;
            for (const sh of this.shots) {
                ctx.beginPath();
                ctx.arc(sh.x + (sh.vx || 0) * dt, sh.y + (sh.vy || 0) * dt, SHOT_RADIUS, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        // ── Dash utánkép: 2 halványuló hajó-másolat hátrafelé (a hajó orra -y) ──
        if (alive && this.dashing && imgOK) {
            const bx = -Math.sin(rad), by = Math.cos(rad);   // hátrafelé egységvektor
            for (let i = 1; i <= 2; i++) {
                ctx.save();
                ctx.globalAlpha = 0.24 - 0.07 * i;
                ctx.translate(this.position.x + bx * 18 * i, this.position.y + by * 18 * i);
                ctx.rotate(rad);
                ctx.drawImage(this.image, -this.radius * s, -this.radius * s, this.radius * 2 * s, this.radius * 2 * s);
                ctx.restore();
            }
        }

        // ── Pajzs-gyűrű ── (kép nélkül is)
        if (alive && this.shield) {
            const pulse = 0.5 + 0.5 * Math.sin(now / 120);
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.beginPath();
            ctx.arc(0, 0, this.radius * s + 10, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(127, 224, 255, ${0.45 + 0.35 * pulse})`;
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.restore();
        }

        // ── Hajtómű-láng: előre haladáskor VAGY dash közben (a hajó mögött, +y) ──
        if (alive && (this.thrust || this.dashing)) {
            const flick = 0.55 + Math.random() * 0.45;
            const boost = this.dashing ? 1.8 : 1;
            const baseY = this.radius * s * 0.5;
            const len   = this.radius * s * (0.85 + 0.5 * flick) * boost;
            const halfW = this.radius * s * 0.32 * (this.dashing ? 1.25 : 1);
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.rotate(rad);
            const grad = ctx.createLinearGradient(0, baseY, 0, baseY + len);
            grad.addColorStop(0,    'rgba(150, 240, 255, 0.9)');
            grad.addColorStop(0.45, 'rgba(70, 170, 255, 0.55)');
            grad.addColorStop(1,    'rgba(70, 150, 255, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(-halfW, baseY);
            ctx.lineTo(halfW, baseY);
            ctx.lineTo(0, baseY + len);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = `rgba(255, 255, 255, ${0.55 * flick})`;
            ctx.beginPath();
            ctx.moveTo(-halfW * 0.45, baseY);
            ctx.lineTo(halfW * 0.45, baseY);
            ctx.lineTo(0, baseY + len * 0.62);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        // ── A hajó ── (csak ha betöltött a kép)
        if (imgOK) {
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.rotate(rad);
            if (!alive) ctx.globalAlpha = 0.45;
            ctx.drawImage(this.image, -this.radius * s, -this.radius * s, this.radius * 2 * s, this.radius * 2 * s);
            // Torkolattűz a hajó orránál (rövid villanás új lövésnél).
            if (alive && now < this._muzzleUntil) {
                const a = (this._muzzleUntil - now) / 90;
                ctx.globalAlpha = a;
                ctx.fillStyle = '#fff2cc';
                ctx.beginPath();
                ctx.arc(0, -this.radius * s - 2, 4 + 5 * a, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }

        if (!alive) this._drawReviveRing(ctx);
    }

    _drawReviveRing(ctx) {
        const r = 70;
        ctx.save();
        ctx.translate(this.position.x, this.position.y);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 6;
        ctx.stroke();
        const p = Math.max(0, Math.min(1, this.reviveProgress));
        if (p > 0) {
            ctx.beginPath();
            ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
            ctx.strokeStyle = '#5cff9d';
            ctx.lineWidth = 6;
            ctx.stroke();
        }
        ctx.restore();
    }
}
