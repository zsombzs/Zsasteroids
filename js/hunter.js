// js/hunter.js
// ──────────────────────────────────────────────────────────────────────────
// Vadász-drón (Hunter / lövő UFO) — csak space. A pálya széléről érkezik, majd
// TARTJA A TÁVOLSÁGOT a játékostól (standoff) és RÁ LŐ: ~FIRE_INTERVAL-onként egy
// izzó lövedéket a játékos felé. A lövedék ha eltalál → ugyanaz mint az ütközés
// (a döntést a main.js callbackje hozza: pajzs/grace/dash véd). A lövedék
// kitérhető és kilőhető (a saját lövéseddel). 3 HP — 3 találatra megsemmisül.
//
// A Strike mintáját követi: csak a `theme`-et importálja a main.js-ből, minden
// játéklogikát (pont, pajzs, halál, juice) callbackeken keresztül kap → nincs
// új körköros függőség. A lövedék rajzolt (nincs asset), a hang meglévő.
// ──────────────────────────────────────────────────────────────────────────
import { CircleShape } from './circleshape.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './constants.js';
import { theme } from './main.js';
import { playSound, getSoundVariant } from './soundManager.js';

const HUNTER_SPEED = 150;                       // px/s (a hajó 290 → lehagyható)
const HUNTER_TURN_RATE = 140 * Math.PI / 180;   // rad/s — a célra fordulás üteme
const HUNTER_LIFETIME = 13;                     // mp, utána lerepül
const HUNTER_HP = 3;
const HUNTER_RADIUS = 40;

const STANDOFF = 480;                 // ezt a távot próbálja tartani a játékostól
const STANDOFF_BAND = 80;             // ±sáv, amin belül „kering" (strafe)
const FIRE_FIRST_DELAY = 1.2;         // első lövés késleltetése spawn után (mp)
const FIRE_INTERVAL = 1.8;            // mp két lövés között
const ENEMY_SHOT_SPEED = 340;         // px/s
const ENEMY_SHOT_R = 11;              // lövedék sugár (hitbox + rajz)
const ENEMY_SHOT_LIFE = 4;            // mp, utána eltűnik

function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

class Hunter extends CircleShape {
    // onHitPlayer(): a drón VAGY a lövedéke eltalálta a hajót — a main.js dönt.
    // onKill(x, y):  lelőtték a drónt (3. találat) — a main.js ad pontot + juice-t.
    constructor(updatable, drawable, player, onHitPlayer, onKill) {
        // A pálya egyik széléről érkezik.
        let startX, startY;
        const edge = Math.floor(Math.random() * 4);
        if (edge === 0)      { startX = -60;               startY = Math.random() * SCREEN_HEIGHT; }
        else if (edge === 1) { startX = SCREEN_WIDTH + 60; startY = Math.random() * SCREEN_HEIGHT; }
        else if (edge === 2) { startX = Math.random() * SCREEN_WIDTH; startY = -60; }
        else                 { startX = Math.random() * SCREEN_WIDTH; startY = SCREEN_HEIGHT + 60; }
        super(startX, startY, HUNTER_RADIUS);

        this.updatable = updatable;
        this.drawable = drawable;
        this.player = player;
        this.onHitPlayer = onHitPlayer;
        this.onKill = onKill;

        this.hp = HUNTER_HP;
        this.age = 0;
        this.leaving = false;        // élettartam vége → kifelé sodródik, nem lő
        this.flashUntil = 0;         // találat-villanás vége (timestamp)

        this.fireTimer = FIRE_FIRST_DELAY;            // visszaszámláló a következő lövésig
        this.strafeDir = Math.random() < 0.5 ? 1 : -1; // keringés iránya (cw/ccw)
        this.projectiles = [];        // {x, y, vx, vy, life}

        // Kezdő irány a játékos felé.
        this.heading = Math.atan2(player.position.y - startY, player.position.x - startX);

        this.image = new Image();
        this.image.src = `/themes/${theme}/hunter.png`;

        this.updatable.push(this);
        this.drawable.push(this);
    }

    update(dt) {
        this.age += dt;
        if (this.age > HUNTER_LIFETIME) this.leaving = true;

        const dx = this.player.position.x - this.position.x;
        const dy = this.player.position.y - this.position.y;
        const dist = Math.hypot(dx, dy) || 1;

        // A drón a játékos felé fordul (hogy célozzon), korlátozott szögsebességgel.
        if (!this.leaving) {
            const targetAngle = Math.atan2(dy, dx);
            let diff = normAngle(targetAngle - this.heading);
            const maxTurn = HUNTER_TURN_RATE * dt;
            if (diff > maxTurn) diff = maxTurn;
            else if (diff < -maxTurn) diff = -maxTurn;
            this.heading += diff;
        }

        // Mozgás: tartja a STANDOFF távot — messziről közelít, közelről hátrál,
        // a sávon belül keringve strafe-el. Lerepüléskor a játékostól ELfelé sodródik.
        const ux = dx / dist, uy = dy / dist;   // egységvektor a játékos felé
        if (this.leaving) {
            this.position.x -= ux * HUNTER_SPEED * dt;
            this.position.y -= uy * HUNTER_SPEED * dt;
        } else if (dist > STANDOFF + STANDOFF_BAND) {
            this.position.x += ux * HUNTER_SPEED * dt;   // közelít
            this.position.y += uy * HUNTER_SPEED * dt;
        } else if (dist < STANDOFF - STANDOFF_BAND) {
            this.position.x -= ux * HUNTER_SPEED * dt;   // hátrál
            this.position.y -= uy * HUNTER_SPEED * dt;
        } else {
            // keringés a játékos körül (merőleges a rá-mutató irányra)
            this.position.x += -uy * this.strafeDir * HUNTER_SPEED * 0.75 * dt;
            this.position.y +=  ux * this.strafeDir * HUNTER_SPEED * 0.75 * dt;
        }

        // Lövés: a játékos felé, fix ütemben (lerepüléskor már nem lő).
        if (!this.leaving) {
            this.fireTimer -= dt;
            if (this.fireTimer <= 0) {
                this.fireTimer = FIRE_INTERVAL;
                this.fire(ux, uy);
            }
        }

        // Ramelés: ha mégis hozzáér a hajóhoz, az is ütközés (a callback dönt).
        if (!this.leaving && this.collidesWith(this.player)) {
            this.onHitPlayer();
            this.destroy();
            return;
        }

        // A játékos lövései a drónra: HP-1 + villanás; a 3. találatra megsemmisül.
        for (let shot of this.player.shots) {
            if (this.collidesWith(shot)) {
                shot.kill(this.updatable, this.drawable, this.player.shots);
                this.hp -= 1;
                this.flashUntil = Date.now() + 130;
                if (this.hp <= 0) {
                    this.onKill(this.position.x, this.position.y);
                    this.destroy();
                    return;
                } else {
                    playSound(getSoundVariant() ? '/assets/audio/adi_death.mp3' : '/assets/audio/hit.mp3', 0.12);
                }
                break;
            }
        }

        this.updateProjectiles(dt);

        // Lerepülés után, ha kiment a képből → törlés.
        if (this.leaving && (
            this.position.x < -160 || this.position.x > SCREEN_WIDTH + 160 ||
            this.position.y < -160 || this.position.y > SCREEN_HEIGHT + 160)) {
            this.destroy();
        }
    }

    fire(ux, uy) {
        this.projectiles.push({
            x: this.position.x, y: this.position.y,
            vx: ux * ENEMY_SHOT_SPEED, vy: uy * ENEMY_SHOT_SPEED,
            life: ENEMY_SHOT_LIFE,
        });
        playSound('/assets/audio/hunter_shot.mp3', 0.13);   // a hunter lövés-hangja
    }

    updateProjectiles(dt) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= dt;

            if (p.life <= 0 || p.x < -40 || p.x > SCREEN_WIDTH + 40 || p.y < -40 || p.y > SCREEN_HEIGHT + 40) {
                this.projectiles.splice(i, 1);
                continue;
            }

            // Eltalálta a hajót → a callback dönt (pajzs/grace/dash véd), lövedék eltűnik.
            const pdx = p.x - this.player.position.x, pdy = p.y - this.player.position.y;
            if (Math.hypot(pdx, pdy) < ENEMY_SHOT_R + this.player.hitboxRadius) {
                this.onHitPlayer();
                this.projectiles.splice(i, 1);
                continue;
            }

            // A játékos lövése kilőtte → mindkettő eltűnik (kivédhető).
            let shotDown = false;
            for (let shot of this.player.shots) {
                const sdx = p.x - shot.position.x, sdy = p.y - shot.position.y;
                if (Math.hypot(sdx, sdy) < ENEMY_SHOT_R + shot.hitboxRadius) {
                    shot.kill(this.updatable, this.drawable, this.player.shots);
                    shotDown = true;
                    break;
                }
            }
            if (shotDown) this.projectiles.splice(i, 1);
        }
    }

    draw(ctx) {
        const scale = 1.3;
        const ds = this.radius * 2 * scale;
        const now = Date.now();
        const flashing = now < this.flashUntil;
        const glow = 0.5 + 0.5 * Math.sin(now / 140);

        // ── Lövedékek (izzó vörös-narancs bolt, additív) ──
        for (const p of this.projectiles) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.shadowColor = 'rgba(255, 90, 40, 0.9)';
            ctx.shadowBlur = 14;
            ctx.fillStyle = '#ff7a3a';
            ctx.beginPath();
            ctx.arc(p.x, p.y, ENEMY_SHOT_R, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(p.x, p.y, ENEMY_SHOT_R * 0.45, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // ── A drón sprite ──
        ctx.save();
        ctx.translate(this.position.x, this.position.y);
        ctx.rotate(this.heading + Math.PI / 2);   // a sprite orra felfelé néz → a heading felé fordul
        ctx.shadowColor = `rgba(255, 70, 40, ${0.6 + 0.3 * glow})`;
        ctx.shadowBlur = 18 + 8 * glow;

        if (this.image.complete && this.image.naturalWidth) {
            ctx.drawImage(this.image, -ds / 2, -ds / 2, ds, ds);
            if (flashing) {
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.6;
                ctx.drawImage(this.image, -ds / 2, -ds / 2, ds, ds);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
            }
        } else {
            ctx.beginPath();
            ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = '#ff5a2a';
            ctx.fill();
        }
        ctx.restore();

        // ── HP-pipák a drón fölött (3 szegmens) ──
        const pipW = 12, gap = 5;
        const total = HUNTER_HP * pipW + (HUNTER_HP - 1) * gap;
        const x0 = this.position.x - total / 2;
        const y = this.position.y - ds / 2 - 14;
        for (let i = 0; i < HUNTER_HP; i++) {
            ctx.fillStyle = i < this.hp ? '#ff6a3a' : 'rgba(255, 255, 255, 0.18)';
            ctx.fillRect(x0 + i * (pipW + gap), y, pipW, 5);
        }
    }

    destroy() {
        const iu = this.updatable.indexOf(this);
        if (iu > -1) this.updatable.splice(iu, 1);
        const id = this.drawable.indexOf(this);
        if (id > -1) this.drawable.splice(id, 1);
    }
}

export { Hunter };
