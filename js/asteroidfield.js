import { Asteroid } from './asteroid.js';
import { ASTEROID_MAX_RADIUS, ASTEROID_SPAWN_RATE, ASTEROID_MIN_RADIUS, ASTEROID_KINDS, SCREEN_WIDTH, SCREEN_HEIGHT } from './constants.js';
import { theme } from './main.js';

// Robbanó kő (csak space): a TELJES játékon elosztva. Egy robbanó után minimum
// EXPLOSIVE_MIN_GAP másodperc szünet, utána spawn-onként EXPLOSIVE_CHANCE eséllyel
// jön a következő. (Korábban kemény „max 3/játék" cap volt, ami a játék elején
// elhasználódott — utána egy sem jött. Ezt cseréljük idő-alapú elosztásra.)
const EXPLOSIVE_CHANCE = 0.50;     // a szünet letelte után spawn-onkénti esély
const EXPLOSIVE_MIN_GAP = 2;     // mp két robbanó között

class AsteroidField {
    constructor(updatable, drawable, asteroids) {
        this.edges = [
            [
                { x: 1, y: 0 },
                (y) => new Vector2(-ASTEROID_MAX_RADIUS, y * SCREEN_HEIGHT),
            ],
            [
                { x: -1, y: 0 },
                (y) => new Vector2(SCREEN_WIDTH + ASTEROID_MAX_RADIUS, y * SCREEN_HEIGHT),
            ],
            [
                { x: 0, y: 1 },
                (x) => new Vector2(x * SCREEN_WIDTH, -ASTEROID_MAX_RADIUS),
            ],
            [
                { x: 0, y: -1 },
                (x) => new Vector2(x * SCREEN_WIDTH, SCREEN_HEIGHT + ASTEROID_MAX_RADIUS),
            ]
        ];
        this.updatable = updatable;
        this.drawable = drawable;
        this.asteroids = asteroids;
        this.spawn_timer = 0;
        // Dinamikus spawn-intervallum (mp). A main.js a játékidő alapján állítja
        // (eszkaláció + utolsó 10 mp frenzy). Alapból a konstans érték.
        this.spawnInterval = ASTEROID_SPAWN_RATE;
        // Az első robbanó már a játék elején jöhet; utána a MIN_GAP osztja el őket.
        this.timeSinceExplosive = EXPLOSIVE_MIN_GAP;
    }

    spawn(radius, position, velocity, type = 'normal') {
        let asteroid = new Asteroid(position.x, position.y, radius, this.updatable, this.drawable, this.asteroids, type);
        asteroid.velocity = velocity;
        this.updatable.push(asteroid);
        this.drawable.push(asteroid);
        this.asteroids.push(asteroid);
    }

    update(dt) {
        this.spawn_timer += dt;
        this.timeSinceExplosive += dt;

        if (this.spawn_timer > this.spawnInterval) {
            this.spawn_timer = 0;

            let edge = this.edges[Math.floor(Math.random() * this.edges.length)];
            let kind = Math.floor(Math.random() * ASTEROID_KINDS) + 1;

            // Gyorsabb, pörgősebb mező: alap 90–170 px/s, és a KISEBB aszteroidák
            // (alacsonyabb kind) gyorsabbak — méret-fordított sebesség.
            let baseSpeed = Math.floor(Math.random() * (170 - 90 + 1)) + 90;
            let sizeFactor = 1.5 - (kind - 1) * (0.7 / (ASTEROID_KINDS - 1)); // kind1≈1.5 … kind5≈0.8
            let speed = baseSpeed * sizeFactor;

            let velocity = new Vector2(edge[0].x, edge[0].y).multiply(speed);
            let randomRotation = Math.floor(Math.random() * (30 - -30 + 1)) + -30;
            velocity = velocity.rotate(randomRotation);
            let position = edge[1](Math.random());

            // Típus: space-en a szünet letelte után esélyesen robbanó kő — így a
            // robbanók a teljes játékon elosztva jelennek meg, nem csak az elején.
            let type = 'normal';
            if (theme === 'space' && this.timeSinceExplosive >= EXPLOSIVE_MIN_GAP
                && Math.random() < EXPLOSIVE_CHANCE) {
                type = 'explosive';
                this.timeSinceExplosive = 0;
            }

            this.spawn(ASTEROID_MIN_RADIUS * kind, position, velocity, type);
        }
    }
}

class Vector2 {
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }

    multiply(scalar) {
        return new Vector2(this.x * scalar, this.y * scalar);
    }

    rotate(angle) {
        let radians = angle * (Math.PI / 180);
        let cos = Math.cos(radians);
        let sin = Math.sin(radians);
        return new Vector2(
            this.x * cos - this.y * sin,
            this.x * sin + this.y * cos
        );
    }
}

export { AsteroidField };
