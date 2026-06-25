import { CircleShape } from './circleshape.js';
import { ASTEROID_MIN_RADIUS } from './constants.js';
import { Player } from "./player.js"
import { theme } from "./main.js"
import { getImage } from "./imageCache.js"
import { isLowQuality } from "./effects.js"

class Asteroid extends CircleShape {
    constructor(x, y, radius, updatable, drawable, asteroids, type = 'normal') {
        super(x, y, radius, undefined, { x: -3, y: 0 });

        this.updatable = updatable;
        this.drawable = drawable;
        this.asteroids = asteroids;

        // Típus (csak space): 'normal' | 'explosive'. A robbanó kő nem hasad, hanem
        // láncreakciót indít (a logika a main.js detonateExplosive-ben él).
        this.type = type;
        this.dead = false;   // a láncreakció után ne dolgozzuk fel/öljük újra

        this.rotation = Math.random() * Math.PI * 2;

        // Közös cache: a téma aszteroida-sprite-ját egyszer töltjük be, minden
        // példány ezt használja (a drawImage úgyis explicit méretet kap).
        const file = type === 'explosive' ? 'asteroid_explosive' : 'asteroid';
        this.image = getImage(`/themes/${theme}/${file}.png`);
        this.hitboxOffset = { x: 0, y: theme === 'ocean' ? -4 : 0 };
        this.setHitbox();
    }

    draw(ctx) {
        let scale;
        if (theme === 'ocean') {
          scale = 1.45;
        } else if (theme === 'jungle') {
          scale = 1.27;
        } else if (theme === 'ww2') {
            scale = 0.965;
        } else if (theme === 'city') {
            scale = 0.965;
        }  else {
          scale = 1;
        }

        const drawX = this.position.x;
        const drawY = this.position.y;
        const drawSize = this.radius * 2 * scale;
        
        ctx.save();

        ctx.translate(drawX, drawY);
        ctx.rotate(this.rotation);

        // Robbanó kő: lüktető vörös ragyogás, hogy egyértelmű legyen „lődd meg a
        // láncért" (csak space). Tisztán rajzolt, az asset fölé.
        if (this.type === 'explosive' && theme === 'space' && !isLowQuality()) {
            const p = 0.6 + 0.4 * Math.sin(Date.now() / 160);
            ctx.shadowColor = `rgba(255, 90, 40, ${0.7 * p})`;
            ctx.shadowBlur = 24 * p;
        }

        ctx.drawImage(
            this.image,
            -drawSize / 2,
            -drawSize / 2,
            drawSize,
            drawSize
        );

/*         const hitboxX = this.hitboxOffset?.x || 0;
        const hitboxY = this.hitboxOffset?.y || 0;
        
        // Debug kör kirajzolása a transzformált koordinátákhoz viszonyítva
        ctx.beginPath();
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 1;
        ctx.arc(hitboxX, hitboxY, this.hitboxRadius, 0, Math.PI * 2);
        ctx.stroke();
        
        // Debug szöveg kirajzolása
        ctx.fillStyle = 'lime';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`r: ${this.radius}`, 0, -this.radius - 10); */

        ctx.restore();
    }

    update(dt) {
        this.position.x += this.velocity.x * dt;
        this.position.y += this.velocity.y * dt;
    }

    setHitbox() {
        if (this.radius === 48) {
            this.hitboxRadius = 36;
        } else if (this.radius === 96) {
            this.hitboxRadius = 70;
        } else if (this.radius === 144) {
            this.hitboxRadius = 112;
        } else if (this.radius === 192) {
            this.hitboxRadius = 150;
        } else if (this.radius === 240) {
            this.hitboxRadius = 185;
        } else {
            this.hitboxRadius = this.radius * 0.75;
        }
    }
    

    split() {
        if (this.radius < (ASTEROID_MIN_RADIUS / 2)) {
            this.kill();
            return;
        }
    
        for (let i = 0; i < 2; i++) {
            let newRadius = this.radius / 2;
            let newAsteroid = new Asteroid(this.position.x, this.position.y, newRadius, this.updatable, this.drawable, this.asteroids);
    
            let angle = Math.random() * 360;
            let rad = angle * Math.PI / 180;
            let speed = Math.random() * 100 + 110;   // 110–210: a szétlőtt kis darabok is pörögnek
            newAsteroid.velocity = {
                x: Math.cos(rad) * speed,
                y: Math.sin(rad) * speed
            };

            newAsteroid.setHitbox();
    
            this.updatable.push(newAsteroid);
            this.drawable.push(newAsteroid);
            this.asteroids.push(newAsteroid);
        }
    
        this.kill();
    }

    kill() {
        this.dead = true;   // a collision-loop és a láncreakció ezt nézi (ne kétszerezzünk)
        const indexUpdatable = this.updatable.indexOf(this);
        if (indexUpdatable > -1) this.updatable.splice(indexUpdatable, 1);
    
        const indexDrawable = this.drawable.indexOf(this);
        if (indexDrawable > -1) this.drawable.splice(indexDrawable, 1);
    
        const indexAsteroids = this.asteroids.indexOf(this);
        if (indexAsteroids > -1) this.asteroids.splice(indexAsteroids, 1);
    }
    
}

export { Asteroid };
