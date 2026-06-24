import { CircleShape } from "./circleshape.js"
import { PLAYER_SHOOT_SPEED, PLAYER_SPEED, PLAYER_TURN_SPEED } from "./constants.js";
import { Shot } from "./shot.js"
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./constants.js";
import { powerUps, drawable } from "./main.js"
import { theme } from "./main.js"

import { playSound, getSoundVariant } from './soundManager.js';
import { spawnMuzzleFlash } from './effects.js';

// ── Dash (csak space) — gyors lökés a nézési irányba, i-frame-mel ────────────
export const DASH_SPEED = 900;        // px/s a dash ideje alatt (a normál 290 fölött)
export const DASH_DURATION_MS = 180;  // ~0,18 mp lökés
export const DASH_COOLDOWN_MS = 2500; // ~2,5 mp visszatöltés
const DASH_TRAIL_MAX = 5;             // utánkép-másolatok száma

class Player extends CircleShape {
    
    constructor(x, y, updatable, drawable, shots) {
        super(x, y, 65.25, 33.75);
        this.rotation = 0;
        this.shootTimer = 0;
        this.updatable = updatable;
        this.drawable = drawable;
        this.shots = shots;
        this.image = new Image();
        this.image.src = `/themes/${theme}/spaceship.png`;
        this.image.onload = () => {
            this.imageLoaded = true;
        };
        this.imageLoaded = false
        this.speedMultiplier = 1;
        this.shootTimerMultiplier = 1;
        this.powerUpTimeout = null

        this.multishotActive = false;
        this.multishotEndTime = null;

        // Shield powerup (csak a space témán spawnol): a következő ütközést elnyeli,
        // majd 1 mp sebezhetetlenség (a pajzs gyorsan villog, jelezve a lejáratot).
        this.shieldActive = false;       // van aktív pajzs (elnyeli a köv. ütközést)
        this.shieldBreakingUntil = null; // ütközés utáni 1 mp grace vége (timestamp)

        // Dash (csak space): él-trigger a main.js Shift-figyelőjéből (tryDash).
        this.dashUntil = null;           // amíg fut a dash (timestamp); ezalatt i-frame
        this.dashReadyAt = 0;            // ekkortól lehet újra dash-elni (cooldown vége)
        this.dashCooldownMs = DASH_COOLDOWN_MS;  // a HUD ennyiből számolja a sávot
        this.dashDir = { x: 0, y: -1 };  // a dash-induláskor rögzített irány
        this.trail = [];                 // utánkép-history {x, y, rot}

        // Multiplayer: ha 'down' (lelőtték, élesztésre vár), a hajó nem mozog/lő és
        // nem rajzolódik (a main.js roncsot + revive-gyűrűt rajzol helyette). Default
        // false → a singleplayer viselkedés változatlan.
        this.disabled = false;
    }

    activateShield() {
        this.shieldActive = true;
        this.shieldBreakingUntil = null;
    }

    breakShield() {
        this.shieldActive = false;
        this.shieldBreakingUntil = Date.now() + 1000;   // 1 mp sebezhetetlenség
    }

    // Pajzs-grace (NEM tartalmazza a dash-t) — a pajzs-buborék és a HUD-chip ezt nézi,
    // hogy a dash i-frame ne villantsa fel a pajzsot.
    _inShieldGrace() {
        return this.shieldBreakingUntil !== null && Date.now() < this.shieldBreakingUntil;
    }

    isDashing() {
        return this.dashUntil !== null && Date.now() < this.dashUntil;
    }

    // Dash indítása (Shift). Egy lenyomás = egy dash; az él-triggerről a main.js
    // gondoskodik (a window.keys nyomva tartott állapot lenne). Cooldown alatt no-op.
    tryDash() {
        const now = Date.now();
        if (now < this.dashReadyAt) return;
        this.dashReadyAt = now + DASH_COOLDOWN_MS;
        this.dashUntil = now + DASH_DURATION_MS;
        const dir = this.vector(0, -1).rotate(this.rotation);   // aktuális nézési irány
        this.dashDir = { x: dir.x, y: dir.y };
        playSound('/assets/audio/strike_whoosh.mp3', 0.25);     // meglévő hang, halkan
    }

    // Sebezhetetlenség: pajzs-grace VAGY dash i-frame (az ütközés-ellenőrzések ezt használják).
    isInvincible() {
        return this._inShieldGrace() || this.isDashing();
    }

    draw(ctx) {
        if (this.disabled) return;   // 'down' állapotban a main.js rajzol roncsot + gyűrűt
        let scale;
        if (theme === 'ocean') {
          scale = 0.9;
        } else if (theme === 'space') {
            scale = 0.82;
        }  else if (theme === 'jungle') {
          scale = 0.9;
        } else if (theme === 'ww2') {
            scale = 0.64;
        } else if (theme === 'city') {
            scale = 0.67;
        } else {
          scale = 1;
        }
        // Dash utánkép: a hajó 2–3 halványuló másolata a korábbi pozíciókon
        // (csak space). A hajó alatt rajzoljuk, így a friss hajó van legfelül.
        if (theme === 'space' && this.imageLoaded && this.trail.length) {
            for (let i = 0; i < this.trail.length; i++) {
                const t = this.trail[i];
                // Wrap-around ugrás esetén ne húzzunk csíkot a túloldalra.
                if (Math.abs(t.x - this.position.x) > 600 || Math.abs(t.y - this.position.y) > 600) continue;
                const a = 0.10 + 0.12 * i;   // régebbi (kis i) halványabb
                ctx.save();
                ctx.globalAlpha = a;
                ctx.translate(t.x, t.y);
                ctx.rotate(t.rot * Math.PI / 180);
                ctx.drawImage(this.image, -this.radius * scale, -this.radius * scale, this.radius * 2 * scale, this.radius * 2 * scale);
                ctx.restore();
            }
        }

        // Világoskék védőpajzs a hajó körül. Egyenletes lágy pulzálás amíg aktív;
        // ütközés után gyors villogás 1 mp-ig (jelzi, hogy mindjárt eltűnik).
        // FONTOS: csak a pajzs-grace számít (NEM a dash i-frame), különben a dash
        // felvillantaná a pajzsot.
        if (this.shieldActive || this._inShieldGrace()) {
            const now = Date.now();
            let intensity;
            if (this._inShieldGrace()) {
                intensity = (Math.floor(now / 70) % 2 === 0) ? 1 : 0.28;   // gyors villogás
            } else {
                intensity = 0.78 + 0.22 * Math.sin(now / 280);             // fényes pulzálás
            }
            const r = this.radius * 0.8;   // kisebb, a hajóhoz simuló buborék
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            // neon ragyogás (glow)
            ctx.shadowColor = `rgba(0, 225, 255, ${intensity})`;
            ctx.shadowBlur = 18;
            // halvány belső kitöltés
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(40, 210, 255, ${intensity * 0.14})`;
            ctx.fill();
            // kompakt, fényes neon perem (széles glow + világos mag)
            ctx.lineWidth = 5;
            ctx.strokeStyle = `rgba(0, 200, 255, ${intensity * 0.55})`;
            ctx.stroke();
            ctx.lineWidth = 2;
            ctx.strokeStyle = `rgba(190, 250, 255, ${intensity})`;
            ctx.stroke();
            ctx.restore();
        }

        // Hajtómű-láng: előre haladáskor (W) VAGY dash közben lobogó kipufogó a hajó
        // mögött (csak space). A hajó orra a helyi -y irányba néz, így a láng a +y
        // (far) felé nyúlik. Dash közben felerősödik. Tisztán rajzolt, nincs asset.
        const dashingNow = this.isDashing();
        if (theme === 'space' && ((window.keys && window.keys['w']) || dashingNow)) {
            const flick = 0.55 + Math.random() * 0.45;
            const boost = dashingNow ? 1.8 : 1;   // dash alatt hosszabb, dúsabb láng
            const baseY = this.radius * scale * 0.5;
            const len   = this.radius * scale * (0.85 + 0.5 * flick) * boost;
            const halfW = this.radius * scale * 0.32 * (dashingNow ? 1.25 : 1);
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.rotate(this.rotation * Math.PI / 180);
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

        if (this.imageLoaded) {
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.rotate(this.rotation * Math.PI / 180);
            ctx.drawImage(this.image, -this.radius * scale, -this.radius * scale, this.radius * 2 * scale, this.radius * 2 * scale);
            ctx.restore();
        }
/*              // Debug: kör hitbox kirajzolása
            ctx.beginPath();
            ctx.arc(this.position.x -1, this.position.y + 1, this.hitboxRadius, 0, 2 * Math.PI);
            ctx.strokeStyle = "red";
            ctx.lineWidth = 2;
            ctx.stroke(); */

    }
    

    rotate(speed) {
        this.rotation += speed;
    }

    update(dt) {
        if (this.disabled) return;   // 'down' állapotban nincs mozgás/lövés
        this.shootTimer -= dt;

        if (this.multishotActive && Date.now() > this.multishotEndTime) {
            this.multishotActive = false;
        }

        if (window.keys['a']) {
            this.rotate(-PLAYER_TURN_SPEED * dt);
        }
        if (window.keys['d']) {
            this.rotate(PLAYER_TURN_SPEED * dt);
        }
        const dashing = this.isDashing();
        if (dashing) {
            // Dash: rögzített irányba, magas sebességgel — felülírja a normál W/S tolást.
            this.position.x += this.dashDir.x * DASH_SPEED * dt;
            this.position.y += this.dashDir.y * DASH_SPEED * dt;
        } else {
            if (window.keys['w']) {
                this.move(PLAYER_SPEED * dt);
            }
            if (window.keys['s']) {
                this.move(-PLAYER_SPEED * dt);
            }
        }
        if (window.keys[' ']) {
            this.shoot();
        }
            // Wrap-around logic
        if (this.position.x < -this.hitboxRadius) {
            this.position.x = SCREEN_WIDTH + this.hitboxRadius;
        } else if (this.position.x > SCREEN_WIDTH + this.hitboxRadius) {
            this.position.x = -this.hitboxRadius;
            }

        if (this.position.y < -this.hitboxRadius) {
            this.position.y = SCREEN_HEIGHT + this.hitboxRadius;
        } else if (this.position.y > SCREEN_HEIGHT + this.hitboxRadius) {
            this.position.y = -this.hitboxRadius;
            }

        // Dash utánkép-history (csak space): dash közben minden frame rögzítünk egy
        // pozíciót; dash után frame-enként ürül → rövid, elhalványuló farok.
        if (theme === 'space') {
            if (dashing) {
                this.trail.push({ x: this.position.x, y: this.position.y, rot: this.rotation });
                if (this.trail.length > DASH_TRAIL_MAX) this.trail.shift();
            } else if (this.trail.length) {
                this.trail.shift();
            }
        }

        powerUps.forEach((powerUp, index) => {
            if (this.collidesWithCircle(powerUp)) {
                if (getSoundVariant()) {
                    playSound("/assets/audio/adi_good.mp3", 0.15);
                  } else {
                    playSound("/assets/audio/powerup_activated.mp3", 0.15);
                  }
                powerUps.splice(index, 1);
                drawable.splice(drawable.indexOf(powerUp), 1);
                if (powerUp.type === "boost") {
                    this.activatePowerUp();
                } else if (powerUp.type === "multishot") {
                    this.activateMultishot();
                } else if (powerUp.type === "shield") {
                    this.activateShield();
                }
            }
        });
        
        if (this.multishotActive && this.multishotEndTime && Date.now() > this.multishotEndTime) {
            this.multishotActive = false;
            this.multishotEndTime = null;
        }
     }
    

    move(dt) {
        let forward = this.vector(0, -1).rotate(this.rotation);
        this.position.x += forward.x * dt * this.speedMultiplier;
        this.position.y += forward.y * dt * this.speedMultiplier;
    }

    shoot() {
        if (this.shootTimer > 0) return;
        this.shootTimer = 0.3  * this.shootTimerMultiplier;;
        let forward = this.vector(0, -1).rotate(this.rotation);

        // Torkolattűz a hajó orránál (csak space) — rövid, izzó villanás.
        if (theme === 'space') {
            spawnMuzzleFlash(
                this.position.x + forward.x * this.radius,
                this.position.y + forward.y * this.radius,
                this.rotation
            );
        }

        let shot1 = new Shot(this.position.x, this.position.y);
        shot1.velocity = {
            x: forward.x * PLAYER_SHOOT_SPEED,
            y: forward.y * PLAYER_SHOOT_SPEED
        };
        this.updatable.push(shot1);
        this.drawable.push(shot1);
        this.shots.push(shot1);

        if (this.multishotActive) {
            const angleOffset = 15;
        
            let offsetLeft = this.vector(-10, 0).rotate(this.rotation);
            let shot2 = new Shot(this.position.x + offsetLeft.x, this.position.y + offsetLeft.y);
            let rotatedLeft = this.vector(forward.x, forward.y).rotate(-angleOffset);
            shot2.velocity = {
                x: rotatedLeft.x * PLAYER_SHOOT_SPEED,
                y: rotatedLeft.y * PLAYER_SHOOT_SPEED
            };
            this.updatable.push(shot2);
            this.drawable.push(shot2);
            this.shots.push(shot2);
        
            let offsetRight = this.vector(10, 0).rotate(this.rotation);
            let shot3 = new Shot(this.position.x + offsetRight.x, this.position.y + offsetRight.y);
            let rotatedRight = this.vector(forward.x, forward.y).rotate(angleOffset);
            shot3.velocity = {
                x: rotatedRight.x * PLAYER_SHOOT_SPEED,
                y: rotatedRight.y * PLAYER_SHOOT_SPEED
            };
            this.updatable.push(shot3);
            this.drawable.push(shot3);
            this.shots.push(shot3);
        }
        
    }

    vector(x, y) {
        const createVector = (x, y) => ({
            x,
            y,
            rotate(angle) {
                let rad = angle * Math.PI / 180;
                let cos = Math.cos(rad);
                let sin = Math.sin(rad);
                return createVector(
                    this.x * cos - this.y * sin,
                    this.x * sin + this.y * cos
                );
            },
            multiply(scalar) {
                return createVector(this.x * scalar, this.y * scalar);
            }
        });
    
        return createVector(x, y);
        }

    collidesWithCircle(circle) {
        let adjustedX = this.position.x - 1;
        let adjustedY = this.position.y + 1;
        
        let dx = adjustedX - circle.position.x;
        let dy = adjustedY - circle.position.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        
        return distance < (this.radius + circle.radius);
    }
    
    activatePowerUp() {
        this.speedMultiplier = 2;
        this.shootTimerMultiplier = 0.5;

        this.powerUpEndTime = Date.now() + 8000

        if (this.powerUpTimeout) clearTimeout(this.powerUpTimeout);

        clearTimeout(this.powerUpTimeout);
        this.powerUpTimeout = setTimeout(() => {
            this.speedMultiplier = 1;
            this.shootTimerMultiplier = 1;
            this.powerUpTimeout = null;
            this.powerUpEndTime = null;
        }, 8000);
    }

    activateMultishot() {
        this.multishotActive = true;
        this.multishotEndTime = Math.max(this.multishotEndTime, Date.now() + 8000);
    }
}

export { Player };
