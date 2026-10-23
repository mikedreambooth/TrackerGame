/**
 * Archery: a 3D range that runs away into the screen. Up to three archers stand side by side
 * at the near end, seen from behind, each drawn as glowing lines in their own colour with a
 * line-drawn bow. Targets stand down range at 10–50 m. Bullseye boards score by ring
 * (10/8/6/4/3, straw rim 1). Balloons float up (3). After 15 s a golden board slides across
 * (double points). Rounds last 60 s.
 *
 * The tracker is 2D, so the aim comes from 2D cues:
 *  - Aim: where the LEFT (bow) hand is compared with your head. Left or right of your nose
 *    aims left or right (with a dead zone in the middle). Higher aims higher, and so further.
 *  - Draw: bring your RIGHT hand back to your chin or shoulder while the bow arm is up. Power
 *    builds the longer you hold it (full in 1.2 s). A dotted arc shows where the arrow will go.
 *  - Release: drop the right hand sharply (fires at once), or pull it away from your chin in
 *    any direction at any speed (the tracker sees wrists, not fingers, so there's no
 *    "opening the hand"). The arrow flies with the
 *    aim and power it had at the chin, along exactly the arc you saw. Dropping the bow arm
 *    while still at the chin puts the bow down without shooting.
 *
 * Artwork: art/generate.py (Gemini) -> public/art (target face, balloon, backdrop).
 */
import {
  KP,
  RoundFlow,
  blip,
  createGame,
  drawSkeleton,
  drawText,
  fitCanvas,
  loadAssets,
  noise,
  prepareSpeech,
  say,
  theme,
  type Player,
} from '@trackergame/sdk';
import * as THREE from '@trackergame/sdk/three';
import { createStage3D, textureFrom } from '@trackergame/sdk/three';

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

const MAX_ARCHERS = 3;
const LANE_GAP = 2.2;
const G = 9.8;
/** Arrow speed at full power, m/s (slower than a real bow, so you can watch it fly). */
const V_MAX = 38;
const speedFor = (power: number) => V_MAX * (0.4 + 0.6 * power);
/** Seconds of holding the draw to reach full power. */
const CHARGE_S = 1.2;
const MIN_POWER = 0.2;
/**
 * Draw-hand distance from the anchor, in body sizes: inside IN = drawing, beyond LEAVE = shoot.
 * The tracker sees wrists, not fingers, and a real release goes back past the ear (towards the
 * camera's depth, which it can't see) — so any clear move away from the chin fires, at any speed.
 */
const ANCHOR_IN = 1.2;
const ANCHOR_LEAVE = 1.5;
/** A sharp drop of the draw hand (body sizes per second, downwards) fires at once, even inside the anchor. */
const DROP_SPEED = 2.5;
const RELOAD_MS = 400;
/** Wrist dropouts shorter than this are ignored. */
const LOST_MS = 250;
const MIN_SCORE = 0.3;
const YAW_MAX = 30 * DEG;
const YAW_DEAD = 0.25;
const ARROW_LEN = 0.9;
// Target artwork: outer edge of each ring as a fraction of the picture's half-width (measured; the
// gold is a little generous): gold, blue, red, black, white; the straw rim ends at 0.945.
const RINGS = [0.2, 0.29, 0.51, 0.66, 0.77];
const RING_POINTS = [10, 8, 6, 4, 3, 1];
const FACE_EDGE = 0.945;

// ---------- setup ----------

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;
const ctx = hud.getContext('2d')!;
const game = await createGame({ people: false }); // players are avatars here, not camera cut-outs
const assets = await loadAssets({
  images: { background: 'art/background.jpg', target: 'art/target.png', balloon: 'art/balloon.png' },
});
const flow = new RoundFlow(game, {
  title: 'Archery',
  subtitle: 'Bow hand up in front, right hand back to your chin, then drop it to shoot! Raise both hands to start.',
  seconds: 60,
});

const stage = createStage3D(glCanvas, { fov: 42, background: '#9fd3ff' });
const { scene, camera, renderer } = stage;
const CAM_POS = v3(-1.1, 3.0, 6.0);
camera.position.copy(CAM_POS);
const LOOK_AT = v3(0.3, 1.1, -25);
camera.lookAt(LOOK_AT);
const hitCamera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 400);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3f6b2f, 1.3));
const sun = new THREE.DirectionalLight(0xfff1d0, 1.6);
sun.position.set(6, 12, 5);
scene.add(sun);

/** The colour where the backdrop meets the grass, so the fog blends the two. */
function horizonColour(): THREE.Color {
  const img = assets.images.background;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.drawImage(img, img.width * 0.3, img.height * 0.5, img.width * 0.4, img.height * 0.04, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    gg += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  return new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
}
scene.fog = new THREE.Fog(horizonColour(), 45, 165);

// Far backdrop: the Gemini meadow, its horizon at eye height.
{
  const img = assets.images.background;
  const w = 380;
  const h = (w * img.height) / img.width;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: textureFrom(img), fog: false }));
  m.position.set(0, CAM_POS.y + 0.5 - (0.5 - 0.49) * h, -165);
  scene.add(m);
}

// Mown grass: stripes running down range.
{
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6fbf4a';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#5eae3d';
  g.fillRect(64, 0, 64, 128);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(40,90,20,0.18)' : 'rgba(200,240,140,0.15)';
    g.fillRect(Math.random() * 128, Math.random() * 128, 1, 3);
  }
  const tex = textureFrom(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(300 / 8, 180 / 8);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 180), new THREE.MeshLambertMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, 15 - 90);
  scene.add(ground);
}

/** A sprite with text on it (distance markers). */
function label(text: string, height: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.roundRect(8, 8, 240, 112, 30);
  g.fill();
  g.font = `900 72px ${theme.font}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#2d6a4f';
  g.fillText(text, 128, 68);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: textureFrom(c) }));
  s.scale.set(height * 2, height, 1);
  return s;
}

// Distance lines every 10 m, with markers on both sides.
const halfWidthAt = (z: number) => 3 + Math.abs(z) * 0.32;
for (let d = 10; d <= 50; d += 10) {
  const w = halfWidthAt(-d) * 2 + 4;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
  line.rotation.x = -Math.PI / 2;
  line.position.set(0, 0.02, -d);
  scene.add(line);
  for (const side of [-1, 1]) {
    const s = label(`${d} m`, 0.5 + d * 0.012);
    s.position.set(side * (w / 2 + 0.6), 0.6 + d * 0.01, -d);
    scene.add(s);
  }
}

// ---------- line-drawn things: tubes with a bright core and a soft glow ----------

const UP = v3(0, 1, 0);
const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
interface Ink {
  core: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
  color: THREE.Color;
}
const inks = new Map<string, Ink>();
function ink(color: string): Ink {
  let k = inks.get(color);
  if (!k) {
    const c = new THREE.Color(color);
    k = {
      color: c,
      core: new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.45) }),
      glow: new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, depthWrite: false }),
    };
    inks.set(color, k);
  }
  return k;
}

/** A straight stroke from a to b, `r` thick, that can be moved later with setStroke(). */
function stroke(k: Ink, r: number): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(unitCyl, k.core);
  core.scale.set(r, 1, r);
  const glow = new THREE.Mesh(unitCyl, k.glow);
  glow.scale.set(r * 2.4, 1, r * 2.4);
  g.add(core, glow);
  return g;
}
const tmp = v3();
function setStroke(g: THREE.Object3D, a: V3, b: V3) {
  tmp.subVectors(b, a);
  const len = tmp.length() || 1e-4;
  g.position.copy(a).addScaledVector(tmp, 0.5);
  g.quaternion.setFromUnitVectors(UP, tmp.divideScalar(len));
  g.scale.set(1, len, 1);
}
function strokeAB(k: Ink, r: number, a: V3, b: V3) {
  const s = stroke(k, r);
  setStroke(s, a, b);
  return s;
}
function curveStroke(k: Ink, r: number, pts: V3[]): THREE.Group {
  const g = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(pts);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, r, 8), k.core), new THREE.Mesh(new THREE.TubeGeometry(curve, 40, r * 2.4, 8), k.glow));
  return g;
}

/** An arrow pointing down its local -z, tail at the origin: shaft, line-drawn head and fletching. */
function makeArrow(k: Ink): THREE.Group {
  const g = new THREE.Group();
  const r = 0.014;
  const tip = v3(0, 0, -ARROW_LEN);
  g.add(strokeAB(k, r, v3(0, 0, 0), tip));
  for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    g.add(strokeAB(k, r, tip, v3(x * 0.055, y * 0.055, -ARROW_LEN + 0.11)));
    // Fletching: two little chevrons at the back.
    g.add(strokeAB(k, r * 0.8, v3(0, 0, -0.2), v3(x * 0.07, y * 0.07, -0.08)));
    g.add(strokeAB(k, r * 0.8, v3(0, 0, -0.1), v3(x * 0.07, y * 0.07, 0.02)));
  }
  return g;
}

// Bow, in its own frame: grip at the origin, aiming down -z, limbs up and down, tips curling forward.
const BOW_HALF = 0.75;
const bowZ = (u: number) => 0.26 * u * u - 0.1 * Math.max(0, (Math.abs(u) - 0.7) / 0.3) ** 2;
const BOW_TIP_Z = bowZ(1);

interface Figure {
  root: THREE.Group;
  bow: THREE.Group;
  string: THREE.Line;
  nocked: THREE.Group;
  leftArm: THREE.Group[];
  rightArm: THREE.Group[];
}

function makeFigure(color: string): Figure {
  const k = ink(color);
  const root = new THREE.Group();
  const r = 0.03;
  // Body: legs, hips, spine, shoulders, head, seen from behind.
  const hipL = v3(-0.14, 0.95, 0), hipR = v3(0.14, 0.95, 0), neck = v3(0, 1.48, 0);
  root.add(strokeAB(k, r, v3(-0.2, 0, 0.05), hipL), strokeAB(k, r, v3(0.2, 0, 0.05), hipR), strokeAB(k, r, hipL, hipR));
  root.add(strokeAB(k, r, v3(0, 0.95, 0), neck), strokeAB(k, r, v3(-0.22, 1.42, 0), v3(0.22, 1.42, 0)));
  const head = new THREE.Mesh(new THREE.TorusGeometry(0.14, r, 8, 32), k.core);
  head.position.set(0, 1.68, 0);
  const headGlow = new THREE.Mesh(new THREE.TorusGeometry(0.14, r * 2.4, 8, 32), k.glow);
  head.add(headGlow);
  root.add(head);
  const leftArm = [stroke(k, r), stroke(k, r)];
  const rightArm = [stroke(k, r), stroke(k, r)];
  root.add(...leftArm, ...rightArm);

  const bow = new THREE.Group();
  const pts: V3[] = [];
  for (let i = 0; i <= 16; i++) {
    const u = -1 + i / 8;
    pts.push(v3(0, u * BOW_HALF, bowZ(u)));
  }
  bow.add(curveStroke(k, 0.022, pts));
  const sg = new THREE.BufferGeometry().setFromPoints([v3(0, BOW_HALF, BOW_TIP_Z), v3(0, 0, BOW_TIP_Z), v3(0, -BOW_HALF, BOW_TIP_Z)]);
  const string = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: k.core.color }));
  bow.add(string);
  const nocked = makeArrow(k);
  bow.add(nocked);
  root.add(bow);
  scene.add(root);
  return { root, bow, string, nocked, leftArm, rightArm };
}

// ---------- archers: 2D cues -> aim, draw, release ----------

interface Aim {
  yaw: number;
  pitch: number;
}

interface Archer {
  id: number;
  slot: number;
  color: string;
  fig: Figure;
  lane: number;
  aim: Aim;
  drawing: boolean;
  power: number;
  raised: boolean;
  anchorDist: number;
  lastAnchoredAt: number;
  /** Aim and power at the last moment the hand was at the anchor: what a release fires. */
  snap: { aim: Aim; power: number } | null;
  lastSeen: number;
  readyAt: number;
  firedAt: number;
  /** Last draw-hand height and time, and the measured drop speed (body sizes/s, down +). */
  lastHand: { y: number; t: number } | null;
  drop: number;
}

const archers = new Map<number, Archer>();

interface Cues {
  raised: boolean;
  anchorDist: number;
  /** Draw hand's height, in body sizes (down = bigger), for measuring how fast it drops. */
  handY: number;
  aim: Aim;
}

function readCues(p: Player): Cues | null {
  const k = p.keypoints;
  const A = game.frame.aspect;
  const need = [KP.leftWrist, KP.rightWrist, KP.leftShoulder, KP.rightShoulder];
  if (need.some((i) => k[i].score < MIN_SCORE)) return null;
  // Work in units that are the same size across and down.
  const P = (i: number) => ({ x: k[i].x * A, y: k[i].y });
  const ls = P(KP.leftShoulder), rs = P(KP.rightShoulder), lw = P(KP.leftWrist), rw = P(KP.rightWrist);
  const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipsOk = k[KP.leftHip].score >= MIN_SCORE && k[KP.rightHip].score >= MIN_SCORE;
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const torso = hipsOk ? Math.hypot(mid.x - (P(KP.leftHip).x + P(KP.rightHip).x) / 2, mid.y - (P(KP.leftHip).y + P(KP.rightHip).y) / 2) : sw * 1.3;
  // Body size: shoulders shrink when you turn side-on, the torso doesn't.
  const s = Math.max(sw, torso * 0.8, 0.03);
  const head = k[KP.nose].score >= MIN_SCORE ? P(KP.nose) : { x: mid.x, y: mid.y - 0.6 * s };
  const raised = lw.y < mid.y + 0.45 * torso;
  // Anchor: between the chin and the right shoulder (screen right, as in a mirror).
  const anchor = { x: head.x + 0.3 * s, y: head.y + 0.5 * s };
  const anchorDist = Math.hypot(rw.x - anchor.x, rw.y - anchor.y) / s;
  // Aim from the bow hand: across from just left of the nose, up from the shoulder line.
  const dx = (lw.x - (head.x - 0.2 * s)) / s;
  const dy = (mid.y - lw.y) / s;
  const yaw = Math.sign(dx) * Math.min(YAW_MAX, (Math.max(0, Math.abs(dx) - YAW_DEAD) / 1.3) * YAW_MAX);
  const pitch = Math.min(35, Math.max(-3, 2 + dy * 9)) * DEG;
  return { raised, anchorDist, handY: rw.y / s, aim: { yaw, pitch } };
}

function laneX(a: Archer, n: number) {
  return (a.lane - (n - 1) / 2) * LANE_GAP;
}

const dirOf = (aim: Aim) => v3(Math.cos(aim.pitch) * Math.sin(aim.yaw), Math.sin(aim.pitch), -Math.cos(aim.pitch) * Math.cos(aim.yaw));
/** Bow grip in the world: the left arm stretched out along the aim. */
function gripOf(a: Archer, n: number, aim: Aim): V3 {
  return v3(laneX(a, n) - 0.2, 1.42, 0).addScaledVector(dirOf(aim), 0.62);
}

function updateArchers(now: number, dt: number) {
  const players = game.frame.players.filter((p) => p.slot < MAX_ARCHERS).sort((a, b) => a.center.x - b.center.x);
  const seen = new Set<number>();
  players.forEach((p, lane) => {
    seen.add(p.id);
    let a = archers.get(p.id);
    if (!a) {
      a = { id: p.id, slot: p.slot, color: p.color, fig: makeFigure(p.color), lane, aim: { yaw: 0, pitch: 5 * DEG }, drawing: false, power: 0, raised: false, anchorDist: 9, lastAnchoredAt: -1e9, snap: null, lastSeen: now, readyAt: now, firedAt: -1e9, lastHand: null, drop: 0 };
      archers.set(p.id, a);
    }
    a.lane = lane;
    const c = readCues(p);
    if (!c) {
      if (now - a.lastSeen > LOST_MS) {
        a.drawing = false;
        a.power = 0;
        a.raised = false;
      }
      return;
    }
    a.lastSeen = now;
    // Drop speed from the raw positions (the tracker's own velocity is smoothed, so it lags a flick).
    // (Only on a new tracking frame: the screen redraws faster than the camera.)
    if (!a.lastHand) a.lastHand = { y: c.handY, t: now };
    else if (c.handY !== a.lastHand.y && now > a.lastHand.t) {
      const v = (c.handY - a.lastHand.y) / ((now - a.lastHand.t) / 1000);
      a.drop += (v - a.drop) * 0.6;
      a.lastHand = { y: c.handY, t: now };
    } else if (now - a.lastHand.t > 150) a.drop *= 0.5; // hand still: let the speed settle
    a.raised = c.raised;
    a.anchorDist = c.anchorDist;
    // Smooth the aim.
    const f = 1 - Math.exp(-dt / 0.15);
    a.aim.yaw += (c.aim.yaw - a.aim.yaw) * f;
    a.aim.pitch += (c.aim.pitch - a.aim.pitch) * f;
    if (now < a.readyAt) return;
    // An abrupt drop of the draw hand after reaching the chin: shoot straight away.
    if (a.drawing && a.drop > DROP_SPEED && a.snap && a.snap.power >= MIN_POWER) {
      fire(a, a.snap.aim, a.snap.power, players.length);
      a.readyAt = now + RELOAD_MS;
      a.firedAt = now;
      a.drawing = false;
      a.power = 0;
      return;
    }
    const anchored = c.raised && c.anchorDist < ANCHOR_IN && a.drop < DROP_SPEED;
    if (anchored) {
      if (!a.drawing) {
        a.drawing = true;
        a.power = 0;
        blip(300, 120, 'triangle', 0.08, 360);
      }
      a.power = Math.min(1, a.power + dt / CHARGE_S);
      a.lastAnchoredAt = now;
      a.snap = { aim: { ...a.aim }, power: a.power };
      return;
    }
    if (!a.drawing) return;
    if (c.anchorDist > ANCHOR_LEAVE) {
      // The draw hand left the chin: shoot with the aim and power it had there (what the arc showed).
      if (a.snap && a.snap.power >= MIN_POWER) {
        fire(a, a.snap.aim, a.snap.power, players.length);
        a.readyAt = now + RELOAD_MS;
        a.firedAt = now;
      }
      a.drawing = false;
      a.power = 0;
    } else if (!c.raised) {
      // Bow arm dropped with the hand still at the chin: put the bow down, no shot.
      a.drawing = false;
      a.power = 0;
    }
  });
  for (const [id, a] of archers) {
    if (seen.has(id)) continue;
    scene.remove(a.fig.root);
    archers.delete(id);
  }
}

/** Pose the line figure: bow arm out along the aim, string hand at the anchor while drawing. */
function poseFigure(a: Archer, n: number, t: number) {
  const fig = a.fig;
  const x = laneX(a, n);
  fig.root.position.set(x, 0, 0);
  const lsW = v3(x - 0.22, 1.42, 0);
  const rsW = v3(x + 0.22, 1.42, 0);
  const local = (w: V3) => w.clone().sub(fig.root.position);
  const aim = a.raised ? a.aim : { yaw: 0, pitch: -50 * DEG };
  const grip = a.raised ? gripOf(a, n, aim) : v3(x - 0.42, 0.95, -0.12);
  fig.bow.position.copy(local(grip));
  fig.bow.rotation.set(aim.pitch, -aim.yaw, 0, 'YXZ');
  const ready = t >= a.readyAt;
  // String pull towards the archer (+z in the bow's frame).
  const pull = a.drawing ? 0.12 + 0.48 * a.power : 0;
  const twang = Math.max(0, 1 - (t - a.firedAt) / 250) * Math.sin(t / 12) * 0.05;
  const nockZ = BOW_TIP_Z + pull + twang;
  const pos = fig.string.geometry.getAttribute('position') as THREE.BufferAttribute;
  pos.setZ(1, nockZ);
  pos.needsUpdate = true;
  fig.nocked.visible = ready && a.raised;
  fig.nocked.position.set(0, 0, nockZ);
  fig.bow.updateMatrixWorld(true);
  const nockW = fig.bow.localToWorld(v3(0, 0, nockZ));
  // Arms: two strokes each, elbows bent a little.
  const elbow = (s: V3, h: V3, drop: number) => s.clone().lerp(h, 0.5).add(v3(0, -drop, 0.05));
  const lh = grip;
  const rh = a.raised ? nockW : v3(x + 0.3, 0.9, 0.05);
  setStroke(fig.leftArm[0], local(lsW), local(elbow(lsW, lh, 0.04)));
  setStroke(fig.leftArm[1], local(elbow(lsW, lh, 0.04)), local(lh));
  setStroke(fig.rightArm[0], local(rsW), local(elbow(rsW, rh, -0.08)));
  setStroke(fig.rightArm[1], local(elbow(rsW, rh, -0.08)), local(rh));
}

// ---------- targets ----------

interface Target {
  kind: 'board' | 'balloon';
  obj: THREE.Group;
  /** Centre of the face / balloon. */
  center: V3;
  /** Board: half the picture's width (rings are fractions of it). Balloon: hit radius. */
  size: number;
  vx: number;
  vy: number;
  gold: boolean;
  bornAt: number;
  hitAt?: number;
  wobble: number;
  phase: number;
}

const targetTex = textureFrom(assets.images.target);
targetTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const balloonTex = [0, 40, 120, 200, 280].map((hue) => {
  const img = assets.images.balloon;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.filter = `hue-rotate(${hue}deg)`;
  g.drawImage(img, 0, 0);
  return textureFrom(c);
});
const wood = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
const goldMat = new THREE.MeshBasicMaterial({ color: 0xffd60a });

let targets: Target[] = [];
/** Boards get bigger further away, so far ones are still fair. */
const boardHalf = (z: number) => 0.6 + Math.abs(z) * 0.03;

function makeBoard(x: number, z: number, gold: boolean): Target {
  const half = boardHalf(z);
  const cy = 1.3 + half * 0.4;
  const obj = new THREE.Group();
  obj.position.set(x, 0, z);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), new THREE.MeshBasicMaterial({ map: targetTex, transparent: true, alphaTest: 0.4 }));
  face.position.y = cy;
  face.name = 'face';
  obj.add(face);
  if (gold) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(half * FACE_EDGE, half * 0.07, 8, 48), goldMat);
    ring.position.y = cy;
    obj.add(ring);
  } else {
    const legR = 0.03 + half * 0.02;
    for (const [lx, lz] of [[-0.55, 0.15], [0.55, 0.15], [0, -0.5]]) {
      const top = v3(lx * half * 0.6, cy, -0.05);
      const foot = v3(lx * half, 0, lz * half);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(legR, legR, 1, 6), wood);
      setStroke(leg, foot, top);
      obj.add(leg);
    }
  }
  scene.add(obj);
  return { kind: 'board', obj, center: v3(x, cy, z), size: half, vx: 0, vy: 0, gold, bornAt: performance.now(), wobble: 0, phase: 0 };
}

function spawnBoard() {
  for (let tries = 0; tries < 30; tries++) {
    const z = -(10 + Math.random() * 40);
    const x = (Math.random() * 2 - 1) * (halfWidthAt(z) - 1);
    const half = boardHalf(z);
    // Not hiding behind another board, as seen from the archers.
    const clash = targets.some((t) => {
      if (t.kind !== 'board') return false;
      const dz = Math.abs(t.center.z - z);
      const sx = Math.abs(t.center.x / (CAM_POS.z - t.center.z) - x / (CAM_POS.z - z)) * 60;
      return dz < 4 ? Math.abs(t.center.x - x) < t.size + half + 1.5 : sx < 2.2;
    });
    if (clash) continue;
    targets.push(makeBoard(x, z, false));
    return;
  }
}

function spawnBalloon() {
  const z = -(12 + Math.random() * 25);
  const x = (Math.random() * 2 - 1) * (halfWidthAt(z) - 1);
  const size = 1.1;
  const obj = new THREE.Group();
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: balloonTex[Math.floor(Math.random() * balloonTex.length)] }));
  s.scale.set(size, size, 1);
  obj.add(s);
  const str = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([v3(0, -size * 0.47, 0), v3(0.05, -size * 0.8, 0), v3(-0.05, -size * 1.1, 0), v3(0, -size * 1.5, 0)]),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  );
  obj.add(str);
  obj.position.set(x, -1, z);
  scene.add(obj);
  targets.push({ kind: 'balloon', obj, center: obj.position, size: size * 0.4, vx: 0, vy: 1 + Math.random() * 0.6, gold: false, bornAt: performance.now(), wobble: 0, phase: Math.random() * 6 });
}

function spawnGold() {
  const fromLeft = Math.random() < 0.5;
  const z = -28;
  const t = makeBoard(fromLeft ? -halfWidthAt(z) - 2 : halfWidthAt(z) + 2, z, true);
  t.obj.position.y = 1.2;
  t.center.y += 1.2;
  t.vx = (fromLeft ? 1 : -1) * 4;
  targets.push(t);
}

function removeTarget(t: Target) {
  scene.remove(t.obj);
}

let nextBoardAt = 0;
let nextBalloonAt = 0;

function updateTargets(dt: number, now: number) {
  const n = Math.max(1, archers.size);
  const live = targets.filter((t) => t.hitAt === undefined);
  if (live.filter((t) => t.kind === 'board' && !t.gold).length < 2 + n && now >= nextBoardAt) {
    spawnBoard();
    nextBoardAt = now + 300;
  }
  if (now >= nextBalloonAt) {
    if (live.filter((t) => t.kind === 'balloon').length < 3) spawnBalloon();
    nextBalloonAt = now + 1800 + Math.random() * 1500;
  }
  if (flow.elapsed > 15 && !live.some((t) => t.gold) && Math.random() < dt * 0.15) spawnGold();
  for (const t of targets) {
    t.phase += dt;
    t.wobble *= Math.exp(-dt * 5);
    if (t.kind === 'board') {
      const face = t.obj.getObjectByName('face')!;
      face.rotation.x = Math.sin(now / 45) * t.wobble * 0.12;
      // Pop up when new, fall back when done.
      const grow = Math.min(1, (now - t.bornAt) / 350);
      const fall = t.hitAt === undefined ? 0 : Math.max(0, Math.min(1, (now - t.hitAt - 900) / 400));
      t.obj.rotation.x = -(1 - grow) * 1.4 - fall * 1.5;
    }
    if (t.hitAt !== undefined) continue;
    t.obj.position.x += t.vx * dt;
    t.center.x = t.obj.position.x;
    if (t.kind === 'balloon') {
      t.obj.position.y += t.vy * dt;
      t.obj.position.x += Math.sin(t.phase * 1.3) * 0.3 * dt;
    }
  }
  targets = targets.filter((t) => {
    const gone =
      t.hitAt !== undefined ? now - t.hitAt > (t.kind === 'balloon' ? 0 : 1300) : t.kind === 'balloon' ? t.obj.position.y > 16 : t.gold && Math.abs(t.obj.position.x) > halfWidthAt(-28) + 3;
    if (gone) removeTarget(t);
    return !gone;
  });
}

// ---------- flight ----------

interface Launch {
  o: V3;
  v: V3;
}
const launchOf = (a: Archer, n: number, aim: Aim, power: number): Launch => ({ o: gripOf(a, n, aim), v: dirOf(aim).multiplyScalar(speedFor(power)) });
/** Exact position `t` seconds after launch, so flights match their preview. */
const posAt = (l: Launch, t: number) => v3(l.o.x + l.v.x * t, l.o.y + l.v.y * t - 0.5 * G * t * t, l.o.z + l.v.z * t);
const velAt = (l: Launch, t: number) => v3(l.v.x, l.v.y - G * t, l.v.z);

interface Hit {
  /** Fraction along the segment. */
  f: number;
  point: V3;
  target: Target | null;
}

/** First thing the segment p0→p1 runs into: a board face, a balloon or the ground. */
function segmentHit(p0: V3, p1: V3, live = true): Hit | null {
  let best: Hit | null = null;
  const consider = (h: Hit) => {
    if (!best || h.f < best.f) best = h;
  };
  for (const t of targets) {
    if (live && t.hitAt !== undefined) continue;
    if (t.kind === 'board') {
      const z = t.center.z;
      if (!(p0.z > z && p1.z <= z)) continue;
      const f = (p0.z - z) / (p0.z - p1.z);
      const p = p0.clone().lerp(p1, f);
      if (Math.hypot(p.x - t.center.x, p.y - t.center.y) < t.size * FACE_EDGE) consider({ f, point: p, target: t });
    } else {
      // Closest approach of the segment to the balloon centre.
      const d = p1.clone().sub(p0);
      const len2 = d.lengthSq() || 1e-9;
      const f = Math.max(0, Math.min(1, t.center.clone().sub(p0).dot(d) / len2));
      const p = p0.clone().addScaledVector(d, f);
      if (p.distanceTo(t.center) < t.size) consider({ f, point: p, target: t });
    }
  }
  if (p1.y <= 0 && p0.y > 0) {
    const f = p0.y / (p0.y - p1.y);
    consider({ f, point: p0.clone().lerp(p1, f).setY(0), target: null });
  }
  return best;
}

const STEP = 1 / 60;

/** Sample the flight in STEP slices until it hits something (max 6 s). */
function trajectory(l: Launch): { pts: V3[]; hit: Hit | null } {
  const pts: V3[] = [l.o.clone()];
  let prev = l.o.clone();
  for (let i = 1; i <= 360; i++) {
    const p = posAt(l, i * STEP);
    const h = segmentHit(prev, p);
    if (h) {
      pts.push(h.point);
      return { pts, hit: h };
    }
    pts.push(p);
    prev = p;
  }
  return { pts, hit: null };
}

interface Arrow {
  l: Launch;
  age: number;
  obj: THREE.Group;
  trail: THREE.Line;
  slot: number;
  color: string;
  stuckAt?: number;
  /** Long shot: the hit cam follows it. */
  far: boolean;
}

let arrows: Arrow[] = [];
const trailGeoPts = 24;
let shots = 0;
/** The last shot's predicted and actual landing (for tests). */
let lastShot: { aim: number[]; predicted: string | null; actual: string | null } | null = null;
const describeHit = (h: Hit) => `${h.target?.kind ?? 'ground'}@${h.point.toArray().map((v) => v.toFixed(1))}`;
let hits = 0;

function fire(a: Archer, aim: Aim, power: number, n: number) {
  const l = launchOf(a, n, aim, power);
  const k = ink(a.color);
  const obj = makeArrow(k);
  obj.position.copy(l.o);
  scene.add(obj);
  const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: trailGeoPts }, () => l.o.clone())), new THREE.LineBasicMaterial({ color: k.core.color, transparent: true, opacity: 0.8 }));
  scene.add(trail);
  const { hit } = trajectory(l);
  const far = !!hit && hit.point.distanceTo(l.o) > 22;
  lastShot = { aim: [+(aim.yaw / DEG).toFixed(1), +(aim.pitch / DEG).toFixed(1), +power.toFixed(2)], predicted: hit ? describeHit(hit) : null, actual: null };
  const arrow: Arrow = { l, age: 0, obj, trail, slot: a.slot, color: a.color, far };
  arrows.push(arrow);
  if (far) hitCam = { arrow, until: Infinity, at: null };
  shots++;
  blip(160 + power * 180, 220, 'triangle', 0.22, 90);
  noise(70, 0.08);
}

const FWD = v3(0, 0, -1);
function orient(obj: THREE.Object3D, vel: V3) {
  obj.quaternion.setFromUnitVectors(FWD, vel.clone().normalize());
}

function updateArrows(dt: number, now: number) {
  for (const a of arrows) {
    if (a.stuckAt !== undefined) continue;
    const prev = posAt(a.l, a.age);
    const age = a.age + dt;
    const p = posAt(a.l, age);
    const ahead = velAt(a.l, age).normalize().multiplyScalar(ARROW_LEN);
    const h = segmentHit(prev, p);
    a.age = age;
    if (h) {
      a.stuckAt = now;
      const vel = velAt(a.l, a.age);
      orient(a.obj, vel);
      // Tail back from the hit point, the head buried a little.
      a.obj.position.copy(h.point).addScaledVector(vel.normalize(), -ARROW_LEN * 0.85);
      if (h.target?.kind === 'board') h.target.obj.attach(a.obj);
      strike(a, h, now);
    } else {
      orient(a.obj, velAt(a.l, a.age));
      // The flight point is the tip; the arrow's tail trails behind it.
      a.obj.position.copy(p).sub(ahead);
    }
    // Trail: the last half second of the path.
    const pos = a.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < trailGeoPts; i++) {
      const q = posAt(a.l, Math.max(0, a.age - (0.5 * (trailGeoPts - 1 - i)) / (trailGeoPts - 1)));
      pos.setXYZ(i, q.x, q.y, q.z);
    }
    pos.needsUpdate = true;
    a.trail.geometry.computeBoundingSphere();
  }
  arrows = arrows.filter((a) => {
    const done = (a.stuckAt !== undefined && now - a.stuckAt > 2500) || a.age > 8;
    (a.trail.material as THREE.LineBasicMaterial).opacity = a.stuckAt === undefined ? 0.8 : Math.max(0, 0.8 - (now - a.stuckAt) / 400);
    if (done) {
      a.obj.removeFromParent();
      scene.remove(a.trail);
    }
    return !done;
  });
}

// ---------- scoring and effects ----------

interface Pop {
  at3: V3;
  text: string;
  color: string;
  at: number;
  size: number;
}
interface Particle {
  p: V3;
  v: V3;
  color: string;
  life: number;
  age: number;
}
let pops: Pop[] = [];
let particles: Particle[] = [];

function burst(at: V3, color: string, n: number, speed: number) {
  for (let i = 0; i < n; i++) {
    const d = v3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
    particles.push({ p: at.clone(), v: d.multiplyScalar(speed * (0.4 + Math.random() * 0.8)), color, life: 0.8, age: 0 });
  }
}

function strike(a: Arrow, h: Hit, now: number) {
  if (lastShot) lastShot.actual = describeHit(h);
  if (hitCam?.arrow === a) {
    hitCam.until = now + 1500;
    hitCam.at = h.point.clone();
  }
  const t = h.target;
  if (!t) {
    noise(50, 0.08);
    return;
  }
  if (!flow.playing) return;
  hits++;
  if (t.kind === 'balloon') {
    t.hitAt = now;
    flow.addScore(a.slot, 3);
    pops.push({ at3: t.center.clone(), text: '+3', color: a.color, at: now, size: 1 });
    burst(t.center, '#ff5d73', 24, 3);
    a.stuckAt = now - 2400;
    noise(140, 0.35);
    blip(900, 90, 'square', 0.1, 1500);
    say('Pop!', { interrupt: true });
    return;
  }
  const f = Math.hypot(h.point.x - t.center.x, h.point.y - t.center.y) / t.size;
  const ring = RINGS.findIndex((edge) => f < edge);
  let points = RING_POINTS[ring < 0 ? RING_POINTS.length - 1 : ring];
  if (t.gold) points *= 2;
  flow.addScore(a.slot, points);
  t.wobble = 1;
  if (t.hitAt === undefined) t.hitAt = now;
  t.vx = 0;
  noise(60, 0.3);
  blip(160, 140, 'sine', 0.3, 80);
  const bull = ring === 0;
  pops.push({ at3: t.center.clone().add(v3(0, t.size * 1.3, 0)), text: bull ? `Bullseye! +${points}` : `+${points}`, color: bull ? theme.accent : a.color, at: now, size: bull ? 1.4 : 1 });
  if (bull || t.gold) {
    say(t.gold ? 'Golden shot!' : 'Bullseye!', { interrupt: true });
    [523, 659, 784, 1047].forEach((fq, i) => setTimeout(() => blip(fq, 160, 'triangle', 0.15), i * 100));
    burst(h.point, '#ffbe0b', 26, 2.5);
  } else {
    burst(h.point, '#e9c46a', 10, 1.5);
  }
  nextBoardAt = Math.max(nextBoardAt, now + 900);
}

// ---------- aiming arc ----------

const DOTS = 90;
const dotGeo = new THREE.SphereGeometry(1, 8, 6);
interface Arc {
  dots: THREE.InstancedMesh;
  marker: THREE.Mesh;
}
const arcs = new Map<number, Arc>();
function arcFor(a: Archer): Arc {
  let arc = arcs.get(a.id);
  if (!arc) {
    const k = ink(a.color);
    const dots = new THREE.InstancedMesh(dotGeo, k.core, DOTS);
    dots.frustumCulled = false;
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 32), new THREE.MeshBasicMaterial({ color: k.color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    scene.add(dots, marker);
    arc = { dots, marker };
    arcs.set(a.id, arc);
  }
  return arc;
}

const m4 = new THREE.Matrix4();
const qI = new THREE.Quaternion();
/** What each archer's arc is landing on right now (for the test peek). */
const onTarget = new Map<number, string | null>();

function drawArcs(n: number, t: number) {
  for (const [id, arc] of arcs) {
    if (!archers.has(id)) {
      scene.remove(arc.dots, arc.marker);
      arcs.delete(id);
    }
  }
  for (const a of archers.values()) {
    const arc = arcFor(a);
    const show = a.drawing && t >= a.readyAt;
    arc.dots.visible = arc.marker.visible = show;
    onTarget.set(a.id, null);
    if (!show) continue;
    const { pts, hit } = trajectory(launchOf(a, n, a.aim, a.power));
    // Evenly spaced dots, a little bigger further away so they stay visible.
    let count = 0;
    let run = 0;
    for (let i = 1; i < pts.length && count < DOTS; i++) {
      run += pts[i].distanceTo(pts[i - 1]);
      if (run < 1.2) continue;
      run = 0;
      const r = 0.045 + pts[i].distanceTo(camera.position) * 0.0022;
      m4.compose(pts[i], qI, v3(r, r, r));
      arc.dots.setMatrixAt(count++, m4);
    }
    arc.dots.count = count;
    arc.dots.instanceMatrix.needsUpdate = true;
    if (hit) {
      const e = hit.point;
      const tg = hit.target;
      const r = (tg?.kind === 'board' ? tg.size * 0.18 : 0.35) * (1 + Math.sin(t / 120) * 0.12) + e.distanceTo(camera.position) * 0.004;
      arc.marker.position.copy(e);
      arc.marker.scale.setScalar(r);
      // Flat on the grass, upright on a board, facing us on a balloon.
      if (!tg) arc.marker.rotation.set(-Math.PI / 2, 0, 0);
      else arc.marker.rotation.set(0, 0, 0);
      if (tg?.kind === 'board') arc.marker.position.z += 0.03;
      onTarget.set(a.id, tg ? tg.kind : 'ground');
    } else arc.marker.visible = false;
  }
}

// ---------- hit cam ----------

let hitCam: { arrow: Arrow; until: number; at: V3 | null } | null = null;

function placeHitCam(): boolean {
  if (!hitCam) return false;
  const now = performance.now();
  if (now > hitCam.until) {
    hitCam = null;
    return false;
  }
  const a = hitCam.arrow;
  if (hitCam.at) {
    // Watch the hit from a little in front and to the side.
    const p = hitCam.at;
    hitCamera.position.set(p.x + 1.2, p.y + 0.5, p.z + 3);
    hitCamera.lookAt(p.x, p.y, p.z);
  } else {
    const p = posAt(a.l, a.age);
    const d = velAt(a.l, a.age).normalize();
    hitCamera.position.copy(p).addScaledVector(d, -2.5).add(v3(0.6, 0.6, 0));
    hitCamera.lookAt(p.clone().addScaledVector(d, 4));
  }
  return true;
}

// ---------- round ----------

let startedAt = 0;
prepareSpeech([
  'Archery! Hold your bow hand up in front, pull your right hand back to your chin, then drop it to shoot!',
  'Bullseye!',
  'Pop!',
  'Golden shot!',
]);

flow.on('start', () => {
  for (const t of targets) removeTarget(t);
  targets = [];
  for (const a of arrows) {
    a.obj.removeFromParent();
    scene.remove(a.trail);
  }
  arrows = [];
  particles = [];
  pops = [];
  shots = 0;
  hits = 0;
  hitCam = null;
  startedAt = performance.now();
  nextBoardAt = startedAt;
  nextBalloonAt = startedAt + 2500;
  say('Archery! Hold your bow hand up in front, pull your right hand back to your chin, then drop it to shoot!');
});

// ---------- HUD (2D canvas on top) ----------

let W = 1;
let H = 1;
function toScreen(p: V3, cam: THREE.Camera = camera): { x: number; y: number; z: number } {
  const q = p.clone().project(cam);
  return { x: (q.x + 1) * 0.5 * W, y: (1 - q.y) * 0.5 * H, z: q.z };
}

/** Torso length per archer card (smoothed, so the card's zoom doesn't wobble). */
const cardTorso = new Map<number, number>();

/**
 * A small mirror of each archer's tracked pose, with the anchor zone lit up while drawing. Only
 * the upper body (head, torso, arms) — the legs don't aim — framed on the shoulders and zoomed
 * in, shifted towards the bow arm. Standing side-on is fine when the bow arm points at the
 * screen (a real archer's stance), but side-on with it pointing out sideways pins the aim hard
 * over, so that gets a "point your bow at the screen" hint.
 */
function drawMirrors() {
  const list = [...archers.values()].sort((a, b) => a.lane - b.lane);
  const ch = H * 0.2;
  const cw = ch * 1.1; // upper body only: a little wider than tall
  list.forEach((a, i) => {
    const p = game.frame.players.find((q) => q.id === a.id);
    if (!p) return;
    const x0 = W - (list.length - i) * (cw + 12) - 8;
    const y0 = H - ch - 12;
    ctx.save();
    ctx.fillStyle = 'rgba(10,6,30,0.45)';
    ctx.strokeStyle = a.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x0, y0, cw, ch, 12);
    ctx.fill();
    ctx.stroke();
    ctx.clip();
    const k = p.keypoints;
    const A = game.frame.aspect;
    // Frame the upper body on the shoulders: wide enough for both arms straight out and tall
    // enough for a hand straight up down to the hips, using this player's own arm length.
    const ls = k[KP.leftShoulder], rs = k[KP.rightShoulder], lh = k[KP.leftHip], rh = k[KP.rightHip];
    const mid = { x: ((ls.x + rs.x) / 2) * A, y: (ls.y + rs.y) / 2 };
    const hipsOk = lh.score >= MIN_SCORE && rh.score >= MIN_SCORE;
    const T0 = hipsOk ? Math.hypot(mid.x - ((lh.x + rh.x) / 2) * A, mid.y - (lh.y + rh.y) / 2) : p.bbox.h * 0.3;
    const T = (cardTorso.get(a.id) ?? T0) * 0.9 + Math.max(0.03, T0) * 0.1;
    cardTorso.set(a.id, T);
    // Arm length in torso lengths (both raw camera measures; the laid-out armLength is scaled).
    const arm = p.raw?.armLength ?? p.armLength;
    const R = arm && p.torso ? Math.min(1.6, Math.max(0.95, arm / p.torso)) : 1.2;
    const sc = Math.min(cw / (2 * (0.45 + R) * T), ch / ((R + 1.7) * T));
    const cx = mid.x;
    const cy = mid.y + ((1.3 - R - 0.4) / 2) * T;
    const toCard = (q: { x: number; y: number }) => ({ x: x0 + cw / 2 + (q.x * A - cx) * sc, y: y0 + ch / 2 + (q.y - cy) * sc });
    const map = (i2: number) => toCard(k[i2]);
    drawSkeleton(ctx, p, toCard, { parts: ['head', 'torso', 'arms'], lineWidth: 4, minScore: MIN_SCORE });
    if (k[0].score >= MIN_SCORE) {
      const nz = map(0);
      // Anchor zone by the chin.
      const sw = Math.hypot(map(5).x - map(6).x, map(5).y - map(6).y);
      ctx.strokeStyle = a.drawing ? theme.accent : 'rgba(255,255,255,0.5)';
      ctx.setLineDash(a.drawing ? [] : [5, 5]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(nz.x + 0.3 * sw, nz.y + 0.5 * sw, ANCHOR_IN * sw, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Bow hand and draw hand.
    for (const [i2, col] of [[9, '#fff'], [10, a.drawing ? theme.accent : a.color]] as const) {
      if (k[i2].score < MIN_SCORE) continue;
      const q = map(i2);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(q.x, q.y, ch * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
    if (p.facing === 'side' && a.raised && Math.abs(a.aim.yaw) > 0.8 * YAW_MAX) {
      ctx.fillStyle = 'rgba(10,6,30,0.7)';
      ctx.fillRect(x0, y0 + ch * 0.72, cw, ch * 0.28);
      drawText(ctx, 'Point your bow', x0 + cw / 2, y0 + ch * 0.8, Math.min(ch * 0.09, cw / 8), theme.accent);
      drawText(ctx, 'at the screen', x0 + cw / 2, y0 + ch * 0.92, Math.min(ch * 0.09, cw / 8), theme.accent);
    }
    ctx.restore();
  });
}

/** Power meter over each archer's head. */
function drawPower(t: number) {
  for (const a of archers.values()) {
    if (!a.drawing || t < a.readyAt) continue;
    const s = toScreen(a.fig.root.localToWorld(v3(0, 2.15, 0)));
    const w = H * 0.12;
    ctx.save();
    ctx.fillStyle = 'rgba(10,6,30,0.6)';
    ctx.beginPath();
    ctx.roundRect(s.x - w / 2 - 4, s.y - 12, w + 8, 24, 12);
    ctx.fill();
    ctx.fillStyle = a.power >= 1 ? theme.accent : a.color;
    ctx.beginPath();
    ctx.roundRect(s.x - w / 2, s.y - 8, w * a.power, 16, 8);
    ctx.fill();
    ctx.restore();
  }
}

// ---------- main loop ----------

let last = performance.now();
function loop(t: number) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  ({ w: W, h: H } = stage.resize());
  fitCanvas(hud, ctx);
  flow.update(t);
  // Only three archers: a fourth person doesn't get a score chip.
  for (const s of Object.keys(flow.scores).map(Number)) if (s >= MAX_ARCHERS) delete flow.scores[s];
  updateArchers(t, dt);
  const n = archers.size;
  // Pull the camera back a little for more archers, so everyone fits.
  const camWant = v3(CAM_POS.x, CAM_POS.y + 0.4 * Math.max(0, n - 1), CAM_POS.z + 1.6 * Math.max(0, n - 1));
  camera.position.lerp(camWant, 1 - Math.exp(-dt * 2));
  camera.lookAt(LOOK_AT);
  for (const a of archers.values()) poseFigure(a, n, t);
  if (flow.playing) updateTargets(dt, t);
  updateArrows(dt, t);
  drawArcs(n, t);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.render(scene, camera);
  const pip = placeHitCam();
  const pw = Math.round(W * 0.3);
  const ph = Math.round((pw * 9) / 16);
  const px = W - pw - 16;
  const py = 26;
  if (pip) {
    hitCamera.aspect = pw / ph;
    hitCamera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setViewport(px, H - py - ph, pw, ph);
    renderer.setScissor(px, H - py - ph, pw, ph);
    renderer.render(scene, hitCamera);
    renderer.setScissorTest(false);
  }

  ctx.clearRect(0, 0, W, H);
  if (pip) {
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(px, py, pw, ph, 8);
    ctx.stroke();
    ctx.restore();
    drawText(ctx, 'Arrow cam', px + 12, py + 20, H / 30, theme.ink, { align: 'left' });
  }
  // Sparks, drawn flat on the HUD.
  for (const pt of particles) {
    pt.age += dt;
    pt.v.y -= G * 0.6 * dt;
    pt.p.addScaledVector(pt.v, dt);
    const s = toScreen(pt.p);
    if (s.z > 1) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - pt.age / pt.life);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(2, H * 0.006 * (12 / Math.max(4, pt.p.distanceTo(camera.position))) * 3), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  particles = particles.filter((pt) => pt.age < pt.life);
  for (const pp of pops) {
    const age = (t - pp.at) / 1300;
    const s = toScreen(pp.at3);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age);
    drawText(ctx, pp.text, s.x, s.y - age * H * 0.08, (H / 16) * pp.size, pp.color);
    ctx.restore();
  }
  pops = pops.filter((pp) => t - pp.at < 1300);
  drawPower(t);
  drawMirrors();
  if (flow.state === 'playing' && t - startedAt < 8000) {
    drawText(ctx, 'Bow hand up in front · right hand to your chin · drop it to shoot!', W * 0.4, H * 0.2, Math.min(H / 28, W / 44));
  }
  flow.drawOverlay(ctx, W, H);
  requestAnimationFrame(loop);
}

// Read-only peek for automated tests and debugging.
(window as unknown as { archery: () => object }).archery = () => ({
  state: flow.state,
  scores: flow.scores,
  shots,
  hits,
  archers: [...archers.values()].map((a) => ({
    slot: a.slot,
    lane: a.lane,
    raised: a.raised,
    drawing: a.drawing,
    power: +a.power.toFixed(2),
    anchorDist: +a.anchorDist.toFixed(2),
    yaw: +(a.aim.yaw / DEG).toFixed(1),
    pitch: +(a.aim.pitch / DEG).toFixed(1),
    grip: gripOf(a, archers.size, a.aim).toArray().map((v) => +v.toFixed(2)),
    onTarget: onTarget.get(a.id) ?? null,
  })),
  arrows: arrows.map((a) => posAt(a.l, a.age).toArray().map((v) => +v.toFixed(1))),
  targets: targets.map((tg) => ({ kind: tg.kind, center: tg.center.toArray().map((v) => +v.toFixed(2)), size: +tg.size.toFixed(2), hit: tg.hitAt !== undefined, gold: tg.gold })),
  /** The sim's camera-to-screen mapping needs these. */
  aspect: game.frame.aspect,
  keypoints: game.frame.players.map((p) => ({ slot: p.slot, nose: [p.keypoints[0].x, p.keypoints[0].y], ls: [p.keypoints[5].x, p.keypoints[5].y], rs: [p.keypoints[6].x, p.keypoints[6].y] })),
  hitCam: !!hitCam,
  lastShot,
  size: [W, H],
  physics: { g: G, vMax: V_MAX },
});

requestAnimationFrame(loop);
