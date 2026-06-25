// js/remote_player.js — A partner (másik játékos) hajójának megjelenítése
//
// CSAK rajzol + interpolál. Nincs input, nincs fizika, nincs ütközés-detektálás.
// A pozíciót + vizuál-állapotot (lövedékek, pajzs, dash) a main.js Firebase-listenere
// tölti (update()), a draw() pedig minden frame-ben lágyan a célpozíció felé húz
// (a hálózati ~20fps simítása 60fps-en), a lövedékeket pedig a sebességükkel
// extrapolálja a két frissítés között.
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
        this.shots = [];          // [{x, y, vx, vy}] — a partner aktív lövedékei
        this.shotsAt = 0;         // utolsó lövedék-frissítés ideje (extrapolációhoz)
        this._prevShotCount = 0;
        this._muzzleUntil = 0;    // torkolattűz-villanás vége (új lövésnél)

        this.image = new Image();
        this.image.src = spritePath;
        this.imageLoaded = false;
        this.image.onload = () => { this.imageLoaded = true; };
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
            const shots = Array.isArray(extra.shots) ? extra.shots : [];
            // Új lövedék megjelent → torkolattűz-villanás.
            if (shots.length > this._prevShotCount) this._muzzleUntil = _now() + 90;
            this._prevShotCount = shots.length;
            this.shots = shots;
            this.shotsAt = _now();
        }
        if (this.state === 'down') { this.shots = []; this.shield = false; this.dashing = false; }
    }

    // Lágy közelítés a célpozícióhoz; wrap-around nagy ugrásnál teleport.
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

        // ── Partner lövedékei (vx/vy-vel extrapolálva a 20fps simítására) ──
        if (this.state !== 'down' && this.shots.length) {
            const dt = Math.min(0.3, (now - this.shotsAt) / 1000);
            ctx.save();
            ctx.fillStyle = this.shotColor;
            for (const s of this.shots) {
                const sx = s.x + (s.vx || 0) * dt;
                const sy = s.y + (s.vy || 0) * dt;
                ctx.beginPath();
                ctx.arc(sx, sy, SHOT_RADIUS, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        if (!this.imageLoaded) return;

        const s = this.scale;

        // ── Pajzs-gyűrű ──
        if (this.shield && this.state !== 'down') {
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

        // ── Dash-aura ──
        if (this.dashing && this.state !== 'down') {
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.beginPath();
            ctx.arc(0, 0, this.radius * s + 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(127, 224, 255, 0.18)';
            ctx.fill();
            ctx.restore();
        }

        // ── A hajó ──
        ctx.save();
        ctx.translate(this.position.x, this.position.y);
        ctx.rotate(this.rotation * Math.PI / 180);
        if (this.state === 'down') ctx.globalAlpha = 0.45;
        ctx.drawImage(
            this.image,
            -this.radius * s, -this.radius * s,
            this.radius * 2 * s, this.radius * 2 * s
        );
        // Torkolattűz a hajó orránál (rövid villanás új lövésnél).
        if (this.state !== 'down' && now < this._muzzleUntil) {
            const a = (this._muzzleUntil - now) / 90;
            ctx.globalAlpha = a;
            ctx.fillStyle = '#fff2cc';
            ctx.beginPath();
            ctx.arc(0, -this.radius * s - 2, 4 + 5 * a, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.restore();

        // Revive-gyűrű a partner roncsa körül (amíg 'down').
        if (this.state === 'down') {
            this._drawReviveRing(ctx);
        }
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
