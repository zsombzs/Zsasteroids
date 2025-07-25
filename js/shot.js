import { CircleShape } from './circleshape.js';
import { SHOT_RADIUS } from './constants.js';
import { theme } from "./main.js";

import { getMuted, getSoundVariant } from './soundManager.js';

function playShootSound() {
    if (getMuted()) return;
  
    let path = '/assets/audio/shoot.mp3';
    if (getSoundVariant()) {
      path = '/assets/audio/bodizs_piu.mp3';
    }
  
    const shootSound = new Audio(path);
    shootSound.volume = 0.1;
    shootSound.currentTime = 0;
    shootSound.play().catch(e => console.log('Shoot sound error:', e));
  }
  
  export { playShootSound };

class Shot extends CircleShape {
    constructor(x, y) {
        super(x, y, SHOT_RADIUS);
        playShootSound();
        
    }

    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.position.x, this.position.y, this.radius, 0, 2 * Math.PI);
        if (theme === "ocean") {
            ctx.fillStyle = 'yellow';
        } else if (theme === "jungle") {
            ctx.fillStyle = 'rgb(43, 255, 5)';
        } else if (theme === "ww2") {
            ctx.fillStyle = '#cae9ff';
        } else if (theme === "city") {
            ctx.fillStyle = 'rgb(255, 213, 0)';
        } else {
            ctx.fillStyle = 'red';
        }
        ctx.fill();
        ctx.closePath();
    }

    update(dt) {
        this.position.x += this.velocity.x * dt;
        this.position.y += this.velocity.y * dt;
    }
    kill(updatable, drawable, shots) {
        const indexUpdatable = updatable.indexOf(this);
        if (indexUpdatable > -1) updatable.splice(indexUpdatable, 1);

        const indexDrawable = drawable.indexOf(this);
        if (indexDrawable > -1) drawable.splice(indexDrawable, 1);

        const indexShots = shots.indexOf(this);
        if (indexShots > -1) shots.splice(indexShots, 1);
    }
}

export { Shot };
