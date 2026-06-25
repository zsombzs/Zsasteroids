import { CircleShape } from './circleshape.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './constants.js';
import { theme } from './main.js';
import { getImage } from './imageCache.js';

class Strike extends CircleShape {
    constructor(updatable, drawable, player, onHitPlayer, onHitByShot) {
        const startX = Math.random() < 0.5 ? -50 : SCREEN_WIDTH + 50;
        const startY = Math.random() * SCREEN_HEIGHT;
        const radius = 38;
        super(startX, startY, radius);

        this.updatable = updatable;
        this.drawable = drawable;
        this.player = player;
        this.onHitPlayer = onHitPlayer;
        this.onHitByShot = onHitByShot;

        this.targetX = SCREEN_WIDTH / 2;
        this.targetY = SCREEN_HEIGHT / 2;

        const dx = this.targetX - this.position.x;
        const dy = this.targetY - this.position.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const speed = distance / 1;
        this.velocity = {
            x: (dx / distance) * speed,
            y: (dy / distance) * speed
        };

        this.updatable.push(this);
        this.drawable.push(this);

        this.image = getImage(`/themes/${theme}/strike.png`);
    }

    update(dt) {
        this.position.x += this.velocity.x * dt;
        this.position.y += this.velocity.y * dt;

        if (this.collidesWith(this.player)) {
            this.onHitPlayer();
            this.destroy();
        }

        for (let shot of this.player.shots) {
            if (this.collidesWith(shot)) {
                this.onHitByShot();
                shot.kill(this.updatable, this.drawable, this.player.shots);
                this.destroy();
                break;
            }
        }

        if (this.position.x < -50 || this.position.x > SCREEN_WIDTH + 50 || 
            this.position.y < -50 || this.position.y > SCREEN_HEIGHT + 50) {
            this.destroy();
        }
    }

    draw(ctx) {
        let scale = 1;
        if (theme === 'jungle') {
            scale = 1.06;
        } else if (theme === 'space') {
            scale = 1.34;
        } else if (theme === 'ocean') {
            scale = 1.4;
        } else if (theme === 'ww2') {
            scale = 1.3;
        } else if (theme === 'city') {
            scale = 1.15;
        }
        

        const drawSize = this.radius * 2 * scale;
        const baseAngle = Math.atan2(this.velocity.y, this.velocity.x);
        let angle = baseAngle;
        let flipX = false;
        
        if (this.velocity.x < 0) {
            flipX = true;
            angle = -baseAngle;
        }
        
        ctx.save();
        ctx.translate(this.position.x, this.position.y);

        if (flipX) {
            ctx.scale(1, -1);
        }
        ctx.rotate(angle);
        
        if (this.image.complete) {
            ctx.drawImage(this.image, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
        } else {
            ctx.beginPath();
            ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = 'red';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'white';
            ctx.stroke();
        }
        ctx.restore();
        
    
        ctx.restore();

/*             // Debug: kör hitbox kirajzolása
            ctx.beginPath();
            ctx.arc(this.position.x -1, this.position.y + 1, this.hitboxRadius, 0, 2 * Math.PI);
            ctx.strokeStyle = "red";
            ctx.lineWidth = 2;
            ctx.stroke(); */
    }

    destroy() {
        const indexUpdatable = this.updatable.indexOf(this);
        if (indexUpdatable > -1) this.updatable.splice(indexUpdatable, 1);

        const indexDrawable = this.drawable.indexOf(this);
        if (indexDrawable > -1) this.drawable.splice(indexDrawable, 1);
    }
}

export { Strike };