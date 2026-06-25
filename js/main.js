export const urlParams = new URLSearchParams(window.location.search);

// Csak ismert témák engedélyezettek — az URL-paraméter sosem kerül nyersen
// erőforrás-útvonalba (path traversal / külső erőforrás betöltés megelőzése).
//
// EGYELŐRE CSAK A SPACE TÉMA JÁTSZHATÓ (a többi téma "Coming soon" a főoldalon).
// Ha valaki közvetlenül egy másik téma URL-jét nyitja meg (?theme=ocean stb.),
// visszairányítjuk a főoldalra, hogy a játék biztosan csak space témán fusson.
const ALLOWED_THEMES = ['space'];
const requestedTheme = urlParams.get('theme');
if (requestedTheme && requestedTheme !== 'space') {
  window.location.replace('/index.html');
}
export const theme = ALLOWED_THEMES.includes(requestedTheme) ? requestedTheme : 'space';

// ── Multiplayer (co-op) paraméterek ──
// Ha az URL-ben van érvényes lobby + role, multiplayer módban vagyunk. Singleplayerben
// minden MP-kód kimarad (isMultiplayer === false), a meglévő flow változatlan.
// A lobby kód az URL-ből Firebase-útvonalakba kerül (lobbies/${lobbyCode}/…),
// ezért szigorúan validáljuk: pontosan 4 nagybetűs alfanumerikus karakter (a
// generált kódok formátuma). Így nem juthat be veszélyes path-karakter (/ . # $ [ ]).
const LOBBY_CODE_RE = /^[A-Z0-9]{4}$/;
const rawLobby = urlParams.get('lobby');
const lobbyCode = (rawLobby && LOBBY_CODE_RE.test(rawLobby)) ? rawLobby : null;
// Ha van lobby paraméter, de érvénytelen formátumú (elgépelt / crafted URL),
// vissza a főmenübe — ne fusson rosszul felépített útvonalakkal.
if (rawLobby && !lobbyCode) {
  window.location.replace('/index.html');
}
const role = urlParams.get('role');                 // 'host' | 'guest'
const isMultiplayer = !!lobbyCode && (role === 'host' || role === 'guest');
const isHost = role === 'host';
const otherRole = isHost ? 'guest' : 'host';
// "hostSim": ez a kliens futtatja-e az autoritatív szimulációt (spawn, ütközés,
// pont, split). Singleplayerben és a hostnál igen; a guestnél nem — ő a host
// aszteroidáit és a közös pontot jeleníti meg (thin client).
const hostSim = !isMultiplayer || isHost;

import { Player } from '/js/player.js';
import { AsteroidField } from '/js/asteroidfield.js';
import { Shot } from '/js/shot.js';
import { Asteroid } from '/js/asteroid.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '/js/constants.js';
import { db, ref, push, get, set, update, remove, onValue, onDisconnect } from '/js/firebase.js';
import { RemotePlayer } from '/js/remote_player.js';
import { initAuth, currentUser, currentProfile, signInWithGoogle, createProfile, isUsernameTaken } from '/js/auth.js';
import { PowerUp } from "/js/powerup.js";
import { Strike } from '/js/strike.js';
import { Hunter } from '/js/hunter.js';

import { toggleMuted, getMuted } from './soundManager.js';
import { playSound, toggleSoundVariant, getSoundVariant, preloadSounds } from './soundManager.js';

// Játék-hangok előtöltése induláskor: így gyenge neten az első megszólalás
// (lövés, robbanás, powerup, strike) sem akad meg — a fájlok a cache-ből jönnek.
preloadSounds([
    '/assets/audio/shoot.mp3',
    '/assets/audio/explosion.mp3',
    '/assets/audio/hit.mp3',
    '/assets/audio/start.mp3',
    '/assets/audio/countdown.mp3',
    '/assets/audio/gameover.mp3',
    '/assets/audio/powerup_spawned.mp3',
    '/assets/audio/powerup_activated.mp3',
    '/assets/audio/strike_alarm.mp3',
    '/assets/audio/strike_whoosh.mp3',
    '/assets/audio/strike_earned.mp3',
    '/assets/audio/shield_gone.mp3',
    '/assets/audio/hunter_shot.mp3',
    // hang-variáns ("adibodizs") effektek — szintén előre dekódolva
    '/assets/audio/adi_death.mp3',
    '/assets/audio/adi_good.mp3',
]);

// ── Sprite-ok előtöltése + betöltő-kapu ──
// A 3-2-1 visszaszámlálás csak akkor indul, ha a sprite-ok és a háttér betöltöttek
// → nincs „beugrás" és menet közbeni hitch. A hangok közben a háttérben dekódolódnak.
const PRELOAD_SPRITES = [
    `/themes/${theme}/background.webp`,
    `/themes/${theme}/spaceship.png`,
    `/themes/${theme}/asteroid.png`,
    `/themes/${theme}/asteroid_explosive.png`,
    `/themes/${theme}/boost.png`,
    `/themes/${theme}/multishot.png`,
    `/themes/${theme}/shield.png`,
    `/themes/${theme}/strike.png`,
    `/themes/${theme}/hunter.png`,
];
let assetsReady = false;
let loadProgress = 0;            // 0–1, a betöltő-kijelzőhöz
let _loadDone = 0;
preloadImages(PRELOAD_SPRITES, () => {
    _loadDone++;
    loadProgress = _loadDone / PRELOAD_SPRITES.length;
}).then(() => {
    assetsReady = true;
    // Multiplayer: jelezzük a partnernek, hogy az assetjeink betöltöttek (szinkron start).
    if (isMultiplayer) {
        update(ref(db, `lobbies/${lobbyCode}/ready`), { [role]: true }).catch(() => {});
    }
});

// Service Worker: offline / gyenge-net cache (lásd /sw.js).
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}

// Game feel / „juice" effektek (csak space) — screen shake, részecske-robbanás,
// torkolattűz, lebegő pont-számok. Lásd js/effects.js.
import {
    shake, getShakeOffset, spawnExplosion, spawnScorePop, spawnShockwave,
    updateEffects, drawEffects, resetEffects, SHAKE_OVERSCAN,
    isLowQuality, tickQuality,
} from '/js/effects.js';
import { getImage, preloadImages } from '/js/imageCache.js';

// A juice-effektek csak a space témán aktívak (a többi téma változatlan marad).
const juice = theme === 'space';

document.body.style.backgroundImage = `url('/themes/${theme}/background.webp')`;

let canvas = document.getElementById('gameCanvas');
let ctx = canvas.getContext('2d');

// ── DOM HUD overlay ──
// Ha a téma HTML-je tartalmaz #hud elemet, a HUD-ot DOM-overlayen rajzoljuk
// (reszponzív, animálható), és a canvasra rajzolt HUD-ot kihagyjuk. Ha nincs
// #hud (a többi téma egyelőre), marad a régi canvas HUD — semmi sem változik.
const useDomHud = !!document.getElementById('hud');
const hudEls = useDomHud ? {
  time: document.getElementById('hudTimeValue'),
  timeBar: document.getElementById('hudTimeBar'),
  score: document.getElementById('hudScoreValue'),
  plus: document.getElementById('hudScorePlus'),
  combo: document.getElementById('hudCombo'),
  comboText: document.getElementById('hudComboText'),
  comboBar: document.getElementById('hudComboBar'),
  boost: document.getElementById('hudBoost'),
  boostBar: document.getElementById('hudBoostBar'),
  multishot: document.getElementById('hudMultishot'),
  multishotBar: document.getElementById('hudMultishotBar'),
  shield: document.getElementById('hudShield'),
  dash: document.getElementById('hudDash'),
  dashBar: document.getElementById('hudDashBar'),
  strike: document.getElementById('hudStrike'),
  strikeText: document.getElementById('hudStrikeText'),
  frenzy: document.getElementById('hudFrenzy'),
  controlsHint: document.getElementById('hudControlsHint'),
  help: document.getElementById('hudHelpPanel'),
  gameOver: document.getElementById('gameOverPanel'),
  goCard: document.getElementById('goCard'),
  goResult: document.getElementById('goResult'),
  goScore: document.getElementById('goScore'),
  goScoresBody: document.getElementById('goScoresBody'),
  goScoresTitle: document.getElementById('goScoresTitle'),
  goBadge: document.getElementById('goBadge'),
  goBadgeText: document.getElementById('goBadgeText'),
  goRank: document.getElementById('goRank'),
  goBest: document.getElementById('goBest'),
  goBestCard: document.getElementById('goBestCard'),
  goPerf: document.getElementById('goPerf'),
  goSigninBtn: document.getElementById('goSigninBtn'),
  goConfetti: document.getElementById('goConfetti'),
} : null;

function resizeCanvas() {
    const targetHeightRatio = 0.96;
    const targetWidthRatio = 0.94;
    const aspectRatio = SCREEN_WIDTH / SCREEN_HEIGHT;

    const maxHeight = window.innerHeight * targetHeightRatio;
    const maxWidth = maxHeight * aspectRatio * targetWidthRatio;

    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;

    canvas.style.width = `${maxWidth}px`;
    canvas.style.height = `${maxHeight}px`;

    ctx.imageSmoothingEnabled = false;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
  

let updatable = [];
export let drawable = [];
let shots = [];
let asteroids = [];

let highScores = [];
let scoreSubmitted = false;
let scoreClaimed = false;     // a pont hozzá lett-e rendelve bejelentkezett userhez (névvel kiírva)
let pendingGuestScore = false;// vendég-pont, ami még NINCS kiírva (várjuk a login/profil döntést)
let lastGameScore = 0;        // a legutóbb befejezett játék (sanitizált) pontszáma

export let powerUps = [];

window.keys = {};
document.addEventListener('keydown', function(event) {
    window.keys[event.key.toLowerCase()] = true;
});

document.addEventListener('keyup', function(event) {
    window.keys[event.key.toLowerCase()] = false;
});

// Dash (csak space): Shift él-trigger — egy fizikai lenyomás = egy dash. A
// window.keys nyomva tartott állapot lenne (a key-repeat folyamatosan dash-elne),
// ezért külön figyelő + held-flag. A cooldownt a Player.tryDash() kezeli.
let _shiftHeld = false;
document.addEventListener('keydown', function(event) {
    if (event.key === 'Shift' && !_shiftHeld) {
        _shiftHeld = true;
        if (theme === 'space' && player && !gameOver && !countdownRunning) player.tryDash();
    }
});
document.addEventListener('keyup', function(event) {
    if (event.key === 'Shift') _shiftHeld = false;
});



let player = new Player(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2, updatable, drawable, shots);
updatable.push(player);
drawable.push(player);

// Az aszteroida-mezőt csak az autoritatív kliens (singleplayer vagy host) futtatja.
// A guestnél nincs spawnolás — az aszteroidákat a host Firebase-en át küldi.
let asteroidField = null;
if (hostSim) {
    asteroidField = new AsteroidField(updatable, drawable, asteroids);
    updatable.push(asteroidField);
}

// ── MULTIPLAYER: pozíció + aszteroida + közös pont szinkron (2-4. fázis) ──────
// A partner hajóját egy RemotePlayer példány jeleníti meg. A saját pozíciónkat
// throttle-olva küldjük. A HOST emellett kiküldi az aszteroida-listát és a közös
// pontot; a GUEST ezeket fogadja és megjeleníti (thin client). A lövés/ütközés-
// szinkron (5. fázis) és a halál/revive (6. fázis) még NEM része ennek — egyelőre
// co-opban senki nem hal meg, és csak a host lövései pusztítják az aszteroidákat.
let remotePlayer = null;
let mpOtherUnsub = null;
let mpAsteroidsUnsub = null;
let mpScoreUnsub = null;
let mpHitsUnsub = null;
let mpHudUnsub = null;
let mpLastSendTime = 0;
let mpLastWorldSend = 0;
let mpAsteroidCounter = 0;
const MP_SEND_INTERVAL = 50;    // ~20 pozíció-küldés/mp
const MP_WORLD_INTERVAL = 90;   // ~11 aszteroida+pont szinkron/mp
// Partner-jelenlét (heartbeat + timeout). Ez a MEGBÍZHATÓ kilépés-detektálás:
// nem az onDisconnectre/security rules-ra hagyatkozik, hanem arra, hogy a partner
// node-ja folyamatosan frissül (hb). Ha rég nem jött tőle frissítés → kilépett.
let mpLastHb = 0;
let mpLastPartnerSeen = 0;      // utolsó frissítés a partner node-járól
let mpSeenPartner = false;      // láttuk-e már egyszer a partnert (startup-grace)
const MP_HB_INTERVAL = 1000;    // saját heartbeat gyakorisága
const MP_PARTNER_TIMEOUT = 7000;// ennyi frissítés-szünet után tekintjük kilépettnek
const mpGuestAsteroids = new Map();   // id -> Asteroid (csak guest)
// Optimista predikció (guest): a lokálisan kilőtt kövek id-je → mikor lőttük ki.
// Amíg a host vissza nem igazolja a törlést (a sync már nem tartalmazza), addig
// nem keltjük újra életre. Ha a timeout alatt sem törli a host (találat nem ment
// át), feloldjuk és hagyjuk újraéledni.
const mpGuestPredictedKills = new Map();
const MP_PREDICT_TIMEOUT = 2000;

// ── Phase 6: halál / proximity-revive / round end + powerup-szinkron ──────────
const REVIVE_RADIUS = 160;      // px — ekkora zónában lebegve éleszthető a társ
const REVIVE_HOLD_MS = 2500;    // ennyit kell a zónában maradni
const REVIVE_DECAY = 1.5;       // kilépéskor ennyiszer gyorsabban csorog vissza
const REVIVE_IFRAME_MS = 2000;  // feléledés utáni sebezhetetlenség
const REVIVE_CD_MS = 10000;     // revive-cooldown: feléledés után ennyi ideig nem éleszthető újra

let mpPowerupsUnsub = null;
let mpSelfUnsub = null;
let mpStatusUnsub = null;
let mpRoundUnsub = null;
let mpLobbyRootUnsub = null;     // a teljes lobby figyelése (partner-lecsatlakozás → menü)
let mpReadyUnsub = null;         // betöltés-szinkron: ki töltötte be az assetjeit
let mpCountdownAtUnsub = null;   // a közös countdown-anchor figyelése
let mpHunterUnsub = null;        // GUEST: a host hunter-állapotát figyeli
let mpHHitsUnsub = null;         // HOST: a guest hunter-találatait figyeli
let mpHunterState = null;        // GUEST: a legutóbb fogadott hunter-állapot (null = nincs)
let mpHunterAt = 0;              // GUEST: mikor érkezett (lövedék-extrapolációhoz)
let mpHHitCounter = 0;           // GUEST: egyedi kulcs a hunter-találat-jelentésekhez
const mpProcessedHHits = new Set(); // HOST: már feldolgozott guest-hunter-találatok
let mpPartnerReady = false;      // a partner jelezte-e, hogy az assetjei betöltöttek
let mpCountdownAt = 0;           // közös countdown-kezdő időbélyeg (a host állítja be)
let mpFirstStartDone = false;    // megtörtént-e már az első (szinkronizált) indítás
let mpPartnerLeft = false;       // igaz, ha a partner kilépett (egyszeri menü-visszadobás)
let mpRoundLocal = 0;            // a legutóbb alkalmazott co-op kör sorszáma (play again)
let localState = 'alive';            // a saját játékos állapota: 'alive' | 'down'
let mpWreck = { x: 0, y: 0, rot: 0 };// a saját roncs pozíciója (amíg down)
let reviveInvincibleUntil = 0;       // feléledés utáni i-frame vége
let myReviveProgress = 0;            // a saját roncs gyűrűjéhez (a reviver írja a node-omba)
let mpReviveTimer = 0;               // a reviver lokális hold-ideje (ms)
let mpRoundEnded = false;
let mpLastRevWrite = 0;
let mpHostName = null, mpGuestName = null;
let mpPowerupCounter = 0;
const mpPowerups = new Map();        // id -> PowerUp (mindkét kliens)
const mpConsumedPowerups = new Set();// lokálisan felvett powerupok (reconcile ne hozza vissza)

if (isMultiplayer) {
    // A partner külön színű hajót kap (a 2. játékos feltöltött sprite-ja).
    remotePlayer = new RemotePlayer('/themes/space/secondplayer.png');

    // A másik játékos pozíciója + revive-állapota.
    mpOtherUnsub = onValue(ref(db, `lobbies/${lobbyCode}/players/${otherRole}`), (snap) => {
        const d = snap.val();
        if (!d) return;
        // Jelenlét: minden partner-frissítés (pozíció / heartbeat / revive) "életjel".
        mpSeenPartner = true;
        mpLastPartnerSeen = Date.now();
        remotePlayer.update(d.x, d.y, d.rotation, d.state, d);
        remotePlayer.reviveProgress = d.reviveProgress || 0;
        remotePlayer.reviveCdUntil = d.reviveCdUntil || 0;
    });

    // Saját node figyelése: a reviver innen állítja vissza 'alive'-ra (feléledés),
    // és innen olvassuk a saját revive-gyűrű haladását + cooldownt.
    mpSelfUnsub = onValue(ref(db, `lobbies/${lobbyCode}/players/${role}`), (snap) => {
        const d = snap.val();
        if (!d) return;
        myReviveProgress = d.reviveProgress || 0;
        if (localState === 'down' && d.state === 'alive') {
            // Feléledtem.
            localState = 'alive';
            player.disabled = false;
            if (typeof d.x === 'number' && typeof d.y === 'number') {
                player.position.x = d.x;
                player.position.y = d.y;
            }
            reviveInvincibleUntil = d.invincibleUntil || (Date.now() + REVIVE_IFRAME_MS);
        }
    });

    // Powerupok (host spawnolja, mindkét fél fogadja és rendereli).
    mpPowerupsUnsub = onValue(ref(db, `lobbies/${lobbyCode}/powerups`), (snap) => {
        mpApplyPowerups(snap.val());
    });

    // Round end jelzés (mindkét fél).
    mpStatusUnsub = onValue(ref(db, `lobbies/${lobbyCode}/status`), (snap) => {
        if (snap.val() === 'ended' && !gameOver) {
            gameOver = true;
            gameOverTime = Date.now();
            gameOverReason = 'collision';
        }
    });

    // "Play again" co-opban: bármelyik fél kérheti (round++), mindkettő újraindul együtt.
    mpRoundUnsub = onValue(ref(db, `lobbies/${lobbyCode}/round`), (snap) => {
        const r = snap.val();
        if (typeof r === 'number' && r > mpRoundLocal) mpRestart(r);
    });

    // Betöltés-szinkron (az első indításhoz): mindkét kliens a saját assetjei
    // betöltésekor beírja a ready/{role}=true-t. A countdown csak akkor indul, ha
    // MINDKETTŐ kész; ekkor a host beállít egy közös countdownAt időbélyeget, amiből
    // mindkét gép ugyanonnan számolja a 3-2-1-et → szinkron start.
    mpReadyUnsub = onValue(ref(db, `lobbies/${lobbyCode}/ready`), (snap) => {
        const r = snap.val() || {};
        mpPartnerReady = !!r[otherRole];
        if (isHost && r.host && r.guest && !mpCountdownAt) {
            const at = Date.now() + 700;   // kis buffer, hogy mindkét kliens megkapja az anchor-t
            mpCountdownAt = at;
            update(ref(db, `lobbies/${lobbyCode}`), { countdownAt: at }).catch(() => {});
        }
    });
    mpCountdownAtUnsub = onValue(ref(db, `lobbies/${lobbyCode}/countdownAt`), (snap) => {
        const v = snap.val();
        if (typeof v === 'number') mpCountdownAt = v;
    });

    if (!isHost) {
        // GUEST: a host aszteroidáit és a közös pontot fogadja.
        mpAsteroidsUnsub = onValue(ref(db, `lobbies/${lobbyCode}/asteroids`), (snap) => {
            mpApplyAsteroids(snap.val());
        });
        mpScoreUnsub = onValue(ref(db, `lobbies/${lobbyCode}/score`), (snap) => {
            const s = snap.val();
            if (typeof s === 'number') score = s;
        });
        // Combo-állapot fogadása (a combo HUD-hoz + a score-pop kiszámításához).
        mpHudUnsub = onValue(ref(db, `lobbies/${lobbyCode}/hud`), (snap) => {
            const h = snap.val();
            if (!h) return;
            if (typeof h.combo === 'number') comboMultiplier = h.combo;
            if (typeof h.comboAt === 'number') lastComboHitTime = h.comboAt;
        });
        // GUEST: a host vadász-drónja (csak megjelenítés + saját lövés-célzás).
        mpHunterUnsub = onValue(ref(db, `lobbies/${lobbyCode}/hunter`), (snap) => {
            mpHunterState = snap.val();   // null = nincs hunter
            mpHunterAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        });
    } else {
        // HOST: a guest "hit" eseményeit fogadja és autoritatívan feldolgozza.
        mpHitsUnsub = onValue(ref(db, `lobbies/${lobbyCode}/hits`), (snap) => {
            mpProcessHits(snap.val());
        });
        // HOST: a guest vadász-találatait fogadja és sebzi a drónt.
        mpHHitsUnsub = onValue(ref(db, `lobbies/${lobbyCode}/hhits`), (snap) => {
            mpProcessHunterHits(snap.val());
        });
    }

    // A két játékos neve a co-op scoreboardhoz ("A + B").
    get(ref(db, `lobbies/${lobbyCode}`)).then((snap) => {
        const l = snap.val();
        if (l) { mpHostName = l.hostName || null; mpGuestName = l.guestName || null; }
    }).catch(() => {});

    // Partner-lecsatlakozás figyelése: a lobby gyökerét KIZÁRÓLAG az
    // onDisconnect.remove() törli (a normál flow mindig csak update / child-remove).
    // Ha tehát a lobby eltűnik, a másik játékos kilépett → mindkét játékost
    // visszadobjuk a főmenübe (a benn maradt klienst ez a listener viszi vissza).
    mpLobbyRootUnsub = onValue(ref(db, `lobbies/${lobbyCode}`), (snap) => {
        if (snap.val() === null) mpHandlePartnerLeft();
    });

    // A lobby takarítása: ha ez a kliens lecsatlakozik (tab bezár / navigálás),
    // töröljük a lobbyt. (A waiting-fázis onDisconnectjét az index.js lemondja a
    // játékba lépés előtt, ezért itt újra regisztráljuk a meccs idejére.)
    try { onDisconnect(ref(db, `lobbies/${lobbyCode}`)).remove(); } catch (e) { /* no-op */ }

    window.addEventListener('beforeunload', mpCleanup);
}

function mpCleanup() {
    if (mpOtherUnsub)     { mpOtherUnsub();     mpOtherUnsub = null; }
    if (mpAsteroidsUnsub) { mpAsteroidsUnsub(); mpAsteroidsUnsub = null; }
    if (mpScoreUnsub)     { mpScoreUnsub();     mpScoreUnsub = null; }
    if (mpHitsUnsub)      { mpHitsUnsub();      mpHitsUnsub = null; }
    if (mpHudUnsub)       { mpHudUnsub();       mpHudUnsub = null; }
    if (mpPowerupsUnsub)  { mpPowerupsUnsub();  mpPowerupsUnsub = null; }
    if (mpSelfUnsub)      { mpSelfUnsub();      mpSelfUnsub = null; }
    if (mpStatusUnsub)    { mpStatusUnsub();    mpStatusUnsub = null; }
    if (mpRoundUnsub)     { mpRoundUnsub();     mpRoundUnsub = null; }
    if (mpLobbyRootUnsub) { mpLobbyRootUnsub(); mpLobbyRootUnsub = null; }
    if (mpReadyUnsub)     { mpReadyUnsub();     mpReadyUnsub = null; }
    if (mpCountdownAtUnsub){ mpCountdownAtUnsub(); mpCountdownAtUnsub = null; }
    if (mpHunterUnsub)    { mpHunterUnsub();    mpHunterUnsub = null; }
    if (mpHHitsUnsub)     { mpHHitsUnsub();     mpHHitsUnsub = null; }
}

// Minden frame: saját heartbeat írása + a partner jelenlétének figyelése.
// A heartbeat állapottól függetlenül megy (a 'down' játékos is "él"), így a
// partner node-ja folyamatosan frissül — ha a frissítés elmarad, kilépett.
function mpHeartbeatAndWatch() {
    if (mpPartnerLeft) return;
    const now = Date.now();
    if (now - mpLastHb >= MP_HB_INTERVAL) {
        mpLastHb = now;
        update(ref(db, `lobbies/${lobbyCode}/players/${role}`), { hb: now }).catch(() => {});
    }
    if (mpSeenPartner && now - mpLastPartnerSeen > MP_PARTNER_TIMEOUT) {
        mpHandlePartnerLeft();
    }
}

// A partner kilépett (timeout vagy a lobby törlődött) → leiratkozunk, leállítjuk az
// írásokat, és rövid jelzés után visszadobjuk ezt a klienst is a főmenübe. Egyszer fut.
function mpHandlePartnerLeft() {
    if (mpPartnerLeft) return;
    mpPartnerLeft = true;
    // Ne próbáljuk újra törölni a (már törölt) lobbyt, és álljon le minden listener.
    try { onDisconnect(ref(db, `lobbies/${lobbyCode}`)).cancel().catch(() => {}); } catch (e) { /* no-op */ }
    mpCleanup();
    // Felső sáv: "Player N disconnected" (host = Player 1, guest = Player 2 — a
    // kilépett partner száma), majd rövid késleltetés után vissza a főmenübe.
    const partnerLabel = (otherRole === 'guest') ? 'Player 2' : 'Player 1';
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
        'display:flex;align-items:center;justify-content:center;gap:10px;' +
        'padding:16px 20px;background:rgba(180,30,30,.94);color:#fff;' +
        'font-family:Arial,Helvetica,sans-serif;font-size:1.4rem;font-weight:700;' +
        'letter-spacing:.02em;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.45)';
    bar.textContent = `${partnerLabel} disconnected`;
    document.body.appendChild(bar);
    setTimeout(() => { window.location.href = '/index.html'; }, 2500);
}

// Saját pozíció küldése (throttle). Csak aktív játékban hívjuk a game loopból.
function mpSendPosition() {
    if (!isMultiplayer || !player) return;
    if (localState !== 'alive') return;   // 'down' alatt a reviver/Firebase írja a node-ot
    const now = Date.now();
    if (now - mpLastSendTime < MP_SEND_INTERVAL) return;
    mpLastSendTime = now;
    update(ref(db, `lobbies/${lobbyCode}/players/${role}`), {
        x: Math.round(player.position.x),
        y: Math.round(player.position.y),
        rotation: Math.round(player.rotation),
        state: 'alive',
        // Vizuál-állapot a partnernek: pajzs, dash, hajtómű-láng (W), lövedékek.
        shield: (player.shieldActive || player._inShieldGrace()) ? 1 : 0,
        dash: (player.dashUntil && Date.now() < player.dashUntil) ? 1 : 0,
        thrust: (typeof window !== 'undefined' && window.keys && window.keys['w']) ? 1 : 0,
        shots: shots.slice(-24).map(s => ({   // a LEGÚJABB lövedékek (nem a legrégebbiek)
            x: Math.round(s.position.x),
            y: Math.round(s.position.y),
            vx: Math.round(s.velocity.x),
            vy: Math.round(s.velocity.y),
        })),
    }).catch(() => { /* hálózati hibát csendben elnyelünk, ne akassza a loopot */ });
}

// HOST: az aszteroida-lista + közös pont kiküldése (throttle). A teljes listát
// kiírjuk (rövid kulcsokkal), így a törölt kövek automatikusan eltűnnek a guestnél.
function mpHostSync() {
    if (!isMultiplayer || !isHost) return;
    const now = Date.now();
    if (now - mpLastWorldSend < MP_WORLD_INTERVAL) return;
    mpLastWorldSend = now;
    const map = {};
    for (const a of asteroids) {
        if (a.dead) continue;
        if (!a.mpId) a.mpId = 'a' + (mpAsteroidCounter++);
        map[a.mpId] = {
            x: Math.round(a.position.x),
            y: Math.round(a.position.y),
            vx: Math.round(a.velocity.x),
            vy: Math.round(a.velocity.y),
            r: a.radius,
            t: a.type === 'explosive' ? 'e' : 'n',
        };
    }
    // Hunter (host-autoritatív) szinkronizálása a guestnek — render + guest-célzás.
    hunters = hunters.filter(hh => updatable.includes(hh));   // élő példányok
    const lh = hunters[0] || null;
    let hunterData = null;
    if (lh) {
        hunterData = {
            x: Math.round(lh.position.x),
            y: Math.round(lh.position.y),
            h: Math.round(lh.heading * 1000) / 1000,   // heading (radián)
            hp: lh.hp,
            f: Date.now() < lh.flashUntil ? 1 : 0,
            p: (lh.projectiles || []).slice(0, 24).map(pr => ({
                x: Math.round(pr.x), y: Math.round(pr.y),
                vx: Math.round(pr.vx), vy: Math.round(pr.vy),
            })),
        };
    }
    update(ref(db, `lobbies/${lobbyCode}`), {
        asteroids: map,
        score,
        hud: { combo: comboMultiplier, comboAt: lastComboHitTime },
        hunter: hunterData,   // null = nincs hunter (törli a node-ot)
    }).catch(() => {});
}

// ── Hunter co-op (host-autoritatív; a guest rendereli + lőheti) ───────────────
const MP_HUNTER_R = 40;        // = HUNTER_RADIUS (hunter.js)
const MP_HUNTER_SHOT_R = 11;   // = ENEMY_SHOT_R
const MP_HUNTER_HP = 3;        // = HUNTER_HP

// GUEST: a host által szinkronizált vadász-drón kirajzolása (csak megjelenítés;
// a logikát/AI-t a host futtatja). Replikálja a Hunter.draw lényegét.
function drawMpHunter(ctx) {
    const st = mpHunterState;
    if (!st) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const dt = Math.min(0.3, (now - mpHunterAt) / 1000);

    // Lövedékek (a host vx/vy-jával extrapolálva a 20fps simítására).
    for (const p of (st.p || [])) {
        const px = p.x + (p.vx || 0) * dt;
        const py = p.y + (p.vy || 0) * dt;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        if (!isLowQuality()) { ctx.shadowColor = 'rgba(255, 90, 40, 0.9)'; ctx.shadowBlur = 14; }
        ctx.fillStyle = '#ff7a3a';
        ctx.beginPath(); ctx.arc(px, py, MP_HUNTER_SHOT_R, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(px, py, MP_HUNTER_SHOT_R * 0.45, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    // A drón sprite.
    const img = getImage('/themes/space/hunter.png');
    const ds = MP_HUNTER_R * 2 * 1.3;
    const glow = 0.5 + 0.5 * Math.sin(now / 140);
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate((st.h || 0) + Math.PI / 2);
    if (!isLowQuality()) { ctx.shadowColor = `rgba(255, 70, 40, ${0.6 + 0.3 * glow})`; ctx.shadowBlur = 18 + 8 * glow; }
    if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, -ds / 2, -ds / 2, ds, ds);
        if (st.f) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.6;
            ctx.drawImage(img, -ds / 2, -ds / 2, ds, ds);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }
    } else {
        ctx.beginPath(); ctx.arc(0, 0, MP_HUNTER_R, 0, Math.PI * 2); ctx.fillStyle = '#ff5a2a'; ctx.fill();
    }
    ctx.restore();

    // HP-pipák.
    const pipW = 12, gap = 5;
    const total = MP_HUNTER_HP * pipW + (MP_HUNTER_HP - 1) * gap;
    const x0 = st.x - total / 2;
    const y = st.y - ds / 2 - 14;
    const hp = (typeof st.hp === 'number') ? st.hp : MP_HUNTER_HP;
    for (let i = 0; i < MP_HUNTER_HP; i++) {
        ctx.fillStyle = i < hp ? '#ff6a3a' : 'rgba(255, 255, 255, 0.18)';
        ctx.fillRect(x0 + i * (pipW + gap), y, pipW, 5);
    }
}

// GUEST: a saját lövedékei eltalálják-e a host drónt? Ha igen, jelenti a hostnak
// (a host sebzi a drónt), és lokálisan eltünteti a lövedéket.
function mpGuestHunterShots() {
    if (isHost) return;
    const st = mpHunterState;
    if (!st) return;
    for (const bullet of [...shots]) {
        const dx = bullet.position.x - st.x;
        const dy = bullet.position.y - st.y;
        if (Math.hypot(dx, dy) < MP_HUNTER_R + bullet.hitboxRadius) {
            push(ref(db, `lobbies/${lobbyCode}/hhits`), { t: Date.now() }).catch(() => {});
            bullet.kill(updatable, drawable, shots);
            if (juice) spawnExplosion(bullet.position.x, bullet.position.y, '#ffd24a', 6, { speedMax: 200, sizeMax: 4 });
        }
    }
}

// HOST: a guest hunter-találatainak feldolgozása (push-key-enként 1 sebzés).
function mpProcessHunterHits(map) {
    if (!map) return;
    const lh = hunters.find(hh => updatable.includes(hh));
    for (const key in map) {
        if (mpProcessedHHits.has(key)) continue;
        mpProcessedHHits.add(key);
        if (lh && lh.hp > 0) {
            lh.hp -= 1;
            lh.flashUntil = Date.now() + 130;
            if (lh.hp <= 0) {
                lh.onKill(lh.position.x, lh.position.y);
                lh.destroy();
            } else {
                playSound(getSoundVariant() ? '/assets/audio/adi_death.mp3' : '/assets/audio/hit.mp3', 0.12);
            }
        }
        remove(ref(db, `lobbies/${lobbyCode}/hhits/${key}`)).catch(() => {});
    }
}

// GUEST: a Firebase aszteroida-térkép alkalmazása. Id alapján egyezteti a lokális
// Asteroid objektumokat (újat hoz létre, eltűntet töröl, meglévőt korrigál). A
// két korrekció között a guest lokálisan integrálja a mozgást (dead reckoning).
function mpApplyAsteroids(map) {
    const incoming = map || {};
    const now = Date.now();

    // Predikció karbantartása: amit a guest már lokálisan kilőtt.
    for (const [id, t] of mpGuestPredictedKills) {
        if (!incoming[id]) {
            // A host megerősítette a törlést (a sync már nem tartalmazza) → kész.
            mpGuestPredictedKills.delete(id);
        } else if (now - t > MP_PREDICT_TIMEOUT) {
            // A host a timeout alatt sem törölte (a találat nem ment át) → feloldjuk,
            // hadd éledjen újra lent (nem maradhat örökre eltüntetve).
            mpGuestPredictedKills.delete(id);
        }
    }

    // Eltűnt kövek (host kilőtte/hasította) → lokálisan is töröljük.
    for (const [id, a] of mpGuestAsteroids) {
        if (!incoming[id]) {
            mpGuestAsteroidFx(a);   // robbanás + score-pop + shake a guest-oldalon
            a.kill();
            mpGuestAsteroids.delete(id);
        }
    }
    // Új / frissített kövek.
    for (const id in incoming) {
        // Amit lokálisan már kilőttünk, azt ne keltsük újra, amíg él a predikció.
        if (mpGuestPredictedKills.has(id)) continue;
        const d = incoming[id];
        let a = mpGuestAsteroids.get(id);
        if (!a) {
            const type = d.t === 'e' ? 'explosive' : 'normal';
            a = new Asteroid(d.x, d.y, d.r, updatable, drawable, asteroids, type);
            a.mpId = id;
            updatable.push(a);
            drawable.push(a);
            asteroids.push(a);
            mpGuestAsteroids.set(id, a);
        }
        a.position.x = d.x;
        a.position.y = d.y;
        a.velocity.x = d.vx;
        a.velocity.y = d.vy;
    }
}

// Egy aszteroida "lövedék általi" feldolgozása (hang + pont + effekt + hasadás vagy
// robbanó-lánc). Ezt hívja a host a saját lövéseinél ÉS a guest "hit" eseményeinél,
// így a logika egy helyen él. (Singleplayerben ugyanez fut, változatlan viselkedés.)
function resolveAsteroidHit(asteroid) {
    if (asteroid.type === 'explosive') {
        detonateExplosive(asteroid, new Set());
        return;
    }
    if (getSoundVariant()) {
        playSound("/assets/audio/adi_death.mp3", 0.07);
    } else {
        playSound("/assets/audio/hit.mp3", 0.07);
    }
    const hitboxBeforeSplit = asteroid.hitboxRadius;
    updateScoreFromHitbox(hitboxBeforeSplit);
    if (juice) {
        const big = hitboxBeforeSplit > 100;
        spawnExplosion(
            asteroid.position.x, asteroid.position.y,
            '#d8cab8', big ? 14 : 9,
            { speedMax: big ? 280 : 220, sizeMax: big ? 6 : 4.5 }
        );
        spawnScorePop(asteroid.position.x, asteroid.position.y, lastEarnedPoints);
        shake(big ? 4.5 : 3, big ? 110 : 85);
    }
    asteroid.split();
}

// GUEST: a saját lövedékek vs (szinkronizált) aszteroidák. Találatkor "hit" eseményt
// push-ol a hostnak az aszteroida mpId-jával, és eltünteti a lövedéket. NEM pontoz/hasít
// lokálisan — azt a host végzi, és a pusztulás a következő aszteroida-szinkronnal érkezik.
function mpGuestCheckHits() {
    // Másolaton iterálunk, mert a találat azonnali lokális kill()-je splice-olja
    // az `asteroids` tömböt (optimista predikció).
    for (const asteroid of [...asteroids]) {
        if (asteroid.dead || asteroid.reported || !asteroid.mpId) continue;
        for (const bullet of [...shots]) {
            if (asteroid.collidesWith(bullet)) {
                bullet.kill(updatable, drawable, shots);
                asteroid.reported = true;
                // Hitelesítésre elküldjük a hostnak (ő számolja a pontot/hasítást).
                push(ref(db, `lobbies/${lobbyCode}/hits`), { id: asteroid.mpId }).catch(() => {});
                // Optimista predikció: NEM várjuk meg a host visszaigazolását —
                // azonnal lejátsszuk a robbanást és eltüntetjük a követ lokálisan.
                // A hivatalos pontot úgyis a host `score`-szinkronja adja.
                mpGuestAsteroidFx(asteroid);
                mpGuestPredictedKills.set(asteroid.mpId, Date.now());
                mpGuestAsteroids.delete(asteroid.mpId);
                asteroid.kill();
                break;
            }
        }
    }
}

// HOST: a guest "hit" eseményeinek feldolgozása. Megkeresi az aszteroidát mpId alapján,
// és ha létezik, az autoritatív feldolgozást futtatja, majd törli az eseményt. A már
// feldolgozott kulcsokat számon tartjuk, hogy az onValue-újrahívás ne dolgozza fel kétszer.
// GUEST: a juice-effektek lejátszása, amikor egy aszteroida eltűnik (= a host
// elpusztította). A pontot lokálisan becsüljük (a kő mérete × frenzy-szorzó ×
// szinkronizált combo) — vizuálisan egyezik a hostéval, a hivatalos pontot úgyis a
// score-szinkron adja. Csak space-en (juice) fut.
function mpBaseFromHitbox(hitboxRadius) {
    if (hitboxRadius > 142) return 1;
    if (hitboxRadius > 112) return 2;
    if (hitboxRadius > 77) return 3;
    if (hitboxRadius > 36) return 4;
    return 5;
}

function mpGuestAsteroidFx(a) {
    if (!juice) return;
    const cx = a.position.x, cy = a.position.y;
    const base = mpBaseFromHitbox(a.hitboxRadius);
    if (a.type === 'explosive') {
        playSound('/assets/audio/explosion.mp3', 0.4);
        spawnShockwave(cx, cy, EXPLOSION_RADIUS, '#ff9b50');
        spawnExplosion(cx, cy, '#ff7a3a', 28, { speedMax: 460, sizeMax: 7.5, lifeMax: 0.9 });
        spawnExplosion(cx, cy, '#ffd24a', 16, { speedMax: 320, sizeMax: 5 });
        const earned = base * scoreMultiplier * comboMultiplier + EXPLOSIVE_BONUS;
        lastEarnedPoints = earned;
        spawnScorePop(cx, cy, earned);
        shake(10, 240);
    } else {
        const big = a.hitboxRadius > 100;
        playSound(getSoundVariant() ? "/assets/audio/adi_death.mp3" : "/assets/audio/hit.mp3", 0.07);
        spawnExplosion(cx, cy, '#d8cab8', big ? 14 : 9, { speedMax: big ? 280 : 220, sizeMax: big ? 6 : 4.5 });
        const earned = base * scoreMultiplier * comboMultiplier;
        lastEarnedPoints = earned;
        spawnScorePop(cx, cy, earned);
        shake(big ? 4.5 : 3, big ? 110 : 85);
    }
}

const mpProcessedHits = new Set();
function mpProcessHits(map) {
    if (!map) return;
    for (const key in map) {
        if (mpProcessedHits.has(key)) continue;
        mpProcessedHits.add(key);
        const h = map[key];
        const a = asteroids.find(x => x.mpId === h.id && !x.dead);
        if (a) resolveAsteroidHit(a);
        remove(ref(db, `lobbies/${lobbyCode}/hits/${key}`)).catch(() => {});
    }
}

// ── Phase 6: halál / down / revive ───────────────────────────────────────────

// A saját hajó ütközés-ellenőrzése a (host: autoritatív, guest: szinkronizált)
// aszteroidákkal. Pajzs elnyeli; egyébként 'down' állapotba kerülünk (nem game over).
function mpCheckMyDeath() {
    if (localState !== 'alive') return;
    const now = Date.now();
    if (player.isInvincible() || now < reviveInvincibleUntil) return;
    for (const asteroid of asteroids) {
        if (asteroid.dead) continue;
        if (player.collidesWith(asteroid)) {
            if (player.shieldActive) {
                player.breakShield();
                playSound("/assets/audio/shield_gone.mp3", 0.5);
                if (juice) {
                    spawnExplosion(player.position.x, player.position.y, '#7fe0ff', 18, { speedMax: 320, sizeMax: 6 });
                    shake(7, 160);
                }
                return;
            }
            mpGoDown();
            return;
        }
    }
}

function mpGoDown() {
    localState = 'down';
    player.disabled = true;
    mpWreck = { x: player.position.x, y: player.position.y, rot: player.rotation };
    myReviveProgress = 0;
    if (juice) {
        spawnExplosion(player.position.x, player.position.y, '#ff7a4a', 28, { speedMax: 440, sizeMax: 7, lifeMax: 0.85 });
        spawnExplosion(player.position.x, player.position.y, '#ffd24a', 14, { speedMax: 300, sizeMax: 5 });
        shake(15, 340);
    }
    playSound(getSoundVariant() ? "/assets/audio/adi_death.mp3" : "/assets/audio/gameover.mp3", 0.5);
    update(ref(db, `lobbies/${lobbyCode}/players/${role}`), {
        state: 'down',
        x: Math.round(mpWreck.x),
        y: Math.round(mpWreck.y),
        rotation: Math.round(mpWreck.rot),
        downedAt: Date.now(),
        reviveProgress: 0,
    }).catch(() => {});
}

// Reviver-vezérelt élesztés: ha ÉN élek és a partnerem 'down', a roncsa zónájában
// lebegve töltöm a gyűrűt; teljesnél 'alive'-ra állítom a partner node-ját.
function mpUpdateRevive(dtMs) {
    if (localState !== 'alive' || !remotePlayer || remotePlayer.state !== 'down') {
        mpReviveTimer = 0;
        return;
    }
    const now = Date.now();
    const wx = remotePlayer.target.x, wy = remotePlayer.target.y;   // partner roncs
    const dx = player.position.x - wx, dy = player.position.y - wy;
    const within = (dx * dx + dy * dy) <= REVIVE_RADIUS * REVIVE_RADIUS;
    const cdActive = now < (remotePlayer.reviveCdUntil || 0);

    if (within && !cdActive) {
        mpReviveTimer = Math.min(REVIVE_HOLD_MS, mpReviveTimer + dtMs);
    } else {
        mpReviveTimer = Math.max(0, mpReviveTimer - dtMs * REVIVE_DECAY);
    }
    const progress = mpReviveTimer / REVIVE_HOLD_MS;
    remotePlayer.reviveProgress = progress;   // a partner roncs-gyűrűje az ÉN gépemen

    if (progress >= 1) {
        mpReviveTimer = 0;
        update(ref(db, `lobbies/${lobbyCode}/players/${otherRole}`), {
            state: 'alive',
            x: Math.round(wx),
            y: Math.round(wy),
            invincibleUntil: now + REVIVE_IFRAME_MS,
            reviveCdUntil: now + REVIVE_CD_MS,
            reviveProgress: 0,
        }).catch(() => {});
        playSound("/assets/audio/start.mp3", 0.4);
    } else if (now - mpLastRevWrite > 100) {
        mpLastRevWrite = now;
        update(ref(db, `lobbies/${lobbyCode}/players/${otherRole}`), { reviveProgress: progress }).catch(() => {});
    }
}

// A saját roncs + revive-gyűrű kirajzolása (a partneré a RemotePlayer-ben van).
function mpDrawDownOverlays(ctx) {
    if (localState !== 'down') return;
    const x = mpWreck.x, y = mpWreck.y;
    if (player.imageLoaded) {
        const scale = 0.82;
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.translate(x, y);
        ctx.rotate(mpWreck.rot * Math.PI / 180);
        ctx.drawImage(player.image, -player.radius * scale, -player.radius * scale, player.radius * 2 * scale, player.radius * 2 * scale);
        ctx.restore();
    }
    drawReviveRing(ctx, x, y, myReviveProgress);
    ctx.save();
    ctx.fillStyle = '#ffd24a';
    ctx.font = 'bold 26px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('You are down — wait for your teammate', x, y - 95);
    ctx.restore();
}

function drawReviveRing(ctx, x, y, progress) {
    const r = 70;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 6;
    ctx.stroke();
    const p = Math.max(0, Math.min(1, progress));
    if (p > 0) {
        ctx.beginPath();
        ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
        ctx.strokeStyle = '#5cff9d';
        ctx.lineWidth = 6;
        ctx.stroke();
    }
    ctx.restore();
}

// ── Round end + co-op score mentés ───────────────────────────────────────────
function mpEndRound(reason) {
    if (mpRoundEnded) return;
    mpRoundEnded = true;
    if (!gameOver) {
        gameOver = true;
        gameOverTime = Date.now();
        gameOverReason = reason === 'wipe' ? 'collision' : 'timeout';
    }
    if (isHost) {
        update(ref(db, `lobbies/${lobbyCode}`), { status: 'ended' }).catch(() => {});
        mpSaveScore();
    }
}

function mpSaveScore() {
    const name = `${mpHostName || 'Anonymous'} + ${mpGuestName || 'Anonymous'}`.slice(0, 40);
    push(ref(db, 'mpScores'), { score: sanitizeScore(score), name, createdAt: Date.now() }).catch(() => {});
}

// ── Powerup-szinkron (host spawnol, mindkét fél rendereli; aki felveszi, azé) ──
function mpSpawnPowerUp(x, y, type) {
    const id = 'p' + (mpPowerupCounter++);
    set(ref(db, `lobbies/${lobbyCode}/powerups/${id}`), { x: Math.round(x), y: Math.round(y), type }).catch(() => {});
}

function mpApplyPowerups(map) {
    const incoming = map || {};
    for (const [id, p] of mpPowerups) {
        if (!incoming[id]) {
            const di = drawable.indexOf(p); if (di > -1) drawable.splice(di, 1);
            const ui = updatable.indexOf(p); if (ui > -1) updatable.splice(ui, 1);
            const pi = powerUps.indexOf(p); if (pi > -1) powerUps.splice(pi, 1);
            mpPowerups.delete(id);
        }
    }
    for (const id in incoming) {
        if (mpPowerups.has(id) || mpConsumedPowerups.has(id)) continue;
        const d = incoming[id];
        const p = new PowerUp(d.x, d.y, d.type);
        p.mpId = id;
        powerUps.push(p);
        drawable.push(p);
        updatable.push(p);
        mpPowerups.set(id, p);
    }
}

// A lokálisan felvett powerupok eltüntetése a Firebase-ből (hogy a társnál is eltűnjön).
function mpDetectPickups() {
    for (const [id, p] of mpPowerups) {
        if (powerUps.indexOf(p) === -1) {   // a player.update felvette → kiesett a powerUps-ból
            mpConsumedPowerups.add(id);
            mpPowerups.delete(id);
            const di = drawable.indexOf(p); if (di > -1) drawable.splice(di, 1);
            const ui = updatable.indexOf(p); if (ui > -1) updatable.splice(ui, 1);
            remove(ref(db, `lobbies/${lobbyCode}/powerups/${id}`)).catch(() => {});
        }
    }
}

// ── Co-op "Play again": bármelyik fél kérheti; round++ → mindkettő újraindul ──
function mpRequestRestart() {
    update(ref(db, `lobbies/${lobbyCode}`), { round: mpRoundLocal + 1, status: 'playing' }).catch(() => {});
}

// Lokális co-op újraindítás (a round-listener hívja mindkét kliensen). A restartGame
// MP-kompatibilis változata: a guest nem hoz létre AsteroidField-et, a host pedig
// kitakarítja a megosztott (Firebase) világot.
function mpRestart(round) {
    mpRoundLocal = round;

    updatable.length = 0;
    drawable.length = 0;
    hunters = [];
    mpHunterState = null;
    mpProcessedHHits.clear();
    shots.length = 0;
    asteroids.length = 0;
    powerUps.length = 0;
    mpGuestAsteroids.clear();
    mpGuestPredictedKills.clear();
    mpPowerups.clear();
    mpConsumedPowerups.clear();
    mpProcessedHits.clear();

    player = new Player(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2, updatable, drawable, shots);
    player.disabled = false;
    updatable.push(player);
    drawable.push(player);

    if (hostSim) {
        asteroidField = new AsteroidField(updatable, drawable, asteroids);
        updatable.push(asteroidField);
    } else {
        asteroidField = null;
    }

    gameOver = false;
    showGameOver = false;
    gameOverTime = 0;
    mpRoundEnded = false;
    localState = 'alive';
    reviveInvincibleUntil = 0;
    myReviveProgress = 0;
    mpReviveTimer = 0;

    countdownStarted = false;
    countdownStartTime = 0;
    countdownRunning = true;

    score = 0;
    scoreMultiplier = 1;
    frenzyActive = false;
    frenzyCountdownText = null;
    lastFrenzyCountStage = null;
    wasInFrenzy = false;
    comboCount = 0;
    comboMultiplier = 1;
    lastComboHitTime = 0;
    nearMissPops = [];
    if (juice) resetEffects();
    scoreSubmitted = false;

    gameStartTime = Date.now();
    spawnedMultishots = new Set();
    spawnedStrikes = new Set();
    powerUpSpawnTime = 0;

    restartButton.style.display = "none";
    if (useDomHud) {
        releaseGameOverFocus();
        if (hudEls.gameOver) hudEls.gameOver.hidden = true;
        if (hudEls.help) hudEls.help.hidden = true;
        const hb = document.getElementById('hudHelpBtn');
        if (hb) hb.innerHTML = '<i class="fas fa-question"></i>';
    }

    // Host: a megosztott világ kitakarítása (a guest a lokálist már törölte).
    if (isHost) {
        update(ref(db, `lobbies/${lobbyCode}`), { asteroids: null, hits: null, powerups: null, score: 0 }).catch(() => {});
    }

    lastTime = performance.now();
}

let gameOver = false;
let countdownStarted = false;
let countdownStartTime = 0;
let countdownRunning = true;
let showGameOver = false;
let gameOverTime = 0;
let gameOverReason = null;

let gameTime = 60;
let gameStartTime = 0;
let powerUpSpawnTime = 0;
let timeRemaining = gameTime;

let score = 0;

// „Frenzy" ablakok (timeRemaining szerint): nehezebb (spawn-csúcs) + dupla pont,
// 3 mp-es visszaszámlálóval és a strike-tól eltérő hanggal.
const FRENZY_WINDOWS = [
    { start: 40, end: 30 },   // köztes túlélési roham
    { start: 10, end: 0 },    // záró finálé
];
let scoreMultiplier = 1;
let frenzyActive = false;
let frenzyCountdownText = null;
let lastFrenzyCountStage = null;
let wasInFrenzy = false;

// Kombó (csak space): ~2 mp-en belüli sorozat-találatok növelik a szorzót (x1→x4).
const COMBO_WINDOW = 2000;
let comboCount = 0;
let comboMultiplier = 1;
let lastComboHitTime = 0;

// Near-miss / súrolás-bónusz (csak space): éles elsuhanás kő mellett → bónusz + villanás.
const GRAZE_MARGIN = 42;       // a hitbox-érintkezésen felüli „súrolás" sáv (px)
const NEAR_MISS_BONUS = 3;
let nearMissPops = [];         // {x, y, t, amount} — lebegő villanások a canvason

let lastEarnedPoints = null;

let lastStrikeCountdownStage = null;

function updateScoreFromHitbox(hitboxRadius) {
    let base;
    if (hitboxRadius > 142) {
        base = 1;
    } else if (hitboxRadius > 112 && hitboxRadius <= 142) {
        base = 2;
    } else if (hitboxRadius > 77 && hitboxRadius <= 112) {
        base = 3;
    } else if (hitboxRadius > 36 && hitboxRadius <= 77) {
        base = 4;
    } else {
        base = 5;
    }
    let combo = 1;
    if (theme === 'space') {
        registerComboHit();
        combo = comboMultiplier;
    }
    const earned = base * scoreMultiplier * combo;   // méret × frenzy × kombó
    score += earned;
    lastEarnedPoints = earned;
}

// ── Robbanó kő (explosive) láncreakció — csak space ──────────────────────────
const EXPLOSION_RADIUS = 260;   // px — ezen belül minden kő elpusztul
const EXPLOSIVE_BONUS = 10;     // a robbanó saját bónusza (a méret-pontján felül)

// Egy robbanó kő detonálása: a sugáron belüli köveket elpusztítja (mindegyik a
// normál pontját adja + kombó), a robbanókat rekurzívan tovább robbantja (lánc).
// `chain`: a már detonált robbanók halmaza (végtelen ciklus / kétszerezés ellen).
function detonateExplosive(boom, chain) {
    if (boom.dead || chain.has(boom)) return;
    chain.add(boom);

    const cx = boom.position.x, cy = boom.position.y;

    // A robbanó saját pontja: méret × frenzy × kombó + EXPLOSIVE_BONUS.
    updateScoreFromHitbox(boom.hitboxRadius);
    const popAmount = (lastEarnedPoints || 0) + EXPLOSIVE_BONUS;
    score += EXPLOSIVE_BONUS;

    playSound('/assets/audio/explosion.mp3', 0.4);
    if (juice) {
        spawnShockwave(cx, cy, EXPLOSION_RADIUS, '#ff9b50');
        spawnExplosion(cx, cy, '#ff7a3a', 28, { speedMax: 460, sizeMax: 7.5, lifeMax: 0.9 });
        spawnExplosion(cx, cy, '#ffd24a', 16, { speedMax: 320, sizeMax: 5 });
        spawnScorePop(cx, cy, popAmount);
        shake(10, 240);
    }

    boom.kill();   // a robbanó eltűnik (dead = true)

    // Sugáron belüli kövek (friss pillanatkép — a már megöltek nincsenek benne).
    for (const other of [...asteroids]) {
        if (other.dead || chain.has(other)) continue;
        const dx = other.position.x - cx, dy = other.position.y - cy;
        if (dx * dx + dy * dy > EXPLOSION_RADIUS * EXPLOSION_RADIUS) continue;

        if (other.type === 'explosive') {
            detonateExplosive(other, chain);   // lánc
        } else {
            updateScoreFromHitbox(other.hitboxRadius);   // normál pont + kombó
            if (juice) {
                spawnExplosion(other.position.x, other.position.y, '#d8cab8', 10, { speedMax: 260, sizeMax: 5 });
                spawnScorePop(other.position.x, other.position.y, lastEarnedPoints);
            }
            other.kill();
        }
    }
}

// Sorozat-találat: 2 mp-en belül növeli a kombót, különben újraindul. (csak space)
function registerComboHit() {
    const now = Date.now();
    comboCount = (now - lastComboHitTime <= COMBO_WINDOW) ? comboCount + 1 : 1;
    lastComboHitTime = now;
    comboMultiplier = comboCount >= 10 ? 4 : comboCount >= 6 ? 3 : comboCount >= 3 ? 2 : 1;
}

// Súrolás-vizsgálat: ha a játékos a hitboxon kívül, de a súrolás-sávon belül van
// egy kőtől (és nincs pajzsa), egyszeri bónusz + villanás. (csak space)
function checkNearMiss(asteroid) {
    if (asteroid.grazed || player.shieldActive || player.isInvincible()) return;
    const dx = player.position.x - asteroid.position.x;
    const dy = player.position.y - asteroid.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const collisionDist = player.hitboxRadius + asteroid.hitboxRadius;
    if (dist >= collisionDist && dist < collisionDist + GRAZE_MARGIN) {
        asteroid.grazed = true;
        const earned = NEAR_MISS_BONUS * scoreMultiplier;
        score += earned;
        lastEarnedPoints = earned;
        nearMissPops.push({ x: player.position.x, y: player.position.y, t: Date.now(), amount: earned });
    }
}

let powerUpImage = new Image();
powerUpImage.src = `/themes/${theme}/boost.png`;
let multishotImage = new Image();
multishotImage.src = `/themes/${theme}/multishot.png`;
let strikeImage = new Image();
strikeImage.src = `/themes/${theme}/strike.png`;

let textColor;
if (theme === 'ocean') {
  textColor = '#f3f3b6';
} else if (theme === 'jungle') {
  textColor = 'rgb(251, 213, 42)';
} else if (theme === 'ww2') {
    textColor = '#f7ede2';
} else if (theme === 'city') {
    textColor = 'rgb(252, 114, 22)';
} else {
  textColor = 'red';
}

let timeColor;
if (theme === 'ocean') {
    timeColor = 'white';
} else if (theme === 'jungle') {
    timeColor = 'white';
} else if (theme === 'ww2') {
    timeColor = 'white';
} else {
    timeColor = 'white';
}

let multishotSpawnTimes = [50, 30, 10];
// Co-opban több powerup: sűrűbb multishot-időpontok (a host ütemezi).
if (isMultiplayer) multishotSpawnTimes = [55, 45, 35, 25, 15, 5];
let spawnedMultishots = new Set();

let spawnedStrikes = new Set();

let pendingStrikeTimes = [10, 30, 50];
let nextStrikeCountdownStart = null;
let currentStrikeTime = null;
let strikeCountdownText = null;

// Vadász-drón (csak space): eltelt játékidő (mp) szerinti spawn-időpontok.
let pendingHunterTimes = [15, 45];
let hunters = [];   // élő Hunter példányok (host-autoritatív; MP-ben Firebase-re szinkronizálva)

let lastCountdownStage = null;

let animationFrameId = null;

const MAX_DT = 0.05;   // 1 frame max 50 ms-et léptet — akadásnál lassú lesz, nem „ugrik át"

function gameLoop() {
    let now = performance.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    // Akadás (GC, tab-váltás, hang-dekód) esetén a dt megugorna → a hajó/kövek
    // átteleportálnának és a lövedék áttunnelezne. A clamp ezt sima lassúdásra váltja.
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;

    // Auto-quality FPS-mérés (gyenge gépen kikapcsolja a glow-t / kevesebb részecske).
    tickQuality();

    // Partner-jelenlét: heartbeat + timeout (állapottól függetlenül, game over alatt is).
    if (isMultiplayer) mpHeartbeatAndWatch();

    if (juice) updateEffects(dt);

    ctx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);  // Clear screen

    // Screen shake: a teljes canvas-világot (háttér + objektumok + effektek)
    // eltoljuk; a DOM HUD nem mozdul. A háttért overscan-nel rajzoljuk, hogy az
    // eltolás ne villantson fekete csíkot a szélen.
    let shakeApplied = false;
    if (juice) {
        const so = getShakeOffset();
        if (so.x !== 0 || so.y !== 0) {
            ctx.save();
            ctx.translate(so.x, so.y);
            shakeApplied = true;
        }
        ctx.drawImage(
            backgroundImage,
            -SHAKE_OVERSCAN, -SHAKE_OVERSCAN,
            SCREEN_WIDTH + 2 * SHAKE_OVERSCAN, SCREEN_HEIGHT + 2 * SHAKE_OVERSCAN
        );
    } else {
        ctx.drawImage(backgroundImage, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    }

    if (!gameOver && !countdownRunning) {
        const elapsedGameTime = (Date.now() - gameStartTime) / 1000;

        if (!isMultiplayer) {   // strike + hunter egyelőre csak singleplayerben (co-opban később, 2 hunterrel)
        if (pendingStrikeTimes.length > 0 && !nextStrikeCountdownStart) {
            if (elapsedGameTime >= pendingStrikeTimes[0] - 3) {
                nextStrikeCountdownStart = Date.now();
                currentStrikeTime = pendingStrikeTimes[0];
            }
        }
    
        if (nextStrikeCountdownStart) {
            const countdownElapsed = (Date.now() - nextStrikeCountdownStart) / 1000;

            let countdownStage = null;

            if (countdownElapsed < 1) {
                strikeCountdownText = "Strike incoming in 3...";
                countdownStage = 3;
            } else if (countdownElapsed < 2) {
                strikeCountdownText = "Strike incoming in 2...";
                countdownStage = 2;
            } else if (countdownElapsed < 3) {
                strikeCountdownText = "Strike incoming in 1...";
                countdownStage = 1;
            } else {
                strikeCountdownText = null;
                spawnStrike();
                spawnedStrikes.add(currentStrikeTime);
                pendingStrikeTimes.shift();
                nextStrikeCountdownStart = null;
                currentStrikeTime = null;
                lastStrikeCountdownStage = null;
            }

            if (countdownStage !== null && countdownStage !== lastStrikeCountdownStage) {
                playSound("/assets/audio/strike_alarm.mp3");
                lastStrikeCountdownStage = countdownStage;
            }

        }

        }   // /if (!isMultiplayer) — strike (a hunter alább, MP-ben is fut)

        // Vadász-drón spawn (csak space): SP-ben és MP-host-on fut (host-autoritatív;
        // a guest a host Firebase-syncjéből rendereli). A strike egyelőre SP-only marad.
        if (hostSim && theme === 'space' && pendingHunterTimes.length > 0
            && elapsedGameTime >= pendingHunterTimes[0]) {
            spawnHunter();
            pendingHunterTimes.shift();
        }
    }

    if (!useDomHud) {
    if (strikeCountdownText !== null) {
        ctx.save();
        ctx.font = "bold 32px Arial";
        ctx.fillStyle = timeColor;
        ctx.textAlign = "center";
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(Date.now() / 100);
        ctx.fillText(strikeCountdownText, canvas.width / 2, 125);
        ctx.restore();
    }

    // Frenzy szöveg (visszaszámláló vagy aktív) — arany, hogy elüssön a strike-tól.
    const frenzyCanvasText = frenzyCountdownText || (frenzyActive ? '2x DOUBLE POINTS' : null);
    if (frenzyCanvasText !== null) {
        ctx.save();
        ctx.font = "bold 30px Arial";
        ctx.fillStyle = "#ffd24a";
        ctx.textAlign = "center";
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(Date.now() / 120);
        ctx.fillText(frenzyCanvasText, canvas.width / 2, 170);
        ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = "80px Arial";
    ctx.textAlign = "center";
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = isLowQuality() ? 0 : 15;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;
    ctx.fillText("Zsasteroids", canvas.width / 2, 75);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '40px Arial';
    ctx.textAlign = 'right';
    ctx.fillText("Score: " + score, SCREEN_WIDTH - 20, 45);
    ctx.restore();

    if (lastEarnedPoints !== null) {
        ctx.save();
        ctx.fillStyle = textColor;
        ctx.font = '26px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(`+${lastEarnedPoints} points`, SCREEN_WIDTH - 10, 80);
        ctx.restore();
    }
    }

    if (countdownRunning) {
        // Betöltő-kapu. Singleplayerben: amíg a saját sprite-ok nincsenek készen, NEM
        // indul a visszaszámlálás (különben a játékos már mozogna, mire megjelennek a
        // textúrák). Multiplayerben (az ELSŐ körben) ráadásul MINDKÉT játékos assetjeit
        // megvárjuk, és a host beállít egy KÖZÖS countdownAt időbélyeget → a 3-2-1
        // mindkét gépen ugyanonnan számol, így a két játékos együtt indul.
        const mpWaiting = isMultiplayer && !mpFirstStartDone && (!mpPartnerReady || !mpCountdownAt);
        if (!assetsReady || mpWaiting) {
            ctx.save();
            ctx.font = '60px Arial';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const waitMsg = !assetsReady
                ? `Loading… ${Math.round(loadProgress * 100)}%`
                : 'Waiting for the other player…';
            ctx.fillText(waitMsg, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
            ctx.restore();
            animationFrameId = requestAnimationFrame(gameLoop);
            return;
        }
        if (!countdownStarted) {
            // Első MP-kör: a host által megosztott közös anchor; egyébként (SP vagy
            // restart-kör) a lokális idő — a meglévő viselkedés változatlan.
            countdownStartTime = (isMultiplayer && !mpFirstStartDone) ? mpCountdownAt : Date.now();
            countdownStarted = true;
        }

        let elapsedTime = (Date.now() - countdownStartTime) / 1000;
        if (elapsedTime < 0) elapsedTime = 0;   // a countdownAt-buffer alatt még nem kezdődött el

        let displayText = "";
        let countdownStage = null;
        if (elapsedTime < 1) {
            displayText = "3";
            countdownStage = 3;
        } else if (elapsedTime < 2) {
            displayText = "2";
            countdownStage = 2;
        } else if (elapsedTime < 3) {
            displayText = "1";
            countdownStage = 1;
        } else if (elapsedTime < 4) {
            displayText = "START";
            countdownStage = "start";
        } else {
            countdownRunning = false;
            gameStartTime = Date.now();
            powerUpSpawnTime = gameStartTime + 5000;
            lastCountdownStage = null;
            mpFirstStartDone = true;   // a következő körök (restart) lokális időzítéssel mennek
        }

        if (countdownStage !== null && countdownStage !== lastCountdownStage) {
            if (countdownStage === "start") {
                playSound("/assets/audio/start.mp3");
            } else {
                playSound("/assets/audio/countdown.mp3");
            }
            lastCountdownStage = countdownStage;
        }

        ctx.save();
        ctx.font = `100px Arial`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayText, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
        ctx.restore();
    } else if (gameOver) {
        if (!showGameOver) {
            showGameOver = true;
            if (getSoundVariant()) {
                playSound("/assets/audio/adi_death.mp3");
              } else {
                playSound("/assets/audio/gameover.mp3");
              }
            if (useDomHud) showGameOverPanel();
            // Co-opban frissítjük a ranglistát: a host friss mpScores-pontja
            // egy kis késleltetéssel ér a Firebase-be, ezért újra lekérjük (mindkét fél).
            if (isMultiplayer) setTimeout(() => { fetchTopScores(); }, 900);
        }

        if (!useDomHud) {
        let elapsedGameOver = (Date.now() - gameOverTime) / 1000;

        if (elapsedGameOver < 3) {
            ctx.save();
            const pulse = Math.sin(Date.now() / 400) * 1.3 + 100;
            ctx.font = `${pulse}px Arial`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (gameOverReason === "timeout") {
                ctx.fillText("Time is up!", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
            } else if (gameOverReason === "collision") {
                ctx.fillText("GAME OVER", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
            }
            ctx.restore();

        } else {
            ctx.save();
            ctx.font = '86px Arial';
            ctx.fillStyle = textColor;
            ctx.textAlign = 'center';
            ctx.fillText("Final Score: " + score, SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - 50);
            ctx.restore();

            restartButton.style.display = "block";
        }
        }
    } else {
        if (gameStartTime === 0) {
            gameStartTime = Date.now();
        }

        const elapsedGameTime = (Date.now() - gameStartTime) / 1000;
        timeRemaining = Math.max(0, gameTime - elapsedGameTime);

        // Frenzy ablakok kiértékelése: aktív-e most + 3 mp-es visszaszámláló.
        frenzyActive = false;
        let frenzyCountStage = null;
        for (const w of FRENZY_WINDOWS) {
            if (timeRemaining <= w.start && timeRemaining > w.end) frenzyActive = true;
            if (timeRemaining > w.start && timeRemaining <= w.start + 3) {
                frenzyCountStage = Math.ceil(timeRemaining - w.start);   // 3 → 2 → 1
            }
        }

        // Visszaszámláló szöveg + hang (countdown.mp3 — eltér a strike riasztótól).
        if (frenzyCountStage !== null) {
            frenzyCountdownText = `Frenzy incoming in ${frenzyCountStage}...`;
            if (frenzyCountStage !== lastFrenzyCountStage) {
                playSound("/assets/audio/countdown.mp3");
                lastFrenzyCountStage = frenzyCountStage;
            }
        } else {
            frenzyCountdownText = null;
            lastFrenzyCountStage = null;
        }

        // A frenzy beindulásakor egyszeri „indító" hang (start.mp3),
        // és a space témán ekkor spawnol a Shield powerup (kétszer/játék).
        if (frenzyActive && !wasInFrenzy) {
            playSound("/assets/audio/start.mp3");
            if (theme === 'space' && hostSim) spawnPowerUp('shield');
        }
        wasInFrenzy = frenzyActive;

        // Pont-szorzó + spawn sűrűség (frenzy alatt csúcsra, egyébként eszkaláció).
        scoreMultiplier = frenzyActive ? 2 : 1;
        if (asteroidField) asteroidField.spawnInterval = frenzyActive
            ? 0.18
            : Math.max(0.3, 0.9 - (elapsedGameTime / gameTime) * 0.6);

        // Kombó lejárat: ha 2 mp-en belül nem volt találat, nullázódik.
        if (comboCount > 0 && Date.now() - lastComboHitTime > COMBO_WINDOW) {
            comboCount = 0;
            comboMultiplier = 1;
        }

        if (timeRemaining <= 0) {
            if (isMultiplayer) {
                if (isHost) mpEndRound('timeout');
                else if (!gameOver) { gameOver = true; gameOverTime = Date.now(); gameOverReason = 'timeout'; }
            } else {
                gameOver = true;
                gameOverTime = Date.now();
                gameOverReason = "timeout";
                if (!scoreSubmitted) {
                    scoreSubmitted = true;
                    saveScore(score);
                }
            }
        }
        updatable.forEach(object => object.update(dt));

        // Képernyőn kívülre repült lövedékek eltakarítása. Korábban a lövedékek
        // CSAK ütközéskor tűntek el — a célt vétő lövések örökre a tömbökben
        // maradtak, így idővel egyre gyűltek: folyamatosan növekvő lag (főleg
        // boost/multishot mellett), és a co-op shots-syncbe is elavult, rég
        // képernyőn kívüli lövedékek kerültek (a partner nem látta az aktuálisakat).
        const SHOT_MARGIN = 60;
        for (const bullet of [...shots]) {
            const p = bullet.position;
            if (p.x < -SHOT_MARGIN || p.x > SCREEN_WIDTH + SHOT_MARGIN ||
                p.y < -SHOT_MARGIN || p.y > SCREEN_HEIGHT + SHOT_MARGIN) {
                bullet.kill(updatable, drawable, shots);
            }
        }

        // Ha a partner kilépett, ne írjunk többé a (törölt) lobbyba — különben a
        // pozíció-/world-sync újra létrehozná a lobby node-ot.
        if (isMultiplayer && !mpPartnerLeft) { mpDetectPickups(); mpSendPosition(); mpHostSync(); mpGuestHunterShots(); }

        if (hostSim) for (let asteroid of [...asteroids]) {
            if (asteroid.dead) continue;   // láncreakcióban már elpusztult — ne ölje a játékost, ne pontozzuk újra

            // A játékos-halál (és near-miss) MP-ben az mpCheckMyDeath-ben történik
            // (mindkét fél a SAJÁT hajóját ellenőrzi), ezért itt csak singleplayerben fut.
            if (!isMultiplayer) {
                if (player.collidesWith(asteroid)) {
                    if (player.shieldActive) {
                        // Pajzs elnyeli az ütközést → nem halunk meg, 1 mp sebezhetetlenség indul.
                        player.breakShield();
                        playSound("/assets/audio/shield_gone.mp3", 0.5);
                        if (juice) {
                            spawnExplosion(player.position.x, player.position.y, '#7fe0ff', 18, { speedMax: 320, sizeMax: 6 });
                            shake(7, 160);
                        }
                        // (folytatjuk a ciklust — a grace alatt a többi ütközés is figyelmen kívül marad)
                    } else if (!player.isInvincible()) {
                        gameOver = true;
                        gameOverTime = Date.now();
                        gameOverReason = "collision";
                        if (juice) {
                            spawnExplosion(player.position.x, player.position.y, '#ff7a4a', 28, { speedMax: 440, sizeMax: 7, lifeMax: 0.85 });
                            spawnExplosion(player.position.x, player.position.y, '#ffd24a', 14, { speedMax: 300, sizeMax: 5 });
                            shake(15, 340);
                        }
                        if (!scoreSubmitted) {
                            scoreSubmitted = true;
                            saveScore(score);
                        }
                        break;
                    }
                    // ha épp sebezhetetlen (pajzs-grace), az ütközésnek nincs hatása
                } else if (theme === 'space') {
                    checkNearMiss(asteroid);   // súrolás-bónusz, ha élesen elsuhan mellette
                }
            }

            for (let bullet of shots) {
                if (asteroid.collidesWith(bullet)) {
                    bullet.kill(updatable, drawable, shots);
                    resolveAsteroidHit(asteroid);
                    break;
                }
            }
        }

        // GUEST: a saját lövéseit lokálisan veti össze a (szinkronizált) aszteroidákkal,
        // és találatkor "hit" eseményt küld a hostnak. Az autoritatív pusztítás/pont a
        // hostnál történik — itt csak jelez, és a saját lövedéket eltünteti.
        if (isMultiplayer && !isHost && !mpPartnerLeft) mpGuestCheckHits();

        // Phase 6: saját halál-ellenőrzés + (élve) a társ élesztése + round end.
        if (isMultiplayer && !mpPartnerLeft) {
            mpCheckMyDeath();
            mpUpdateRevive(dt * 1000);
            if (isHost && localState === 'down' && remotePlayer && remotePlayer.state === 'down') {
                mpEndRound('wipe');
            }
        }

        drawable.forEach(object => object.draw(ctx));
        if (isMultiplayer && remotePlayer) remotePlayer.draw(ctx);
        if (isMultiplayer && !isHost) drawMpHunter(ctx);   // a host drónját a guest a syncből rajzolja
        if (isMultiplayer) mpDrawDownOverlays(ctx);

        // Near-miss popok: cián villanás (táguló gyűrű) + lebegő „NEAR MISS +N" szöveg.
        if (nearMissPops.length) {
            const nowPop = Date.now();
            const POP_DUR = 700;
            nearMissPops = nearMissPops.filter(p => nowPop - p.t < POP_DUR);
            for (const p of nearMissPops) {
                const age = (nowPop - p.t) / POP_DUR;   // 0 → 1
                const alpha = 1 - age;
                ctx.save();
                ctx.globalAlpha = alpha * 0.8;
                ctx.strokeStyle = '#9fe8ff';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 26 + age * 55, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#d6f3ff';
                ctx.font = 'bold 26px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(`NEAR MISS +${p.amount}`, p.x, p.y - 50 - age * 40);
                ctx.restore();
            }
        }

        if (hostSim) {
        for (let spawnTime of multishotSpawnTimes) {
            if (timeRemaining <= spawnTime && !spawnedMultishots.has(spawnTime)) {
                spawnPowerUp("multishot");
                spawnedMultishots.add(spawnTime);
            }
        }

        if (Date.now() >= powerUpSpawnTime) {
            spawnPowerUp();
            powerUpSpawnTime = Date.now() + (isMultiplayer ? 9000 : 15000);   // co-opban gyakoribb
        }
        }
    }
    if (!useDomHud) {
    ctx.save();
    ctx.fillStyle = timeColor;
    ctx.font = '35px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(`Time left: ${Math.ceil(timeRemaining)}s`, 20, 45);
    ctx.restore();

    if (!gameOver && player.powerUpEndTime) {
        const remaining = (player.powerUpEndTime - Date.now()) / 1000;

        if (remaining > 0) {
            ctx.fillStyle = timeColor;
            ctx.font = "28px Arial";
            ctx.fillText(`Power-up time: ${remaining.toFixed(1)}s`, 21, 85);
        } else {
            player.powerUpEndTime = null;
        }
    }

    if (!gameOver && player.multishotEndTime) {
        const remainingMultishotTime = (player.multishotEndTime - Date.now()) / 1000;

        if (remainingMultishotTime > 0) {
            ctx.fillStyle = timeColor;
            ctx.font = "28px Arial";
            ctx.fillText(`Multishot time: ${remainingMultishotTime.toFixed(1)}s`, 21, 125);
        } else {
            player.multishotEndTime = null;
        }
    }
    }

    if (!useDomHud) {
    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '20px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('W = forward   A = rotate left   D = rotate right   S = backward   SPACE = shoot, restart', 10, SCREEN_HEIGHT - 10);

    ctx.font = '25px Arial';
    ctx.textAlign = 'right';
    ctx.fillText('N = Sound Effects ON/OFF   M = Music ON/OFF', SCREEN_WIDTH - 10, SCREEN_HEIGHT - 10);
    ctx.restore();

    const iconSize = 30;
    const iconX = 7;
    const iconY = canvas.height -60;
    if (powerUpImage.complete) {
        ctx.drawImage(powerUpImage, iconX, iconY, iconSize, iconSize);
    }

    ctx.font = "20px Arial";
    ctx.fillStyle = textColor;
    ctx.fillText("- Power-Up: Doubles speed and fire rate", iconX + iconSize + 10, iconY + 21);

    const multishotIconSize = 33;
    const multishotIconX = 6;
    const multishotIconY = canvas.height - 95;

    if (multishotImage.complete) {
        ctx.drawImage(multishotImage, multishotIconX, multishotIconY, multishotIconSize, multishotIconSize);
    }

    ctx.font = "20px Arial";
    ctx.fillStyle = textColor;
    ctx.fillText("- Multishot: Shoots 3 bullets at once", multishotIconX + multishotIconSize + 10, multishotIconY + 25);

    const strikeIconSize = 33;
    const strikeIconX = 6;
    const strikeIconY = canvas.height - 130;

    if (strikeImage.complete) {
        ctx.drawImage(strikeImage, strikeIconX, strikeIconY, strikeIconSize, strikeIconSize);
    }

    ctx.font = "20px Arial";
    ctx.fillStyle = textColor;
    ctx.fillText("- Strike: Hit: +200 points, Collision: game over", strikeIconX + strikeIconSize + 10, strikeIconY + 25);

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.font = '28px Arial';
    ctx.textAlign = 'right';

    ctx.fillText("Top Scores:", SCREEN_WIDTH - 10, SCREEN_HEIGHT - 650);

    let startY = SCREEN_HEIGHT - 615;
    let padding = 30;
    
    highScores.slice(0, 10).forEach((entry, index) => {
        let indexText = `${index + 1}.`;
        let scoreText = entry.score.toString();

        ctx.fillText(indexText, SCREEN_WIDTH - 80, startY + index * padding);
        ctx.fillText(scoreText, SCREEN_WIDTH - 10, startY + index * padding);
    });

    ctx.restore();
    }

    // Juice effektek a világ tetejére (a shake-transzformon belül), majd a
    // kamera-eltolás visszaállítása (a DOM HUD nem mozdulhat).
    if (juice) drawEffects(ctx);
    if (shakeApplied) ctx.restore();

    if (useDomHud) updateDomHud();

    animationFrameId = requestAnimationFrame(gameLoop);
}

let lastTime = performance.now();
let backgroundImage = getImage(`/themes/${theme}/background.webp`);

const radius = 23

function spawnPowerUp(type = "boost") {
    let x = Math.random() * (SCREEN_WIDTH - 2 * radius) + radius;
    let y = Math.random() * (SCREEN_HEIGHT - 2 * radius) + radius;
    if (isMultiplayer) {
        // Co-opban a host Firebase-be írja; a reconcile (mpApplyPowerups) hozza létre
        // lokálisan MINDKÉT félnél, hogy ugyanazt a powerupot lássák.
        if (isHost) mpSpawnPowerUp(x, y, type);
        return;
    }
    let p = new PowerUp(x, y, type);
    powerUps.push(p);
    drawable.push(p);
    updatable.push(p);
    playSound("/assets/audio/powerup_spawned.mp3", 0.15);
}

initAuth(
    (user, profile) => {
        // Bejelentkezés után (pl. a game over Google-gombból):
        if (gameOver && scoreSubmitted && !scoreClaimed) {
            if (profile) {
                // Van már profil → a meglévő nickkel mentjük a pontot.
                claimScoreWithName(profile.username, user.uid);
            } else {
                // Nincs profil → bekérjük a nicknamet, az lesz az új profil neve is.
                openNicknameModal();
            }
        }
        if (useDomHud && hudEls.gameOver && !hudEls.gameOver.hidden) renderGameOverStats();
    },
    () => {}
);
fetchTopScores();
animationFrameId = requestAnimationFrame(gameLoop);


function restartGame() {
    // Co-opban a "play again" mindkét játékost újraindítja: csak jelzünk (round++),
    // a tényleges reset a round-listenerből (mpRestart) fut le mindkét kliensen.
    if (isMultiplayer) { mpRequestRestart(); return; }

    updatable.length = 0;
    drawable.length = 0;
    hunters = [];
    mpHunterState = null;
    mpProcessedHHits.clear();
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

    // Ha vendégként kihagyta a bejelentkezést, a pontot most mentjük Anonymousként.
    flushGuestScoreAsAnonymous();

    score = 0
    scoreMultiplier = 1;
    frenzyActive = false;
    frenzyCountdownText = null;
    lastFrenzyCountStage = null;
    wasInFrenzy = false;
    comboCount = 0;
    comboMultiplier = 1;
    lastComboHitTime = 0;
    nearMissPops = [];
    if (juice) resetEffects();
    scoreSubmitted = false;
    scoreClaimed = false;
    pendingGuestScore = false;
    lastGameScore = 0;

    gameStartTime = Date.now();

    spawnedMultishots = new Set();
    multishotSpawnTimes = [10, 30, 50];
    
    spawnedStrikes = new Set();
    pendingStrikeTimes = [10, 30, 50];
    nextStrikeCountdownStart = null;
    currentStrikeTime = null;
    strikeCountdownText = null;
    pendingHunterTimes = [15, 45];

    restartButton.style.display = "none";

    if (useDomHud) {
        releaseGameOverFocus();
        if (hudEls.gameOver) hudEls.gameOver.hidden = true;
        if (hudEls.help) hudEls.help.hidden = true;
        const hb = document.getElementById('hudHelpBtn');
        if (hb) hb.innerHTML = '<i class="fas fa-question"></i>';   // ikon vissza „?"-re
    }

    lastTime = performance.now();

    cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(gameLoop);
}


let restartButton = document.getElementById("restartButton");
restartButton.addEventListener("click", () => {
    restartGame();
});

document.addEventListener("keydown", (event) => {
    if (event.code === "Space" && gameOver) {
        restartGame();
    }
});

// Felső pontkorlát — a Firebase Security Rules-szal összhangban (lásd database.rules.json).
// 25 000: a kombó (×4) + frenzy (×2) + near-miss melletti reális/„tökéletes" futás
// (~10–19 ezer) fölött van, de blokkolja az irreálisan injektált értékeket.
const MAX_SCORE = 25000;

// A kliensoldali pontszám fegyelmezése a DB-be írás előtt (defense-in-depth).
// A tényleges védelmet a Security Rules adja; ez csak a véletlen invalid adatot szűri.
function sanitizeScore(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_SCORE);
}

function sanitizeName(value) {
    const name = String(value ?? '').trim().slice(0, 16);
    return name || 'Anonymous';
}

async function saveScore(score) {
    const safeScore = sanitizeScore(score);
    lastGameScore = safeScore;

    if (currentUser && currentProfile) {
        // Bejelentkezve: egyből a saját névvel mentjük.
        scoreClaimed = true;
        pendingGuestScore = false;
        await persistScore(safeScore, sanitizeName(currentProfile.username), currentUser.uid);
    } else if (useDomHud) {
        // Space (DOM HUD, van game over panel): a vendég-pontot NEM írjuk ki azonnal
        // Anonymousként — várunk, hátha bejelentkezik / profilt hoz létre a panelon.
        // Ha mégsem (Play again / Change theme / Main menu / vissza), a
        // flushGuestScoreAsAnonymous() menti Anonymousként.
        scoreClaimed = false;
        pendingGuestScore = true;
        await fetchTopScores();   // a panel addig a jelenlegi top listát mutatja
    } else {
        // Többi téma (canvas HUD, nincs panel): a régi viselkedés — azonnal Anonymous.
        scoreClaimed = false;
        pendingGuestScore = false;
        await persistScore(safeScore, 'Anonymous', null);
    }
}

// Egy pont kiírása a scores node-ba (+ stat frissítés, ha van uid), majd a lista frissítése.
async function persistScore(scoreValue, name, uid) {
    try {
        const entry = uid ? { score: scoreValue, name, uid } : { score: scoreValue, name };
        await push(ref(db, 'scores'), entry);
        if (uid) await bumpUserStats(uid, scoreValue);
        await fetchTopScores();
    } catch (e) {
        console.error('[persistScore] failed:', e);
    }
}

// User statisztika frissítése (totalGames / bestScore / totalScore).
async function bumpUserStats(uid, scoreValue) {
    const statsRef = ref(db, `users/${uid}/stats`);
    const snap = await get(statsRef);
    const s = snap.exists() ? snap.val() : { totalGames: 0, bestScore: 0, totalScore: 0 };
    await set(statsRef, {
        totalGames: (s.totalGames || 0) + 1,
        bestScore: Math.max(s.bestScore || 0, scoreValue),
        totalScore: (s.totalScore || 0) + scoreValue,
    });
}

// A függőben lévő vendég-pont hozzárendelése egy userhez (megadott névvel + uid-del).
// Így a pont a megadott nickkel kerül a ranglistára és a profil statokba — nincs Anonymous.
async function claimScoreWithName(name, uid) {
    if (scoreClaimed) return;
    scoreClaimed = true;
    pendingGuestScore = false;
    await persistScore(lastGameScore, sanitizeName(name), uid);
    if (useDomHud && hudEls.gameOver && !hudEls.gameOver.hidden) renderGameOverStats();
}

// Ha a vendég nem jelentkezik be és továbblép/újraindít, a pont Anonymousként mentődik.
async function flushGuestScoreAsAnonymous() {
    if (!pendingGuestScore || scoreClaimed) return;
    pendingGuestScore = false;
    await persistScore(lastGameScore, 'Anonymous', null);
}

async function fetchTopScores() {
    try {
        // Ugyanaz a logika, mint a működő főoldali ranglistánál (main_firebase.js):
        // minden score-t lekérünk, kiszűrjük az érvényteleneket, csökkenő sorrend.
        // Co-opban a külön mpScores táblát mutatjuk (NEM a singleplayer scores-t).
        const snapshot = await get(ref(db, isMultiplayer ? 'mpScores' : 'scores'));

        const data = [];
        if (snapshot.exists()) {
            snapshot.forEach(child => {
                const val = child.val();
                if (val && typeof val.score === 'number') data.push(val);
            });
            data.sort((a, b) => b.score - a.score);
        }
        highScores = data;

        // Ha a game over panel épp látszik, frissítsük a friss adatokkal.
        if (useDomHud && hudEls.gameOver && !hudEls.gameOver.hidden) {
            renderGameOverScores();
            renderGameOverStats();
        }
    } catch (e) {
        console.error('Failed to fetch scores:', e);
    }
}

// ── DOM HUD frissítése (minden frame, csak ha van #hud overlay) ──
let _hudLastScore = 0;
let _hudPointsAt = 0;
let _hudLastComboCount = 0;
let _hudLastComboMult = 1;

// Dirty-check segédek: csak akkor írunk a DOM-ba, ha tényleg változott az érték.
// Így nem szemeteljük a layoutot frame-enként redundáns írásokkal.
function _setText(el, v) { if (el && el.textContent !== v) el.textContent = v; }
function _setHidden(el, v) { if (el && el.hidden !== v) el.hidden = v; }
function _setWidth(el, pct) { const s = `${pct}%`; if (el && el._w !== s) { el.style.width = s; el._w = s; } }

function updateDomHud() {
    const now = Date.now();

    // Idő + fogyó sáv
    _setText(hudEls.time, String(Math.max(0, Math.ceil(timeRemaining))));
    _setWidth(hudEls.timeBar, Math.max(0, Math.min(1, timeRemaining / gameTime)) * 100);

    // Pont + „+X" pop (pontváltozáskor felvillan, majd elhalványul)
    _setText(hudEls.score, String(score));
    if (score !== _hudLastScore) {
        if (lastEarnedPoints !== null) hudEls.plus.textContent = `+${lastEarnedPoints}`;
        _hudPointsAt = now;
        _hudLastScore = score;
        // A pont-számláló „megrándul" növekedéskor (juice).
        hudEls.score.classList.remove('hud-score--punch');
        void hudEls.score.offsetWidth;   // reflow → animáció újraindítása
        hudEls.score.classList.add('hud-score--punch');
    }
    hudEls.plus.style.opacity = (now - _hudPointsAt < 1100) ? '1' : '0';

    // Strike figyelmeztetés
    if (strikeCountdownText) {
        _setText(hudEls.strikeText, strikeCountdownText);
        _setHidden(hudEls.strike, false);
    } else {
        _setHidden(hudEls.strike, true);
    }

    // Vezérlés-tipp csak a 3-2-1 visszaszámlálás alatt
    _setHidden(hudEls.controlsHint, !countdownRunning);

    // Frenzy-jelző: előbb a 3-2-1 visszaszámláló szöveg, majd az aktív „dupla pont".
    if (hudEls.frenzy) {
        let txt = null;
        if (!gameOver && !countdownRunning) {
            if (frenzyCountdownText) txt = frenzyCountdownText;
            else if (frenzyActive) txt = '2× DOUBLE POINTS';
        }
        if (txt) {
            hudEls.frenzy.innerHTML = `<i class="fas fa-bolt"></i> ${txt}`;
            hudEls.frenzy.hidden = false;
        } else {
            hudEls.frenzy.hidden = true;
        }
    }

    // Boost powerup chip + fogyó sáv
    const boostLeft = player.powerUpEndTime ? (player.powerUpEndTime - now) / 1000 : 0;
    if (boostLeft > 0) {
        hudEls.boost.hidden = false;
        hudEls.boostBar.style.width = `${Math.min(1, boostLeft / 8) * 100}%`;
    } else {
        hudEls.boost.hidden = true;
    }

    // Multishot powerup chip + fogyó sáv
    const msLeft = player.multishotEndTime ? (player.multishotEndTime - now) / 1000 : 0;
    if (msLeft > 0) {
        hudEls.multishot.hidden = false;
        hudEls.multishotBar.style.width = `${Math.min(1, msLeft / 8) * 100}%`;
    } else {
        hudEls.multishot.hidden = true;
    }

    // Shield chip: amíg aktív a pajzs vagy tart az 1 mp grace (nincs visszaszámláló sáv).
    // FONTOS: _inShieldGrace()-t nézünk, NEM isInvincible()-t, hogy a dash i-frame
    // ne villantsa fel a shield-chipet.
    if (hudEls.shield) {
        hudEls.shield.hidden = !(player.shieldActive || player._inShieldGrace());
    }

    // Dash cooldown chip: a sáv a visszatöltődést mutatja (tele = kész). Kész
    // állapotban cián glow (.is-ready). Játék közben látszik, game over-kor elrejtjük.
    if (hudEls.dash) {
        hudEls.dash.hidden = gameOver;
        if (!gameOver) {
            const cd = Math.max(0, player.dashReadyAt - now);
            const frac = player.dashCooldownMs ? 1 - cd / player.dashCooldownMs : 1;
            hudEls.dashBar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
            hudEls.dash.classList.toggle('is-ready', cd <= 0);
        }
    }

    // Kombó-jelző: x2-től felfelé látszik, fogyó ablak-sávval, és minden új
    // találatnál „popol".
    if (hudEls.combo) {
        if (comboMultiplier >= 2) {
            // Szöveg csak szorzó-váltáskor (hogy a fogyó sávot ne írjuk felül frame-enként).
            if (hudEls.comboText) {
                if (comboMultiplier !== _hudLastComboMult) {
                    hudEls.comboText.innerHTML = `<b>×${comboMultiplier}</b> COMBO`;
                    _hudLastComboMult = comboMultiplier;
                }
            } else {
                hudEls.combo.innerHTML = `<b>×${comboMultiplier}</b> COMBO`;
            }
            hudEls.combo.hidden = false;
            // Fogyó kombó-ablak sáv (találatkor visszatöltődik a 2 mp-es ablak).
            if (hudEls.comboBar) {
                const remaining = Math.max(0, COMBO_WINDOW - (now - lastComboHitTime));
                hudEls.comboBar.style.width = `${(remaining / COMBO_WINDOW) * 100}%`;
            }
            if (comboCount !== _hudLastComboCount) {
                hudEls.combo.classList.remove('hud-combo--pop');
                void hudEls.combo.offsetWidth;   // reflow → animáció újraindítása
                hudEls.combo.classList.add('hud-combo--pop');
                _hudLastComboCount = comboCount;
            }
        } else {
            hudEls.combo.hidden = true;
            _hudLastComboCount = 0;
            _hudLastComboMult = 1;
        }
    }
}

let _goCelebrated = false;

function showGameOverPanel() {
    if (!hudEls.gameOver) return;
    _goCelebrated = false;
    hudEls.goResult.textContent = gameOverReason === 'collision' ? 'Game over' : "Time's up";
    hudEls.goScore.textContent = score;
    if (hudEls.goScoresTitle) {
        hudEls.goScoresTitle.innerHTML = isMultiplayer
            ? '<i class="fas fa-trophy"></i> Top Scores — Co-op'
            : '<i class="fas fa-trophy"></i> Top Scores';
    }
    renderGameOverScores();
    renderGameOverStats();
    hudEls.gameOver.hidden = false;
    trapGameOverFocus();
}

// A játékos teljesítményének kiértékelése: ranglista-pozíció, személyes legjobb,
// vendég-felhívás, és top 20 / új rekord esetén ünneplés (konfetti + glow).
function renderGameOverStats() {
    if (!hudEls.gameOver) return;

    // Ranglista-pozíció: hány érvényes pont nagyobb a mostaninál.
    const better = highScores.filter(e => typeof e.score === 'number' && e.score > score).length;
    const rank = better + 1;
    hudEls.goRank.textContent = `#${rank}`;
    const isTop20 = rank <= 20;

    const signedIn = !!(currentUser && currentProfile);
    let isNewBest = false;

    if (isMultiplayer) {
        // Co-op: a pont a közös mpScores táblába megy — nincs személyes rekord,
        // nincs claim/bejelentkezés-felhívás. Csak a közös rang + (esetleg) top 20.
        hudEls.goBestCard.hidden = true;
        hudEls.goPerf.hidden = true;
        hudEls.goSigninBtn.hidden = true;
    } else if (signedIn) {
        const prevBest = (currentProfile.stats && currentProfile.stats.bestScore) || 0;
        isNewBest = score > prevBest;
        hudEls.goBestCard.hidden = false;
        hudEls.goBest.textContent = Math.max(prevBest, score);
        hudEls.goSigninBtn.hidden = true;

        if (isNewBest) {
            hudEls.goPerf.hidden = true;
        } else {
            const diff = prevBest - score;
            hudEls.goPerf.textContent = diff > 0 ? `${diff} pts off your best` : 'Matched your best';
            hudEls.goPerf.hidden = false;
        }
    } else {
        // Vendég: nincs személyes legjobb, felhívás a bejelentkezésre.
        hudEls.goBestCard.hidden = true;
        hudEls.goPerf.hidden = true;
        hudEls.goSigninBtn.hidden = false;
    }

    // Jelvény: új személyes rekord vagy top 20-as eredmény.
    if (isNewBest) {
        hudEls.goBadgeText.textContent = 'New personal best!';
        hudEls.goBadge.hidden = false;
    } else if (isTop20) {
        hudEls.goBadgeText.textContent = `Top 20 — ranked #${rank}!`;
        hudEls.goBadge.hidden = false;
    } else {
        hudEls.goBadge.hidden = true;
    }

    // Ünneplés egyszer, ha új rekord vagy top 20 (és nincs reduced-motion).
    if (!_goCelebrated && (isNewBest || isTop20)) {
        _goCelebrated = true;
        celebrateGameOver();
    }
}

function celebrateGameOver() {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    if (hudEls.goCard) {
        hudEls.goCard.classList.add('go-celebrate');
    }
    if (hudEls.goConfetti) {
        const colors = ['#ff3b3b', '#fac775', '#ffffff', '#ff7a7a', '#ffd24a'];
        hudEls.goConfetti.innerHTML = '';
        for (let i = 0; i < 36; i++) {
            const s = document.createElement('span');
            s.style.left = `${Math.random() * 100}%`;
            s.style.background = colors[i % colors.length];
            s.style.animationDelay = `${Math.random() * 0.5}s`;
            s.style.animationDuration = `${1.3 + Math.random() * 0.9}s`;
            hudEls.goConfetti.appendChild(s);
        }
    }
}

// ── Fókusz-csapda a game over panelhez (akadálymentesség) ──
let _goFocusHandler = null;
function trapGameOverFocus() {
    if (!hudEls.gameOver) return;
    const focusables = hudEls.gameOver.querySelectorAll('button:not([hidden]), a[href]');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first.focus();

    _goFocusHandler = (e) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    };
    hudEls.gameOver.addEventListener('keydown', _goFocusHandler);
}

function releaseGameOverFocus() {
    if (hudEls && hudEls.gameOver && _goFocusHandler) {
        hudEls.gameOver.removeEventListener('keydown', _goFocusHandler);
        _goFocusHandler = null;
    }
    if (hudEls && hudEls.goCard) hudEls.goCard.classList.remove('go-celebrate');
    if (hudEls && hudEls.goConfetti) hudEls.goConfetti.innerHTML = '';
}

function renderGameOverScores() {
    const tbody = hudEls.goScoresBody;
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!highScores.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.textContent = 'No scores yet';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }
    highScores.slice(0, 5).forEach((entry, i) => {
        const tr = document.createElement('tr');
        if (i === 0) tr.classList.add('gold');
        else if (i === 1) tr.classList.add('silver');
        else if (i === 2) tr.classList.add('bronze');
        const rank = document.createElement('td');
        rank.textContent = `#${i + 1}`;
        const name = document.createElement('td');
        name.textContent = entry.name || 'Anonymous';   // textContent → XSS-biztos
        const sc = document.createElement('td');
        sc.textContent = entry.score;
        tr.append(rank, name, sc);
        tbody.appendChild(tr);
    });
}

function spawnStrike() {
    playSound("/assets/audio/strike_whoosh.mp3", 0.5);
    const strikeObj = new Strike(
        updatable,
        drawable,
        player,
        () => {
            // A pajzs a strike-ot is kivédi (mint az aszteroida-ütközést).
            if (player.shieldActive) {
                player.breakShield();
                playSound("/assets/audio/shield_gone.mp3", 0.5);
                if (juice) {
                    spawnExplosion(player.position.x, player.position.y, '#7fe0ff', 18, { speedMax: 320, sizeMax: 6 });
                    shake(7, 160);
                }
            } else if (!player.isInvincible()) {
                gameOver = true;
                gameOverTime = Date.now();
                gameOverReason = "collision";
                if (juice) {
                    spawnExplosion(player.position.x, player.position.y, '#ff7a4a', 28, { speedMax: 440, sizeMax: 7, lifeMax: 0.85 });
                    spawnExplosion(player.position.x, player.position.y, '#ffd24a', 14, { speedMax: 300, sizeMax: 5 });
                    shake(15, 340);
                }
                if (!scoreSubmitted) {
                    scoreSubmitted = true;
                    saveScore(score);
                }
            }
            // ha épp sebezhetetlen (pajzs-grace), a strike sem öl
        },
        () => {
            const earned = 200 * scoreMultiplier;   // frenzy alatt +400
            score += earned;
            if (getSoundVariant()) {
                playSound("/assets/audio/adi_good.mp3", 0.5);
              } else {
                playSound("/assets/audio/strike_earned.mp3", 0.5);
              }
            lastEarnedPoints = earned;
            if (juice) {
                const sx = strikeObj.position.x, sy = strikeObj.position.y;
                spawnExplosion(sx, sy, '#ffd24a', 22, { speedMax: 380, sizeMax: 6.5, lifeMax: 0.7 });
                spawnExplosion(sx, sy, '#ffffff', 8, { speedMax: 220, sizeMax: 4 });
                spawnScorePop(sx, sy, earned, '#ffe27a');
                shake(9, 200);
            }
        }
    );
}

// Vadász-drón létrehozása + callbackek (a Strike mintájára).
function spawnHunter() {
    playSound('/assets/audio/strike_alarm.mp3', 0.6);   // spawn-figyelmeztetés (meglévő hang)
    const h = new Hunter(
        updatable,
        drawable,
        player,
        () => {
            // Hozzáért a hajóhoz — mint az aszteroida/strike ütközés.
            if (player.shieldActive) {
                player.breakShield();
                playSound('/assets/audio/shield_gone.mp3', 0.5);
                if (juice) {
                    spawnExplosion(player.position.x, player.position.y, '#7fe0ff', 18, { speedMax: 320, sizeMax: 6 });
                    shake(7, 160);
                }
            } else if (!player.isInvincible()) {
                if (isMultiplayer) {
                    // Co-opban nincs azonnali game over: a host „down" állapotba kerül,
                    // a partnere élesztheti (ugyanaz, mint az aszteroida-ütközésnél).
                    if (localState === 'alive' && Date.now() >= reviveInvincibleUntil) mpGoDown();
                } else {
                    gameOver = true;
                    gameOverTime = Date.now();
                    gameOverReason = 'collision';
                    if (juice) {
                        spawnExplosion(player.position.x, player.position.y, '#ff7a4a', 28, { speedMax: 440, sizeMax: 7, lifeMax: 0.85 });
                        spawnExplosion(player.position.x, player.position.y, '#ffd24a', 14, { speedMax: 300, sizeMax: 5 });
                        shake(15, 340);
                    }
                    if (!scoreSubmitted) {
                        scoreSubmitted = true;
                        saveScore(score);
                    }
                }
            }
            // pajzs-grace / dash i-frame alatt nincs hatás
        },
        (hx, hy) => {
            // Lelőtték (3. találat) — +50 × frenzy × kombó, és a kombóba is beleszámít.
            let combo = 1;
            if (theme === 'space') {
                registerComboHit();
                combo = comboMultiplier;
            }
            const earned = 50 * scoreMultiplier * combo;
            score += earned;
            lastEarnedPoints = earned;
            playSound('/assets/audio/explosion.mp3', 0.4);
            if (juice) {
                spawnExplosion(hx, hy, '#ff7a3a', 26, { speedMax: 440, sizeMax: 7, lifeMax: 0.85 });
                spawnExplosion(hx, hy, '#ffd24a', 12, { speedMax: 300, sizeMax: 5 });
                spawnScorePop(hx, hy, earned, '#ffd0a0');
                shake(9, 220);
            }
        }
    );
    hunters.push(h);   // host-sync + cleanup nyilvántartás
}

const soundToggleButton = document.getElementById('soundToggle');

soundToggleButton.innerHTML = `<i class="fas ${getMuted() ? 'fa-volume-off' : 'fa-volume-high'}"></i>`;

function updateSoundIcon() {
  const muted = getMuted();
  soundToggleButton.innerHTML = `<i class="fas ${muted ? 'fa-volume-off' : 'fa-volume-high'}"></i>`;
}

soundToggleButton.addEventListener('click', () => {
  toggleMuted();
  soundToggleButton.blur();
  updateSoundIcon();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'n' || event.key === 'N') {
    toggleMuted();
    updateSoundIcon();
  }
});

// ── B&Á hangvariáns ──
// A logika megmarad (soundManager.js: toggleSoundVariant/getSoundVariant), de a
// publikus buildben NINCS gombja és NINCS billentyűparancsa, így nem használható.
// A toggleVariant függvényt meghagyjuk (könnyen visszakapcsolható), de nem kötjük be.
const soundVariantToggle = document.getElementById('soundVariantToggle');

function toggleVariant() {
    const alt = toggleSoundVariant();
    if (soundVariantToggle) {
        soundVariantToggle.blur();
        soundVariantToggle.textContent = `B&Á: ${alt ? 'OFF' : 'ON'}`;
    }
}

if (soundVariantToggle) {
    soundVariantToggle.textContent = `B&Á: ${getSoundVariant() ? 'OFF' : 'ON'}`;
    soundVariantToggle.addEventListener('click', toggleVariant);
}

// ── DOM HUD gomb-bekötések (csak ha van #hud overlay) ──
if (useDomHud) {
    const helpBtn = document.getElementById('hudHelpBtn');
    // A súgó-sáv nyitása/zárása. Nyitva a „?" gomb „×"-re vált (és a sáv fölött marad,
    // így mindig kattintható). Zárható: a gombbal, a sávra kattintva, vagy Escape-pel.
    function setHelpOpen(open) {
        if (!hudEls.help) return;
        hudEls.help.hidden = !open;
        if (helpBtn) helpBtn.innerHTML = open
            ? '<i class="fas fa-times"></i>'
            : '<i class="fas fa-question"></i>';
    }
    if (helpBtn) {
        helpBtn.addEventListener('click', () => {
            helpBtn.blur();
            setHelpOpen(hudEls.help && hudEls.help.hidden);   // toggle
        });
    }
    if (hudEls.help) {
        hudEls.help.addEventListener('click', () => setHelpOpen(false));   // kattintás a sávra → bezár
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && hudEls.help && !hudEls.help.hidden) setHelpOpen(false);
    });
    const playAgainBtn = document.getElementById('goPlayAgain');
    if (playAgainBtn) {
        playAgainBtn.addEventListener('click', () => {
            playAgainBtn.blur();
            restartGame();
        });
    }
    const signinBtn = document.getElementById('goSigninBtn');
    if (signinBtn) {
        signinBtn.addEventListener('click', () => {
            signinBtn.blur();
            signInWithGoogle();   // sikeres bejelentkezéskor az initAuth callback frissít
        });
    }

    // Change theme / Main menu: ha függőben lévő vendég-pont van, navigálás
    // előtt mentsük Anonymousként (hogy a guest pont se vesszen el).
    if (hudEls.gameOver) {
        hudEls.gameOver.querySelectorAll('.go-btn').forEach(link => {
            link.addEventListener('click', async (e) => {
                if (pendingGuestScore && !scoreClaimed) {
                    e.preventDefault();
                    const href = link.getAttribute('href');
                    await flushGuestScoreAsAnonymous();
                    window.location.href = href;
                }
            });
        });
    }

    // ↩︎ vissza gomb: navigálás előtt mentsük a függőben lévő vendég-pontot.
    const backBtn = document.getElementById('mainMenuButton');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (pendingGuestScore && !scoreClaimed) flushGuestScoreAsAnonymous();
        });
    }

    // Nickname modal (új profil a játék végén)
    const nicknameSubmitBtn = document.getElementById('nicknameSubmitBtn');
    const nicknameInput = document.getElementById('nicknameInput');
    if (nicknameSubmitBtn) nicknameSubmitBtn.addEventListener('click', submitNickname);
    if (nicknameInput) nicknameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitNickname(); });
}

// ── Nickname modal logika (csak a játékvégi új-profil flow-hoz) ──
function openNicknameModal() {
    const modal = document.getElementById('nicknameModal');
    if (!modal) return;
    modal.hidden = false;
    const input = document.getElementById('nicknameInput');
    if (input) { input.value = ''; input.focus(); }
}

function closeNicknameModal() {
    const modal = document.getElementById('nicknameModal');
    if (modal) modal.hidden = true;
}

function validateNickname(name) {
    if (name.length < 3) return 'At least 3 characters required.';
    if (name.length > 16) return 'Maximum 16 characters allowed.';
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return 'Only letters, numbers and underscores allowed.';
    return null;
}

function showNicknameError(msg) {
    const err = document.getElementById('nicknameError');
    const btn = document.getElementById('nicknameSubmitBtn');
    if (err) { err.textContent = msg; err.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
}

async function submitNickname() {
    const input = document.getElementById('nicknameInput');
    const err = document.getElementById('nicknameError');
    const btn = document.getElementById('nicknameSubmitBtn');
    if (!input || !currentUser) return;

    const raw = input.value.trim();
    const problem = validateNickname(raw);
    if (problem) { showNicknameError(problem); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    if (err) err.hidden = true;

    try {
        if (await isUsernameTaken(raw)) { showNicknameError('Username is already taken.'); return; }
        await createProfile(currentUser.uid, raw);   // beállítja a currentProfile-t is (auth.js)
        closeNicknameModal();
        await claimScoreWithName(raw, currentUser.uid);   // a pont az új nickkel mentődik
    } catch (e) {
        console.error('[submitNickname] failed:', e);
        showNicknameError('Something went wrong. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
    }
}