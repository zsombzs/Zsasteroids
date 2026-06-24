// js/remote_player.js — A partner (másik játékos) hajójának megjelenítése (2. fázis)
//
// CSAK rajzol + interpolál. Nincs input, nincs fizika, nincs ütközés-detektálás.
// A pozíciót a main.js Firebase-listenere tölti (update()), a draw() pedig minden
// frame-ben lágyan a célpozíció felé húz (a hálózati ~20fps simítása 60fps-en).
//
// FONTOS: NEM importál a main.js-ből (körkörös függőség elkerülése). Mindent
// paraméterként/konstruktorból kap.

import { SCREEN_WIDTH, SCREEN_HEIGHT } from './constants.js';

const LERP = 0.3;             // pozíció-interpoláció erőssége (0..1) frame-enként
const WRAP_JUMP = 600;        // ekkora ugrásnál teleportálunk (pálya-széli wrap)

export class RemotePlayer {
    constructor(spritePath, radius = 65.25, scale = 0.82) {
        this.position = { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 };
        this.target   = { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 };
        this.rotation = 0;
        this.targetRotation = 0;
        this.radius = radius;
        this.scale = scale;
        this.state = 'alive';
        this.reviveProgress = 0;  // 0..1 — a partner roncsának revive-gyűrűjéhez
        this.reviveCdUntil = 0;   // a partner revive-cooldownjának vége (a reviver nézi)
        this.visible = false;     // amíg nem érkezett első adat, ne rajzoljunk

        this.image = new Image();
        this.image.src = spritePath;
        this.imageLoaded = false;
        this.image.onload = () => { this.imageLoaded = true; };
    }

    // Firebase-adatból: célpozíció + rotáció + állapot.
    update(x, y, rotation, state) {
        if (typeof x !== 'number' || typeof y !== 'number') return;
        this.target.x = x;
        this.target.y = y;
        this.targetRotation = (typeof rotation === 'number') ? rotation : this.targetRotation;
        this.state = state || 'alive';
        this.visible = true;
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
        // Rotáció a legrövidebb irányban.
        let dr = this.targetRotation - this.rotation;
        while (dr > 180) dr -= 360;
        while (dr < -180) dr += 360;
        this.rotation += dr * LERP;
    }

    draw(ctx) {
        if (!this.visible || !this.imageLoaded) return;
        this._interpolate();

        const s = this.scale;
        ctx.save();
        ctx.translate(this.position.x, this.position.y);
        ctx.rotate(this.rotation * Math.PI / 180);
        // 'down' állapotban halványabb roncs.
        if (this.state === 'down') ctx.globalAlpha = 0.45;
        ctx.drawImage(
            this.image,
            -this.radius * s, -this.radius * s,
            this.radius * 2 * s, this.radius * 2 * s
        );
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
