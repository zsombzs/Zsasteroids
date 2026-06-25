import { CircleShape } from "./circleshape.js";
import { theme } from "./main.js";
import { getImage } from "./imageCache.js";
class PowerUp extends CircleShape {
    constructor(x, y, type = "boost") {
        super(x, y, 34.5, 31.5);
        this.type = type;
        this.image = getImage(`/themes/${theme}/${type}.png`);
    }

    draw(ctx) {
        if (this.image.complete && this.image.naturalWidth) {
            // A FELVÉTELI hitbox a player.collidesWithCircle-ben player.radius (65.25) +
            // this.radius alapján számít — ez nagyobb, mint amekkorának az ikon eddig
            // látszott (a player kirajzolt sugara ~53.5 space-en). Ezért az ikont
            // VIZUÁLISAN nagyobbra rajzoljuk (VISUAL_SCALE), az ütközés VÁLTOZATLAN —
            // így a kép széle nagyjából a felvétel pillanatában ér a hajóhoz.
            const VISUAL_SCALE = 1.3;
            // Space témán maga az ikon pulzál (mérete), hogy jobban kitűnjön a pályán.
            const pulse = theme === 'space' ? (1 + 0.12 * Math.sin(Date.now() / 180)) : 1;
            const r = this.radius * VISUAL_SCALE * pulse;
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.drawImage(this.image, -r, -r, r * 2, r * 2);
            ctx.restore();
        }
/*              // Debug: kör hitbox kirajzolása
            ctx.beginPath();
            ctx.arc(this.position.x -1, this.position.y + 1, this.hitboxRadius, 0, 2 * Math.PI);
            ctx.strokeStyle = "red";
            ctx.lineWidth = 2;
            ctx.stroke(); */
    }

    update(dt) {

    }
}

export { PowerUp };
