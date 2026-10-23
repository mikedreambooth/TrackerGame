/**
 * Rainbow Kart: kart races on tracks floating in space (a rainbow figure-8, a castle, a desert;
 * see tracks.ts). Split screen: each player gets their own vertical slice of the screen (left
 * to right as they stand), with a chase camera behind their kart, which is in their player
 * colour. LAPS laps to win, then everyone stands on a podium in finishing order (podium.ts),
 * then it's back to the track picker.
 *
 * Controls: hold both hands out in front of the chest as if on a steering wheel, and turn it
 * (the angle between the wrists is the wheel's angle). Karts accelerate on their own. Let go
 * of the wheel and the kart slows to a crawl and steers itself along the track, so nobody
 * gets stuck; grab it again for full speed. In the picker, hold a hand on a track to race it
 * (or raise both hands for the one shown); holding the wheel there lets you practise.
 *
 * Karts live in track coordinates (distance along, offset across, heading relative to the
 * track), which keeps the walls, the bumps and the laps simple.
 *
 * All the textures are pixel art drawn on tiny canvases (pixel.ts) and shown with nearest
 * filtering; the 3D view is rendered at PIXEL_RATIO for a chunky look (?px=1 for full res).
 * Sound effects: public/sfx (CC0, see CREDITS.txt); any that's missing falls back to a synth blip.
 */
import {
  DwellMenu,
  KP,
  RoundFlow,
  blip,
  createGame,
  drawText,
  fitCanvas,
  loadAssets,
  noise,
  playerName,
  prepareSpeech,
  say,
  type Assets,
  type PlayOptions,
  type Player,
  type Playing,
} from '@trackergame/sdk';
import * as THREE from '@trackergame/sdk/three';
import { createStage3D } from '@trackergame/sdk/three';
import { mixRgb, pixelTexture, rgb, seeded, setAnisotropy, shade } from './pixel';
import { Podium } from './podium';
import { TRACK_DEFS, Track, type TrackPoint } from './tracks';

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// ---------- tuning ----------

/** Laps to win (?laps=N for testing). */
const LAPS = Number(new URLSearchParams(location.search).get('laps')) || 3;
/** Units/s: full speed holding the wheel, the crawl without it, and the cruise after the finish. */
const MAX_SPEED = 30;
const CRAWL = 9;
const CRUISE = 14;
const ACCEL = 12;
/** Drag (per second) while scraping along a wall: tops out around ACCEL / WALL_DRAG = 20 units/s, so steering pays. */
const WALL_DRAG = 0.6;
/** Yaw rate (rad/s) at full lock and full speed. */
const TURN = 1.5;
/** How strongly a kart straightens up along the track by itself (per second). Forgiving for kids. */
const ASSIST = 1;
/** Karts can't turn further than this from the track's direction (no driving backwards). */
const MAX_REL = 1.1;
const KART_W = 1.5;
const KART_L = 2.4;
/** Wheel angle (rad): below DEAD counts as straight, FULL is full lock. */
const STEER_DEAD = 0.08;
const STEER_FULL = 0.65;
/** The wheel counts as held after this long (s), and as let go after this long without it (tracking flickers). */
const GRAB_S = 0.12;
const LET_GO_S = 0.4;
/** After the winner finishes, the others have this long (s) before the race ends. */
const FINISH_WAIT_S = 15;
/** Grid: this far behind the start line, this far apart across. */
const GRID_BACK = 6;
const GRID_GAP = 2.6;
const MIN_SCORE = 0.3;
/** The 3D view's pixel ratio (CSS pixels per rendered pixel is 1 / this). */
const PIXEL_RATIO = Number(new URLSearchParams(location.search).get('px')) || 0.5;
/** ?track=castle starts on that track (testing). */
const TRACK_PARAM = new URLSearchParams(location.search).get('track');

const PLACES = ['1st', '2nd', '3rd', '4th'];
const placeName = (n: number) => PLACES[n - 1] ?? `${n}th`;

// ---------- setup ----------

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
glCanvas.style.imageRendering = 'pixelated';
const hud = document.getElementById('hud') as HTMLCanvasElement;
const ctx = hud.getContext('2d')!;
// people: 'game' -> cut-outs come to us (game.segmentation(), asked for only on the podium) and
// nobody else draws them. No footprints: everyone's looking at their own kart.
const game = await createGame({ people: 'game', feet: false });
const flow = new RoundFlow(game, {
  title: 'Rainbow Kart',
  seconds: 0,
  resultsMinMs: 4000,
  customLobby: true,
  customResults: true,
  againToLobby: true,
  // Hands on the wheel make a hand cursor too: don't let it press Play again or Home.
  handsBusy: (p) => readWheel(p) !== null || !!karts.get(p.slot)?.held,
});

const stage = createStage3D(glCanvas);
const { scene, renderer } = stage;
renderer.autoClear = false;
setAnisotropy(renderer.capabilities.getMaxAnisotropy());
scene.add(new THREE.HemisphereLight(0xffffff, 0x6040a0, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 80, 40);
scene.add(sun);

// ---------- sounds ----------

const SFX = ['engine', 'wall', 'bump', 'countdown', 'go', 'lap', 'finallap', 'finish', 'cheer', 'select', 'hover'] as const;
type Sfx = (typeof SFX)[number];
const sounds: Partial<Record<Sfx, Assets>> = {};
await Promise.all(
  SFX.map(async (name) => {
    try {
      // The engine is a WAV: it loops cleanly.
      sounds[name] = await loadAssets({ sounds: { [name]: `sfx/${name}.${name === 'engine' ? 'wav' : 'ogg'}` } });
    } catch {
      /* missing: the synth fallback plays instead */
    }
  }),
);

/** Play a sound effect, or `fallback` (a synth blip) if it isn't there. */
function sfx(name: Sfx, fallback: () => void, opts?: PlayOptions): Playing | null {
  const a = sounds[name];
  if (a) return a.play(name, opts);
  fallback();
  return null;
}

/** One engine hum for everyone, pitched by the fastest kart, louder the more karts are moving. */
let engine: Playing | null = null;
let engineAt = 0;
function updateEngine(now: number) {
  const racing = flow.state === 'playing' || flow.state === 'lobby';
  const ks = [...karts.values()];
  const top = Math.max(0, ...ks.map((k) => k.speed)) / MAX_SPEED;
  const moving = ks.filter((k) => k.speed > 1).length;
  const volume = racing && !game.paused && moving ? 0.12 + 0.05 * moving * Math.min(1, top * 2) : 0;
  if (!engine && volume > 0 && sounds.engine) engine = sfx('engine', () => {}, { loop: true, volume: 0, rate: 0.7 });
  // Not every frame: inside the launcher each change is a message.
  if (engine && now - engineAt > 80) {
    engineAt = now;
    engine.adjust({ rate: 0.7 + top * 0.9, volume });
  }
}

const sfxWall = () => sfx('wall', () => (noise(120, 0.25), blip(160, 120, 'square', 0.08, 90)), { volume: 0.7 });
const sfxBump = () => sfx('bump', () => blip(260, 90, 'square', 0.1, 140), { volume: 0.7 });
const sfxLap = () => sfx('lap', () => [784, 988, 1175].forEach((f, i) => setTimeout(() => blip(f, 110, 'square', 0.1), i * 90)));
const sfxFinalLap = () => sfx('finallap', () => [659, 784, 988, 1319].forEach((f, i) => setTimeout(() => blip(f, 120, 'square', 0.12), i * 100)));
const sfxFinish = () =>
  sfx('finish', () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, i === 5 ? 400 : 130, 'square', 0.12), i * 120)), {
    volume: 2.5, // a quiet recording
  });

// ---------- tracks ----------

const tracks = TRACK_DEFS.map((d) => new Track(d));
for (const t of tracks) scene.add(t.group);
let track = tracks.find((t) => t.def.id === TRACK_PARAM) ?? tracks[0];

function setTrack(t: Track) {
  track = t;
  for (const o of tracks) o.group.visible = o === t;
  scene.background = new THREE.Color(t.def.sky);
  toGrid();
}

// ---------- the karts ----------

interface KartLook {
  body: THREE.Material;
  suit: THREE.Material;
  helmet: THREE.Material;
  visor: THREE.Material;
}
const looks = new Map<string, KartLook>();
const darkMat = new THREE.MeshLambertMaterial({ map: pixelTexture(8, 8, (x, y) => shade([60, 56, 72], (x + y) % 3 ? 1 : 0.8)) });
const metalMat = new THREE.MeshLambertMaterial({ map: pixelTexture(8, 8, (x, y) => (y === 0 || x === 0 ? [230, 230, 240] : [150, 150, 165])) });
const tyreMat = new THREE.MeshLambertMaterial({
  map: pixelTexture(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4 ? [190, 190, 200] : y % 2 ? [28, 28, 32] : [58, 58, 64])),
});
const shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  alphaMap: pixelTexture(8, 8, (x, y) => (Math.hypot(x - 3.5, y - 3.5) < 3.6 ? [255, 255, 255] : [0, 0, 0])),
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
});

/** Pixel-art materials in a player's colour: paintwork with a racing stripe, suit, helmet with a visor. */
function lookFor(color: string): KartLook {
  let l = looks.get(color);
  if (l) return l;
  const c = rgb(color);
  const r = seeded(parseInt(color.slice(1), 16));
  const body = pixelTexture(16, 16, (x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return shade(c, 0.55);
    if (x === 7 || x === 8) return [255, 255, 255];
    if (y === 1) return mixRgb(c, [255, 255, 255], 0.45);
    return shade(c, 0.88 + r() * 0.14);
  });
  const suit = pixelTexture(8, 8, (x, y) => shade(c, (x + y) % 4 === 0 ? 0.55 : 0.7));
  const helmet = pixelTexture(8, 8, (x, y) => (y === 1 && x > 1 && x < 6 ? mixRgb(c, [255, 255, 255], 0.6) : shade(c, 0.95)));
  const visor = pixelTexture(8, 8, (x, y) => {
    if (y >= 3 && y <= 5 && x >= 1 && x <= 6) return x === 2 && y === 3 ? [255, 255, 255] : [24, 30, 60];
    return shade(c, 0.95);
  });
  const lambert = (map: THREE.Texture) => new THREE.MeshLambertMaterial({ map });
  l = { body: lambert(body), suit: lambert(suit), helmet: lambert(helmet), visor: lambert(visor) };
  looks.set(color, l);
  return l;
}

interface Kart {
  slot: number;
  id: number;
  color: string;
  /** Distance along the track (wraps at its length). */
  s: number;
  /** Across the track from the centre, + = left. */
  d: number;
  /** Heading relative to the track, + = to the left. */
  rel: number;
  speed: number;
  /** Distance driven since the start line (negative on the grid): laps = progress / length. */
  progress: number;
  laps: number;
  /** Race time at the finish, or null. */
  finished: number | null;
  place: number;
  /** Steering, -1 (left) .. 1 (right), smoothed. */
  steer: number;
  /** The wheel's angle (rad, + = clockwise), while seen. */
  wheel: number;
  held: boolean;
  holdS: number;
  lostS: number;
  bumpAt: number;
  shake: number;
  msg: { text: string; color: string; until: number } | null;
  lastSeen: number;
  group: THREE.Group;
  chassis: THREE.Group;
  wheels: THREE.Object3D[];
  fronts: THREE.Object3D[];
  steeringWheel: THREE.Object3D;
  cam: THREE.PerspectiveCamera;
  camPos: V3;
  camLook: V3;
  camReady: boolean;
}

function box(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** A blocky kart, facing +z (left is +x), with its driver. */
function buildKart(color: string) {
  const look = lookFor(color);
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  group.add(chassis);
  box(chassis, 1.3, 0.3, 2.2, look.body, 0, 0.42, 0);
  box(chassis, 0.9, 0.26, 0.5, look.body, 0, 0.4, 1.3);
  box(chassis, 1.4, 0.18, 0.2, darkMat, 0, 0.3, 1.55);
  for (const x of [-0.75, 0.75]) box(chassis, 0.3, 0.3, 1.0, look.body, x, 0.45, -0.1);
  box(chassis, 0.8, 0.55, 0.18, darkMat, 0, 0.82, -0.65);
  box(chassis, 1.6, 0.1, 0.45, look.body, 0, 1.2, -1.05);
  for (const x of [-0.5, 0.5]) box(chassis, 0.1, 0.5, 0.1, darkMat, x, 0.9, -1.0);
  box(chassis, 0.7, 0.3, 0.4, metalMat, 0, 0.7, -0.95);
  for (const x of [-0.25, 0.25]) box(chassis, 0.14, 0.14, 0.3, metalMat, x, 0.75, -1.25);
  box(chassis, 0.6, 0.5, 0.4, look.suit, 0, 0.85, -0.25);
  // Helmet faces: +x, -x, +y, -y, +z (front: the visor), -z.
  box(chassis, 0.55, 0.55, 0.55, [look.helmet, look.helmet, look.helmet, look.helmet, look.visor, look.helmet], 0, 1.38, -0.2);
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(0, 0.95, 0.22);
  steeringWheel.rotation.x = -0.5;
  box(steeringWheel, 0.42, 0.08, 0.06, darkMat, 0, 0.17, 0);
  box(steeringWheel, 0.42, 0.08, 0.06, darkMat, 0, -0.17, 0);
  box(steeringWheel, 0.08, 0.42, 0.06, darkMat, 0.17, 0, 0);
  box(steeringWheel, 0.08, 0.42, 0.06, darkMat, -0.17, 0, 0);
  chassis.add(steeringWheel);
  const wheels: THREE.Object3D[] = [];
  const fronts: THREE.Object3D[] = [];
  for (const z of [0.8, -0.8])
    for (const x of [-0.78, 0.78]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.32, z);
      group.add(pivot);
      wheels.push(box(pivot, 0.36, 0.62, 0.62, tyreMat, 0, 0, 0));
      if (z > 0) fronts.push(pivot);
    }
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 2.9), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.04;
  shadow.renderOrder = 1;
  group.add(shadow);
  scene.add(group);
  return { group, chassis, wheels, fronts, steeringWheel };
}

const karts = new Map<number, Kart>();
/** Slots in screen order, left to right. */
let order: number[] = [];

function makeKart(p: Player): Kart {
  return {
    slot: p.slot,
    id: p.id,
    color: p.color,
    s: mod(-GRID_BACK, track.L),
    d: 0,
    rel: 0,
    speed: 0,
    progress: -GRID_BACK,
    laps: 0,
    finished: null,
    place: 0,
    steer: 0,
    wheel: 0,
    held: false,
    holdS: 0,
    lostS: 0,
    bumpAt: 0,
    shake: 0,
    msg: null,
    lastSeen: performance.now(),
    ...buildKart(p.color),
    cam: new THREE.PerspectiveCamera(60, 1, 0.1, 600),
    camPos: v3(),
    camLook: v3(),
    camReady: false,
  };
}

function removeKart(k: Kart) {
  k.group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  k.group.removeFromParent();
  karts.delete(k.slot);
  order = order.filter((s) => s !== k.slot);
}

/** Line everyone up behind the start line, side by side in screen order. */
function toGrid() {
  const n = order.length;
  order.forEach((slot, i) => {
    const k = karts.get(slot)!;
    k.s = mod(-GRID_BACK, track.L);
    k.progress = -GRID_BACK;
    k.d = -(i - (n - 1) / 2) * GRID_GAP; // screen-left player on the left
    k.rel = 0;
    k.speed = 0;
    k.laps = 0;
    k.finished = null;
    k.place = 0;
    k.msg = null;
    k.camReady = false;
  });
}

// ---------- the wheel ----------

const camSpace = (p: Player) => p.raw ?? p;

/**
 * The steering wheel's angle (rad, + = turned clockwise, i.e. right), or null if their hands
 * aren't on one: both wrists in front of the body, between the hips and just above the
 * shoulders, roughly a wheel's width apart.
 */
function readWheel(p: Player): number | null {
  if (p.pose.handsUp) return null;
  const k = camSpace(p).keypoints;
  const A = game.frame.aspect;
  const ok = (i: number) => k[i].score >= MIN_SCORE;
  if (![KP.leftWrist, KP.rightWrist, KP.leftShoulder, KP.rightShoulder].every(ok)) return null;
  const lw = k[KP.leftWrist];
  const rw = k[KP.rightWrist];
  const sx = (k[KP.leftShoulder].x + k[KP.rightShoulder].x) / 2;
  const sy = (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2;
  const sw = Math.hypot((k[KP.rightShoulder].x - k[KP.leftShoulder].x) * A, k[KP.rightShoulder].y - k[KP.leftShoulder].y);
  if (sw < 0.02) return null;
  const dx = (rw.x - lw.x) * A;
  const dy = rw.y - lw.y;
  const span = Math.hypot(dx, dy);
  if (span < 0.35 * sw || span > 3.2 * sw) return null;
  const angle = Math.atan2(dy, dx);
  if (Math.abs(angle) > 1.75) return null; // hands crossed over
  // Each hand lifted clear of the hips (arms hanging down don't count), neither overhead,
  // and both in front of the body. Heights in torso lengths.
  const hipY = ok(KP.leftHip) && ok(KP.rightHip) ? (k[KP.leftHip].y + k[KP.rightHip].y) / 2 : sy + sw * 1.4;
  const torso = Math.max(hipY - sy, sw * 0.5);
  for (const w of [lw, rw]) {
    if (w.y > hipY - torso * 0.15 || w.y < sy - torso * 0.6) return null;
    if (Math.abs((w.x - sx) * A) > sw * 1.4) return null;
  }
  return angle;
}

function updateWheel(k: Kart, p: Player, dt: number) {
  const a = readWheel(p);
  if (a !== null) {
    k.wheel = a;
    k.lostS = 0;
    k.holdS += dt;
    if (k.holdS >= GRAB_S) k.held = true;
  } else {
    k.lostS += dt;
    if (k.lostS >= LET_GO_S) {
      k.held = false;
      k.holdS = 0;
    }
  }
}

const wheelSteer = (a: number) => Math.sign(a) * clamp((Math.abs(a) - STEER_DEAD) / (STEER_FULL - STEER_DEAD), 0, 1);

// ---------- driving ----------

const yawGain = (speed: number) => TURN * (0.4 + (0.6 * speed) / MAX_SPEED);

/** Steering that follows the curve and heads for the middle of the road. */
function autopilot(k: Kart, tp: TrackPoint): number {
  const ff = (-tp.k * Math.max(k.speed, 1)) / yawGain(Math.max(k.speed, 1));
  return clamp(ff + (k.rel + k.d * 0.1) * 2, -1, 1);
}

function message(k: Kart, text: string, color = '#ffffff', ms = 1800) {
  k.msg = { text, color, until: performance.now() + ms };
}

let finishedCount = 0;
let firstFinishAt: number | null = null;

function drive(k: Kart, dt: number, now: number) {
  const tp = track.at(k.s);
  const racing = flow.playing;
  const lobby = flow.state === 'lobby';
  const results = flow.state === 'results';
  // In the lobby you can practise while you hold the wheel; after the finish, everyone cruises.
  const auto = (racing && (!k.held || k.finished !== null)) || results;
  let want = 0;
  if (racing) want = k.finished !== null ? CRUISE : k.held ? MAX_SPEED : CRAWL;
  else if (lobby && k.held) want = MAX_SPEED * 0.6;
  else if (results) want = CRUISE;
  k.speed += clamp(want - k.speed, -ACCEL * 2 * dt, ACCEL * dt);

  const steerWant = auto ? autopilot(k, tp) : k.held ? wheelSteer(k.wheel) : 0;
  k.steer += (steerWant - k.steer) * Math.min(1, dt * 10);
  if (k.speed < 0.05) return;

  const yawRate = -k.steer * yawGain(k.speed);
  const ds = (k.speed * Math.cos(k.rel) * dt) / Math.max(0.3, 1 - tp.k * k.d);
  k.rel += yawRate * dt - tp.k * ds;
  if (!auto) k.rel -= k.rel * ASSIST * dt;
  k.rel = clamp(k.rel, -MAX_REL, MAX_REL);
  k.d += k.speed * Math.sin(k.rel) * dt;
  k.s = mod(k.s + ds, track.L);
  k.progress += ds;

  // Walls: slide along them, losing speed for a hard hit.
  const limit = track.half - KART_W / 2 - 0.05;
  if (Math.abs(k.d) > limit) {
    const side = Math.sign(k.d);
    k.d = side * limit;
    k.speed -= k.speed * WALL_DRAG * dt;
    const into = Math.sin(k.rel) * side;
    if (into > 0) {
      const hit = k.speed * into;
      k.rel = k.rel * 0.2 - side * 0.05;
      k.speed *= 1 - Math.min(0.45, hit * 0.03);
      if (hit > 3 && now - k.bumpAt > 300) {
        k.bumpAt = now;
        k.shake = Math.min(1, hit / 10);
        sfxWall();
      }
    }
  }

  // Laps.
  if (racing && k.finished === null) {
    const laps = Math.max(0, Math.floor(k.progress / track.L));
    if (laps > k.laps) {
      k.laps = laps;
      flow.addScore(k.slot, 1);
      if (laps >= LAPS) finish(k, now);
      else if (laps === LAPS - 1) {
        message(k, 'Final lap!', '#ffd51a');
        sfxFinalLap();
        say('Final lap!');
      } else {
        message(k, `Lap ${laps + 1}`);
        sfxLap();
      }
    }
  }
}

function finish(k: Kart, now: number) {
  k.finished = flow.elapsed;
  k.place = ++finishedCount;
  // Laps, plus a bonus by place: higher always means a better race.
  flow.addScore(k.slot, Math.max(1, karts.size - k.place + 1));
  message(k, k.place === 1 ? 'You win!' : `${placeName(k.place)}!`, k.place === 1 ? '#ffd51a' : '#ffffff', 99999);
  sfxFinish();
  if (k.place === 1) {
    firstFinishAt = now;
    say(`${playerName(k.slot)} wins!`, { interrupt: true });
  }
}

/** Karts that run into each other get pushed apart sideways; the one behind loses a little speed. */
function bumpKarts(now: number) {
  const ks = [...karts.values()];
  const L = track.L;
  for (let i = 0; i < ks.length; i++)
    for (let j = i + 1; j < ks.length; j++) {
      const a = ks[i];
      const b = ks[j];
      const ds = mod(a.s - b.s + L / 2, L) - L / 2;
      const dd = a.d - b.d;
      if (Math.abs(ds) >= KART_L || Math.abs(dd) >= KART_W) continue;
      const push = (KART_W - Math.abs(dd)) / 2 + 0.02;
      const side = dd === 0 ? (a.slot < b.slot ? 1 : -1) : Math.sign(dd);
      a.d += side * push;
      b.d -= side * push;
      const behind = ds < 0 ? a : b;
      behind.speed *= 0.97;
      if (now - a.bumpAt > 400 && now - b.bumpAt > 400 && (a.speed > 5 || b.speed > 5)) {
        a.bumpAt = b.bumpAt = now;
        a.shake = b.shake = 0.4;
        sfxBump();
      }
    }
}

/** Places: finished karts by finishing order, then everyone else by distance. */
function rank() {
  const ks = [...karts.values()].sort((a, b) => {
    if (a.finished !== null || b.finished !== null) {
      if (a.finished === null) return 1;
      if (b.finished === null) return -1;
      return a.place - b.place;
    }
    return b.progress - a.progress;
  });
  ks.forEach((k, i) => {
    if (k.finished === null) k.place = i + 1;
  });
  return ks;
}

// ---------- placing karts and cameras ----------

const basis = new THREE.Matrix4();
function poseKart(k: Kart, dt: number) {
  const tp = track.at(k.s);
  const fwd = tp.f.clone().multiplyScalar(Math.cos(k.rel)).addScaledVector(tp.l, Math.sin(k.rel)).normalize();
  const left = tp.up.clone().cross(fwd).normalize();
  k.group.position.copy(tp.p).addScaledVector(tp.l, k.d);
  basis.makeBasis(left, tp.up, fwd);
  k.group.quaternion.setFromRotationMatrix(basis);
  k.shake *= Math.exp(-dt * 5);
  const t = performance.now();
  k.chassis.position.y = Math.sin(t / 37) * 0.02 * Math.min(1, k.speed / 10) + Math.sin(t / 25) * 0.08 * k.shake;
  k.chassis.rotation.z = k.steer * 0.06 * Math.min(1, k.speed / MAX_SPEED);
  for (const w of k.wheels) w.rotation.x += (k.speed / 0.31) * dt;
  for (const f of k.fronts) f.rotation.y = -k.steer * 0.45;
  k.steeringWheel.rotation.z = (k.held ? k.wheel : k.steer * 0.6) * 0.9;
}

const CAM_BACK = 4.2;
const CAM_UP = 2;
function placeCamera(k: Kart, dt: number) {
  const tp = track.at(k.s);
  // Behind the kart, mostly following the road so it doesn't swing about with every wiggle.
  const rel = k.rel * 0.5;
  const dir = tp.f.clone().multiplyScalar(Math.cos(rel)).addScaledVector(tp.l, Math.sin(rel)).normalize();
  const base = k.group.position;
  const want = base.clone().addScaledVector(dir, -CAM_BACK).addScaledVector(tp.up, CAM_UP);
  const look = base.clone().addScaledVector(dir, 5).addScaledVector(tp.up, 1.1);
  if (!k.camReady) {
    k.camPos.copy(want);
    k.camLook.copy(look);
    k.camReady = true;
  }
  k.camPos.lerp(want, Math.min(1, dt * 6));
  k.camLook.lerp(look, Math.min(1, dt * 8));
  k.cam.position.copy(k.camPos);
  if (k.shake > 0.05) k.cam.position.y += Math.sin(performance.now() / 20) * 0.12 * k.shake;
  k.cam.up.copy(tp.up);
  k.cam.lookAt(k.camLook);
}

/** With nobody in view: a slow orbit round the whole track. */
const overview = new THREE.PerspectiveCamera(50, 16 / 9, 1, 1000);
function placeOverview(now: number) {
  const a = now / 9000;
  overview.position.set(Math.sin(a) * 150, 90, Math.cos(a) * 150);
  overview.lookAt(0, -5, 0);
}

/** Vertical field of view for a slice this shape, so narrow slices still see the road. */
const fovFor = (aspect: number) => clamp((2 * Math.atan(Math.tan((70 * Math.PI) / 360) / aspect) * 180) / Math.PI, 55, 80);

// ---------- players ----------

function syncKarts(now: number, dt: number) {
  const players = game.frame.players;
  let joined = false;
  for (const p of players) {
    let k = karts.get(p.slot);
    if (!k) {
      // Join on the grid (also mid-race: you start from the back).
      k = makeKart(p);
      karts.set(p.slot, k);
      joined = true;
    }
    if (k.id !== p.id) {
      k.id = p.id;
      k.held = false;
      k.holdS = 0;
    }
    k.lastSeen = now;
    updateWheel(k, p, dt);
  }
  for (const k of [...karts.values()]) if (now - k.lastSeen > 2500) removeKart(k);
  // Screen order follows where people stand, except mid-race (then a newcomer slots in where they stand).
  const xOf = (s: number) => {
    const p = players.find((q) => q.slot === s);
    return p ? camSpace(p).center.x : 0.5;
  };
  const inRace = flow.state === 'playing' || flow.state === 'countdown';
  if (!inRace) {
    order = [...karts.keys()].sort((a, b) => xOf(a) - xOf(b));
    if (joined && flow.state === 'lobby') toGrid();
  } else
    for (const s of karts.keys()) {
      if (order.includes(s)) continue;
      const i = order.findIndex((o) => xOf(o) > xOf(s));
      if (i < 0) order.push(s);
      else order.splice(i, 0, s);
    }
}

// ---------- the track picker (the lobby) ----------

const picker = new DwellMenu(
  tracks.map((t, i) => ({ id: t.def.id, label: t.def.name, x: 0.2 + i * 0.3, y: 0.55, w: 0.26, h: 0.38, color: t.def.card, image: t.thumb })),
);
let hovered: string | null = null;

function updatePicker(now: number) {
  if (flow.state !== 'lobby' || !game.frame.players.length) {
    hovered = null;
    return;
  }
  const free = game.frame.players.filter((p) => readWheel(p) === null && !karts.get(p.slot)?.held);
  const picked = picker.update(free, now);
  const over = picker.hovering();
  if (over !== hovered) {
    hovered = over;
    // Show the track under a hand.
    const t = tracks.find((o) => o.def.id === over);
    if (t && t !== track) {
      setTrack(t);
      sfx('hover', () => blip(880, 40, 'square', 0.05), { volume: 0.6 });
    }
  }
  if (picked) {
    setTrack(tracks.find((o) => o.def.id === picked) ?? track);
    sfx('select', () => blip(1047, 120, 'square', 0.1));
    flow.start();
  }
}

// ---------- the podium ----------

const podium = new Podium(scene, v3(0, 60, 0), () => game.frame.aspect);
let podiumOrder: { slot: number; color: string; place: number; time: number | null }[] = [];

function showPodium() {
  const ranked = rank();
  podiumOrder = ranked.map((k, i) => ({ slot: k.slot, color: k.color, place: i + 1, time: k.finished }));
  podium.show(ranked.map((k, i) => ({ slot: k.slot, id: k.id, color: k.color, place: i + 1 })));
  sfx('cheer', () => {}, { volume: 0.8 });
}

// ---------- round ----------

prepareSpeech(['Rainbow Kart! Hold the wheel and go!', 'Final lap!', 'Go!', ...[0, 1, 2, 3].map((s) => `${playerName(s)} wins!`)]);

let countdownAt = 0;
let lastBeep = 0;
let prevState = flow.state;

flow.on('start', () => {
  finishedCount = 0;
  firstFinishAt = null;
  for (const k of karts.values()) {
    k.laps = 0;
    k.finished = null;
    k.progress = Math.min(k.progress, 0);
  }
  sfx('go', () => blip(880, 400, 'square', 0.14));
  say('Go!', { interrupt: true });
});
flow.on('end', () => showPodium());

function updateRound(now: number) {
  if (flow.state !== prevState) {
    if (prevState === 'results') {
      podium.hide();
      toGrid();
    }
    if (flow.state === 'countdown') {
      toGrid();
      countdownAt = now;
      lastBeep = 0;
      say(`${track.def.name}! Hold the wheel and go!`);
    }
    prevState = flow.state;
  }
  if (flow.state === 'countdown') {
    const n = Math.ceil(3 - (now - countdownAt) / 1000);
    if (n !== lastBeep && n > 0) {
      lastBeep = n;
      sfx('countdown', () => blip(440, 160, 'square', 0.12));
    }
  }
  if (flow.playing) {
    const all = karts.size > 0 && [...karts.values()].every((k) => k.finished !== null);
    if (all || (firstFinishAt !== null && now - firstFinishAt > FINISH_WAIT_S * 1000)) flow.end();
  }
}

// ---------- HUD ----------

let W = 1;
let H = 1;

function drawWheelIcon(x: number, y: number, r: number, angle: number, color: string, held: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = held ? 1 : 0.55;
  ctx.strokeStyle = '#1b1030';
  ctx.lineWidth = r * 0.42;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = held ? color : '#9a94b0';
  ctx.lineWidth = r * 0.26;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  for (const a of [Math.PI / 2, Math.PI * 1.18, -Math.PI * 0.18]) {
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(-r * 0.12, -r * 1.15, r * 0.24, r * 0.3); // top marker, so the turn reads
  ctx.restore();
}

function toScreen(p: V3, cam: THREE.Camera) {
  const q = p.clone().project(cam);
  return { x: (q.x + 1) * 0.5 * W, y: (1 - q.y) * 0.5 * H };
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function drawPodiumHud() {
  const winner = podiumOrder[0];
  drawText(ctx, winner ? `${playerName(winner.slot)} wins!` : 'Race over!', W / 2, H * 0.08, Math.min(H / 11, W / 12), winner?.color ?? '#ffd51a');
  for (const e of podiumOrder) {
    const top = toScreen(podium.topOf(e.place, 0.45), podium.camera);
    drawText(ctx, placeName(e.place), top.x, top.y, H / 16, e.color);
    if (e.time !== null) {
      const foot = toScreen(podium.footOf(e.place), podium.camera);
      drawText(ctx, fmtTime(e.time), foot.x, foot.y, H / 26, '#ffffff');
    }
  }
}

function drawPickerHud(now: number) {
  drawText(ctx, 'Rainbow Kart', W / 2, H * 0.12, Math.min(H / 9, W / 10), '#ffd51a');
  if (!game.frame.players.length) {
    drawText(ctx, 'Step in to play!', W / 2, H * 0.3, H / 15);
    return;
  }
  drawText(ctx, 'Hold your hand on a track to race it!', W / 2, H * 0.25, Math.min(H / 20, W / 30));
  picker.draw(ctx, W, H);
  if (Math.floor(now / 2000) % 2) drawText(ctx, 'Or grab the wheel to practise', W / 2, H * 0.8, Math.min(H / 26, W / 40), '#ffffff');
  else drawText(ctx, `or raise both hands to race ${track.def.name}`, W / 2, H * 0.8, Math.min(H / 26, W / 40), '#ffffff');
}

function drawHud(now: number) {
  if (flow.state === 'results') return drawPodiumHud();
  const n = order.length;
  order.forEach((slot, i) => {
    const k = karts.get(slot)!;
    const x0 = (W * i) / n;
    const cw = W / n;
    const cx = x0 + cw / 2;
    const size = Math.min(cw / 7, H / 12);
    if (flow.state === 'playing') {
      const top = 104 + size * 0.7; // under the score chips
      drawText(ctx, placeName(k.place), x0 + size * 0.4, top, size * 1.3, k.color, { align: 'left' });
      const lap = Math.min(LAPS, k.laps + 1);
      drawText(ctx, k.finished !== null ? 'Done!' : `Lap ${lap}/${LAPS}`, x0 + cw - size * 0.4, top, size * 0.7, '#ffffff', { align: 'right' });
    }
    if (k.msg && now < k.msg.until) {
      const age = 1 - (k.msg.until - now) / 1800;
      const pulse = 1 + Math.max(0, 0.25 - age) * 1.5;
      drawText(ctx, k.msg.text, cx, H * 0.38, size * 1.1 * pulse, k.msg.color);
    } else k.msg = null;
    // Their wheel, as the camera sees it.
    const r = Math.min(cw * 0.12, H * 0.07);
    drawWheelIcon(cx, H - r * 1.9, r, k.held ? k.wheel : 0, k.color, k.held);
    if (!k.held && flow.state === 'playing' && k.finished === null && Math.floor(now / 500) % 2) {
      drawText(ctx, 'Hold the wheel!', cx, H - r * 3.6, Math.min(size * 0.6, cw / 11), '#ffffff');
    }
  });
  // Dividers between the slices.
  ctx.fillStyle = '#05030f';
  for (let i = 1; i < n; i++) ctx.fillRect((W * i) / n - 3, 0, 6, H);
  if (flow.state === 'lobby') drawPickerHud(now);
}

// ---------- main loop ----------

setTrack(track);
let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = stage.resize());
  if (renderer.getPixelRatio() !== PIXEL_RATIO) renderer.setPixelRatio(PIXEL_RATIO);
  fitCanvas(hud, ctx);
  flow.update(now);
  syncKarts(now, dt);
  updatePicker(now);
  updateRound(now);

  if (!game.paused) {
    for (const k of karts.values()) drive(k, dt, now);
    bumpKarts(now);
  }
  rank();
  for (const k of karts.values()) poseKart(k, dt);
  updateEngine(now);

  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, W, H);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();
  const n = order.length;
  if (flow.state === 'results' && podium.visible) {
    // Cut-outs are only asked for while the podium is up.
    podium.update(dt, now, game.frame.players, game.segmentation(), W / H);
    renderer.render(scene, podium.camera);
  } else if (!n) {
    placeOverview(now);
    overview.aspect = W / H;
    overview.updateProjectionMatrix();
    renderer.render(scene, overview);
  } else
    order.forEach((slot, i) => {
      const k = karts.get(slot)!;
      const x = Math.round((W * i) / n);
      const w = Math.round((W * (i + 1)) / n) - x;
      placeCamera(k, dt);
      k.cam.aspect = w / H;
      k.cam.fov = fovFor(k.cam.aspect);
      k.cam.updateProjectionMatrix();
      renderer.setViewport(x, 0, w, H);
      renderer.setScissor(x, 0, w, H);
      renderer.render(scene, k.cam);
    });
  renderer.setScissorTest(false);

  ctx.clearRect(0, 0, W, H);
  drawHud(now);
  flow.drawOverlay(ctx, W, H);
  requestAnimationFrame(loop);
}

// Read-only peek for automated tests and debugging.
(window as unknown as { kart: () => object }).kart = () => ({
  state: flow.state,
  track: track.def.id,
  elapsed: +flow.elapsed.toFixed(2),
  scores: flow.scores,
  lapLength: +track.L.toFixed(1),
  order,
  hovered,
  podium: podium.visible ? podiumOrder : null,
  sounds: Object.keys(sounds),
  karts: [...karts.values()].map((k) => ({
    slot: k.slot,
    s: +k.s.toFixed(1),
    d: +k.d.toFixed(2),
    rel: +k.rel.toFixed(2),
    speed: +k.speed.toFixed(1),
    progress: +k.progress.toFixed(1),
    laps: k.laps,
    place: k.place,
    finished: k.finished,
    held: k.held,
    wheel: +k.wheel.toFixed(2),
    steer: +k.steer.toFixed(2),
    y: +k.group.position.y.toFixed(2),
  })),
  size: [W, H],
});

requestAnimationFrame(loop);
