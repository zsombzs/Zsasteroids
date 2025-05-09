export const urlParams = new URLSearchParams(window.location.search);
export const theme = urlParams.get('theme') || 'space';

import { Player } from './player.js';
import { AsteroidField } from './asteroidfield.js';
import { Shot } from './shot.js';
import { Asteroid } from './asteroid.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './constants.js';
import { supabase } from './supabase.js';
import { PowerUp } from "./powerup.js";

document.body.style.backgroundImage = `url('themes/${theme}/background.jpg')`;


let canvas = document.getElementById('gameCanvas');
let ctx = canvas.getContext('2d');

canvas.width = SCREEN_WIDTH;
canvas.height = SCREEN_HEIGHT;

let updatable = [];
export let drawable = [];
let shots = [];
let asteroids = [];

let highScores = [];
let scoreSubmitted = false;

export let powerUps = [];

window.keys = {};
document.addEventListener('keydown', function(event) {
    window.keys[event.key.toLowerCase()] = true;
});

document.addEventListener('keyup', function(event) {
    window.keys[event.key.toLowerCase()] = false;
});



let player = new Player(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2, updatable, drawable, shots);
updatable.push(player);
drawable.push(player);

let asteroidField = new AsteroidField(updatable, drawable, asteroids);
updatable.push(asteroidField);

let gameOver = false;
let countdownStarted = false;
let countdownStartTime = 0;
let countdownRunning = true;
let showGameOver = false;
let gameOverTime = 0;

let gameTime = 60;
let gameStartTime = 0;
let powerUpSpawnTime = 0;
let timeRemaining = gameTime;

let score = 0;

function updateScoreFromHitbox(hitboxRadius) {

    if (hitboxRadius > 71) {
        score += 1;
    } else if (hitboxRadius > 56 && hitboxRadius <= 71) {
        score += 2;
    } else if (hitboxRadius > 38.5 && hitboxRadius <= 56) {
        score += 3;
    } else if (hitboxRadius > 18 && hitboxRadius <= 38.5) {
        score += 4;
    } else if (hitboxRadius <= 18) {
        score += 5;
    }
}

let powerUpImage = new Image();
powerUpImage.src = `themes/${theme}/boost.png`;

const textColor = theme === 'ocean' ? '#f3f3b6' : 'red';
const timeColor = theme === 'ocean' ? 'white' : 'white';

function gameLoop() {
    let now = Date.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;

    ctx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);  // Clear screen
    ctx.drawImage(backgroundImage, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = "48px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Zsasteroids", canvas.width / 2, 50);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '24px Arial';
    ctx.textAlign = 'right';
    ctx.fillText("Score: " + score, SCREEN_WIDTH - 10, 30);
    ctx.restore();

    if (countdownRunning) {
        if (!countdownStarted) {
            countdownStartTime = Date.now();
            countdownStarted = true;
        }

        let elapsedTime = (Date.now() - countdownStartTime) / 1000;

        let displayText = "";
        if (elapsedTime < 1) {
            displayText = "3";
        } else if (elapsedTime < 2) {
            displayText = "2";
        } else if (elapsedTime < 3) {
            displayText = "1";
        } else if (elapsedTime < 4) {
            displayText = "START";
        } else {
            countdownRunning = false;
            gameStartTime = Date.now();
            powerUpSpawnTime = gameStartTime + 5000;
        }

        ctx.font = '74px Arial';
        ctx.fillStyle = textColor;
        ctx.fillText(displayText, SCREEN_WIDTH / 2 - ctx.measureText(displayText).width / 2, SCREEN_HEIGHT / 2);
    } else if (gameOver) {
        if (!showGameOver) {
            showGameOver = true;
        }

        let elapsedGameOver = (Date.now() - gameOverTime) / 1000;
        
        if (elapsedGameOver < 3) {
            ctx.save();
            ctx.font = '74px Arial';
            ctx.fillStyle = textColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("GAME OVER", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
            ctx.restore();
            
        } else {
            ctx.save();
            ctx.font = '48px Arial';
            ctx.fillStyle = textColor;
            ctx.textAlign = 'center';
            ctx.fillText("Final Score: " + score, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - 50);
            ctx.restore();

            restartButton.style.display = "block";
        }
    } else {
        if (gameStartTime === 0) {
            gameStartTime = Date.now();
        }

        const elapsedGameTime = (Date.now() - gameStartTime) / 1000;
        timeRemaining = Math.max(0, gameTime - elapsedGameTime);

        if (timeRemaining <= 0) {
            gameOver = true;
            gameOverTime = Date.now();
            if (!scoreSubmitted) {
                saveScore(score);
                scoreSubmitted = true;
                fetchTopScores();
            }
        }
        updatable.forEach(object => object.update(dt));

        for (let asteroid of asteroids) {
            
            if (player.collidesWith(asteroid)) {
/*                 console.log("Game over!"); */
                gameOver = true;
                gameOverTime = Date.now();
                if (!scoreSubmitted) {
                    saveScore(score);
                    scoreSubmitted = true;
                    fetchTopScores();
                }
                break;
            }

            for (let bullet of shots) {
                if (asteroid.collidesWith(bullet)) {
                    bullet.kill(updatable, drawable, shots);
                    const hitboxBeforeSplit = asteroid.hitboxRadius;
                    updateScoreFromHitbox(hitboxBeforeSplit);
                    asteroid.split();
                    break;
                }
            }
        }

        drawable.forEach(object => object.draw(ctx));

        if (Date.now() >= powerUpSpawnTime) {
            spawnPowerUp();
            powerUpSpawnTime = Date.now() + 15000;
        }
    }
    ctx.save();
    ctx.fillStyle = timeColor;
    ctx.font = '20px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(`Time left: ${Math.ceil(timeRemaining)}s`, 20, 30);
    ctx.restore();

    if (!gameOver && player.powerUpEndTime) {
        const remaining = (player.powerUpEndTime - Date.now()) / 1000;
    
        if (remaining > 0) {
            ctx.fillStyle = timeColor;
            ctx.font = "18px Arial";
            ctx.fillText(`Power-up time: ${remaining.toFixed(1)}s`, 21, 60);
        } else {
            player.powerUpEndTime = null;
        }
    }

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('W = forward   A = rotate left   D = rotate right   S = backward   SPACE = shoot', 10, SCREEN_HEIGHT - 10);
    ctx.restore();

    const iconSize = 20;
    const iconX = 7;
    const iconY = canvas.height -50;
    if (powerUpImage.complete) {
        ctx.drawImage(powerUpImage, iconX, iconY, iconSize, iconSize);
    }

    ctx.font = "14px Arial";
    ctx.fillStyle = textColor;
    ctx.fillText("- Power-Up: Doubles speed and fire rate", iconX + iconSize + 10, iconY + 15);

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '18px Arial';
    ctx.textAlign = 'right';

    ctx.fillText("Top Scores:", SCREEN_WIDTH - 10, SCREEN_HEIGHT - 450);

    let startY = SCREEN_HEIGHT - 430;
    let padding = 18;
    
    highScores.forEach((entry, index) => {
        let indexText = `${index + 1}.`;
        let scoreText = entry.score.toString();
    
        ctx.fillText(indexText, SCREEN_WIDTH - 50, startY + index * padding);
        
        ctx.fillText(scoreText, SCREEN_WIDTH -10, startY + index * padding);
    });
    
    ctx.restore();

    requestAnimationFrame(gameLoop);
}

let lastTime = Date.now();
let backgroundImage = new Image();
backgroundImage.src = `themes/${theme}/background.jpg`;

const radius = 23

function spawnPowerUp() {
    let x = Math.random() * (SCREEN_WIDTH - 2 * radius) + radius;
    let y = Math.random() * (SCREEN_HEIGHT - 2 * radius) + radius;
    let p = new PowerUp(x, y);
    powerUps.push(p);
    drawable.push(p);
    updatable.push(p);
}

backgroundImage.onload = function() {
    gameLoop();
};
fetchTopScores();
gameLoop();


function restartGame() {
    updatable.length = 0;
    drawable.length = 0;
    shots.length = 0;
    asteroids.length = 0;

    player = new Player(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2, updatable, drawable, shots);
    updatable.push(player);
    drawable.push(player);

    asteroidField = new AsteroidField(updatable, drawable, asteroids);
    updatable.push(asteroidField);

    gameOver = false;
    showGameOver = false;
    gameOverTime = 0;
    countdownStarted = false;
    countdownStartTime = 0;
    countdownRunning = true;

    score = 0
    scoreSubmitted = false;

    gameStartTime = Date.now()

    restartButton.style.display = "none";

    lastTime = Date.now();
    requestAnimationFrame(gameLoop);
}


let restartButton = document.getElementById("restartButton");
restartButton.addEventListener("click", () => {
    restartGame();
});

async function saveScore(score) {
    await supabase.from('scores').insert([{ score }]);
}

async function fetchTopScores() {
    const { data, error } = await supabase
        .from('scores')
        .select('score')
        .order('score', { ascending: false })
        .limit(10);
    if (!error) {
        highScores = data;
    }
}