/**
 * Block Dash: a 3D runner. Each player has their own lane, side by side in the same world,
 * and the same blocks come at everyone at the same time. The players stand at the far end of
 * the track (top of the screen), facing the camera, which looks back at them from in front and
 * above at a 3/4 angle. The world streams up the screen towards them: they "run" against it.
 *
 * Players are upright cards in 3D, textured with their own camera cut-out (the tracker's
 * person segmentation, via game.segmentation()), or a glowing stick figure when there's no
 * cut-out (simulator, or segmentation off). The card is cropped around each player from their
 * own standing height, so everyone is the same size in the world (normalised).
 *
 * Controls, from the body:
 *  - Step (or lean) sideways: the card slides across its lane (continuous). Pillars and pipes
 *    fill the left or right half of the lane: be on the other side.
 *  - Jump: over low brick walls; bump "?" blocks overhead for coins.
 *  - Duck (crouch): under floating brick bars.
 * Coins along the lanes, +1 per obstacle cleared. A bump costs a point and the streak, then a
 * short blink (no one is knocked out). The rainbow star spawns in every lane at once: catch it
 * to be invulnerable for POWER_S seconds (blocks get knocked flying, +2 each) with a rainbow
 * shader over the player's card.
 *
 * Artwork: art/generate.py (Gemini) -> public/art.
 */
import {
  KP,
  RoundFlow,
  blip,
  createGame,
  drawText,
  fitCanvas,
  loadAssets,
  noise,
  prepareSpeech,
  say,
  type Cutout,
  type Keypoint,
  type Player,
  type Segmentation,
} from '@trackergame/sdk';
import * as THREE from '@trackergame/sdk/three';
import { createStage3D, textureFrom } from '@trackergame/sdk/three';

type V3 = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------- tuning ----------

const ROUND_S = 75;
/** Seconds of rainbow invulnerability from the star. */
const POWER_S = 6;
/** Seconds of blinking (no more bumps) after a bump. */
const HURT_S = 1.5;
const LANE_W = 2.7;
/** How far a card can slide from its lane's centre (world units). */
const SIDE = 0.72;
/** Half the width of a player's body on the card, for side collisions. */
const BODY = 0.24;
const BLOCK = 0.72;
/** Card size in the world: everyone is this tall (normalised), whatever their real size. */
const CARD_H = 2.8;
const CARD_W = CARD_H * 0.75;
/** The card shows this much more than the player's standing height (room for raised arms). */
const WINDOW = 1.3;
/** Card texture size. */
const TW = 240;
const TH = 320;
/** Visual jump height (world units) while airborne. */
const JUMP_LIFT = 1.1;
/** Height of the bottom of "?" blocks: above a standing head, within reach of a jump. */
const Q_Y = 2.55;
/** Without p.jump: how long the 'jump' event counts as airborne. */
const JUMP_FALLBACK_MS = 550;
/** Rows appear here (behind the camera) and are removed past END_Z (behind the players). */
const SPAWN_Z = 24;
const END_Z = -13;
const MIN_SCORE = 0.3;
/** ?star=N: the first star comes N s into the round (testing). */
const STAR_FIRST = Number(new URLSearchParams(location.search).get('star')) || null;
const speedAt = (t: number) => 7 + 6 * Math.min(1, t / ROUND_S);
const gapAt = (t: number) => Math.max(1.15, 2.3 - 1.15 * Math.min(1, t / ROUND_S));

// ---------- setup ----------

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;
const ctx = hud.getContext('2d')!;
// people: 'game' -> the cut-outs are sent to us (game.segmentation()) and nobody else draws
// them: we put them on the cards. No footprints: players are cards here, not the 2D overlay.
const game = await createGame({ people: 'game', feet: false });
const assets = await loadAssets({
  images: {
    background: 'art/background.jpg',
    brick: 'art/brick.jpg',
    qblock: 'art/qblock.jpg',
    grass: 'art/grass.jpg',
    path: 'art/path.jpg',
    coin: 'art/coin.png',
    star: 'art/star.png',
    bush: 'art/bush.png',
  },
});
const flow = new RoundFlow(game, {
  title: 'Block Dash',
  subtitle: 'Step aside, jump and duck to dodge the blocks! Raise both hands to start.',
  seconds: ROUND_S,
});

const stage = createStage3D(glCanvas, { fov: 48, background: '#7ec8ff' });
const { scene, camera, renderer } = stage;
camera.far = 400;
camera.updateProjectionMatrix();

scene.add(new THREE.HemisphereLight(0xffffff, 0x4d7a32, 1.5));
const sun = new THREE.DirectionalLight(0xfff1d0, 1.7);
sun.position.set(5, 12, 9);
scene.add(sun);

/** Average colour of a strip of an image (fractions), so the fog matches the backdrop. */
function stripColour(img: HTMLImageElement, y0: number, y1: number): THREE.Color {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, img.height * y0, img.width, img.height * (y1 - y0), 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    gg += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  return new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

const BG_Z = -14;
/** Where the backdrop's grass starts, as a fraction of its height from the top. */
const BG_GROUND = 0.69;
scene.fog = new THREE.Fog(stripColour(assets.images.background, BG_GROUND, BG_GROUND + 0.05), 16, 36);

// The Gemini hills and sky, far behind the players; its grass meets the ground.
{
  const img = assets.images.background;
  const w = 100;
  const h = (w * img.height) / img.width;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: textureFrom(img), fog: false }));
  m.position.set(0, (BG_GROUND - 0.5) * h, BG_Z);
  scene.add(m);
}

function tiled(img: HTMLImageElement, rx: number, ry: number): THREE.Texture {
  const t = textureFrom(img);
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping; // hides the seams of a non-tiling picture
  t.repeat.set(rx, ry);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Grass everywhere, scrolling with the world.
const GRASS_TILE = 9;
const grassTex = tiled(assets.images.grass, 160 / GRASS_TILE, 60 / GRASS_TILE);
{
  const m = new THREE.Mesh(new THREE.PlaneGeometry(160, 60), new THREE.MeshLambertMaterial({ map: grassTex }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, 0, BG_Z + 30);
  scene.add(m);
}

// One sandy path per lane (up to 4), shown for lanes in use.
const PATH_W = LANE_W - 0.3;
const PATH_LEN = 70;
const pathTex = tiled(assets.images.path, 1, PATH_LEN / PATH_W);
const paths: THREE.Mesh[] = [];
for (let i = 0; i < 4; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(PATH_W, PATH_LEN), new THREE.MeshLambertMaterial({ map: pathTex }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, 0.01, 2);
  m.visible = false;
  scene.add(m);
  paths.push(m);
  // Brick kerbs along both edges.
  for (const side of [-1, 1]) {
    const k = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, PATH_LEN), new THREE.MeshLambertMaterial({ color: 0xc8662e }));
    k.position.set((side * PATH_W) / 2, 0.05, 0);
    k.rotation.x = Math.PI / 2;
    m.add(k);
  }
}

// ---------- shared materials ----------

const brickTex = textureFrom(assets.images.brick);
const qTex = textureFrom(assets.images.qblock);
const coinTex = textureFrom(assets.images.coin);
const starTex = textureFrom(assets.images.star);
const bushTex = textureFrom(assets.images.bush);
const blockGeo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
const brickMat = new THREE.MeshLambertMaterial({ map: brickTex });
const qMat = new THREE.MeshLambertMaterial({ map: qTex, emissive: 0x332200 });
const usedMat = new THREE.MeshLambertMaterial({ map: brickTex, color: 0x8a6a50 });
const pipeMat = new THREE.MeshLambertMaterial({ color: 0x35b84a, emissive: 0x062a0c });
const pipeDark = new THREE.MeshLambertMaterial({ color: 0x1f7a30 });
const coinGeo = new THREE.PlaneGeometry(0.55, 0.55);
const coinMat = new THREE.MeshBasicMaterial({ map: coinTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });

/** A soft round texture: shadows and glows. */
function radialTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const shadowTex = radialTexture('rgba(0,0,0,0.45)', 'rgba(0,0,0,0)');
const glowTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');

/** A four-pointed sparkle. */
const sparkleTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 14);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const r = i % 2 ? 5 : 30;
    g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  g.fill();
  return new THREE.CanvasTexture(c);
})();

const HSV_GLSL = /* glsl */ `
  vec3 hue(float h) {
    vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return pow(k, vec3(2.2)); // vivid in linear space
  }
`;

// ---------- the player cards ----------

/**
 * The card shader: the player's picture with a soft rim glow in their colour. With the star
 * (uPower), hue-cycling rainbow bands sweep up through the player, keeping their shading
 * (luminance) so they're still recognisable, with twinkling glints and a rainbow rim, all
 * masked by the picture's alpha so it follows their silhouette. uFlash tints red on a bump.
 */
function cardMaterial(map: THREE.Texture, color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      uTime: { value: 0 },
      uPower: { value: 0 },
      uFlash: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uTexel: { value: new THREE.Vector2(1 / TW, 1 / TH) },
    },
    transparent: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float uTime, uPower, uFlash, uOpacity;
      uniform vec3 uColor;
      uniform vec2 uTexel;
      varying vec2 vUv;
      ${HSV_GLSL}
      void main() {
        vec4 tex = texture2D(map, vUv);
        // Rim: the silhouette grown outwards, minus the silhouette.
        float halo = 0.0;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 0.5236;
          vec2 d = vec2(cos(a), sin(a)) * uTexel;
          halo = max(halo, texture2D(map, vUv + d * 4.0).a);
          halo = max(halo, texture2D(map, vUv + d * 9.0).a * 0.55);
        }
        float rim = clamp(halo - tex.a, 0.0, 1.0);

        // Rainbow: diagonal hue bands sweeping upwards, brighter stripes, twinkles.
        float h = fract(vUv.y * 1.4 - vUv.x * 0.5 - uTime * 0.75);
        vec3 rb = hue(h);
        float bands = 0.5 + 0.5 * sin(vUv.y * 28.0 - vUv.x * 9.0 - uTime * 10.0);
        float tw = pow(max(0.0, sin(vUv.x * 37.0 + uTime * 5.3) * sin(vUv.y * 29.0 - uTime * 4.1)), 24.0);
        float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
        vec3 tinted = rb * (0.3 + 1.2 * lum);
        // A bright diagonal sheen that sweeps up the body now and then.
        float sweep = smoothstep(0.07, 0.0, abs(fract(vUv.y * 0.8 + vUv.x * 0.4 - uTime * 0.9) - 0.5));
        float k = uPower * (0.22 + 0.22 * bands);
        vec3 body = mix(tex.rgb, tinted, k) + uPower * (tw * 1.4 + 0.1 * bands * rb + sweep * 0.45);

        vec3 rimCol = mix(uColor, hue(fract(h + 0.5)) * 1.4, uPower);
        float rimA = rim * mix(0.75, 1.0, uPower);
        float alpha = max(tex.a, rimA);
        if (alpha < 0.03) discard;
        vec3 col = mix(rimCol, body, tex.a / max(alpha, 0.001));
        col = mix(col, vec3(1.0, 0.25, 0.2), uFlash * 0.6);
        gl_FragColor = vec4(col, alpha * uOpacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The star's countdown: a rainbow ring on the ground that empties as the power runs out. */
function ringMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFrac: { value: 1 }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xz; // the ring lies flat
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFrac, uTime;
      varying vec2 vP;
      ${HSV_GLSL}
      void main() {
        float a = fract(atan(vP.x, vP.y) / 6.2831853 + 1.0);
        if (a > uFrac) discard;
        gl_FragColor = vec4(hue(fract(a * 2.0 - uTime * 0.8)) * 1.3, 0.9);
        #include <colorspace_fragment>
      }
    `,
  });
}

interface Runner {
  slot: number;
  id: number;
  color: string;
  /** Lane centre x (eases towards its place). */
  laneX: number;
  /** Sideways offset in the lane, -1..1. */
  off: number;
  lift: number;
  air: boolean;
  duck: boolean;
  squash: number;
  /** Own home position (only without p.motion). */
  homeX: number | null;
  jumpUntil: number;
  /** Camera-space crop around the player for the card (smoothed). */
  hs: number;
  floor: number;
  cx: number;
  powerUntil: number;
  hurtUntil: number;
  wobble: number;
  streak: number;
  coins: number;
  hits: number;
  lastSeen: number;
  hasCutout: boolean;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mat: THREE.ShaderMaterial;
  card: THREE.Mesh;
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
}

const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H).translate(0, CARD_H / 2, 0);
const ringGeo = new THREE.RingGeometry(0.95, 1.12, 64).rotateX(-Math.PI / 2);
const runners = new Map<number, Runner>();
/** Slots in lane order, left to right. */
let laneOrder: number[] = [];

function makeRunner(p: Player): Runner {
  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH;
  const g = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const mat = cardMaterial(tex, p.color);
  const card = new THREE.Mesh(cardGeo, mat);
  card.renderOrder = 2;
  scene.add(card);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.7), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 1;
  scene.add(shadow);
  const ring = new THREE.Mesh(ringGeo, ringMaterial());
  ring.renderOrder = 1;
  ring.visible = false;
  scene.add(ring);
  return {
    slot: p.slot,
    id: p.id,
    color: p.color,
    laneX: 0,
    off: 0,
    lift: 0,
    air: false,
    duck: false,
    squash: 0,
    homeX: null,
    jumpUntil: 0,
    hs: 0,
    floor: 0,
    cx: 0.5,
    powerUntil: 0,
    hurtUntil: 0,
    wobble: 0,
    streak: 0,
    coins: 0,
    hits: 0,
    lastSeen: performance.now(),
    hasCutout: false,
    canvas,
    g,
    tex,
    mat,
    card,
    shadow,
    ring,
  };
}

function removeRunner(r: Runner) {
  for (const o of [r.card, r.shadow, r.ring]) o.removeFromParent();
  r.tex.dispose();
  r.mat.dispose();
  runners.delete(r.slot);
  laneOrder = laneOrder.filter((s) => s !== r.slot);
  for (const row of rows) {
    const it = row.lanes.get(r.slot);
    if (it) {
      it.group.removeFromParent();
      row.lanes.delete(r.slot);
    }
  }
}

/** Where the camera sees a player (before the SDK's layout). */
const camSpace = (p: Player) => p.raw ?? p;
/** ?legacy=1: ignore the newer optional Player fields (jump, motion, crouchDepth, leanAngle), to test the fallbacks. */
const LEGACY = new URLSearchParams(location.search).has('legacy');

function torsoOf(k: Keypoint[], aspect: number): number | null {
  const ok = (i: number) => k[i].score >= MIN_SCORE;
  if (!ok(KP.leftShoulder) || !ok(KP.rightShoulder) || !ok(KP.leftHip) || !ok(KP.rightHip)) return null;
  const sx = (k[KP.leftShoulder].x + k[KP.rightShoulder].x) / 2;
  const sy = (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2;
  const hx = (k[KP.leftHip].x + k[KP.rightHip].x) / 2;
  const hy = (k[KP.leftHip].y + k[KP.rightHip].y) / 2;
  return Math.hypot((sx - hx) * aspect, sy - hy);
}

/** Read the body: sideways offset, jump, duck; and keep the card's crop on them. */
function updateRunner(r: Runner, p: Player, now: number, dt: number) {
  const raw = camSpace(p);
  const k = raw.keypoints;
  const A = game.frame.aspect;
  r.lastSeen = now;
  r.color = p.color;
  (r.mat.uniforms.uColor.value as THREE.Color).set(p.color);

  // Jump: the tracker's airborne state, else the jump event plus a short air time.
  const jump = LEGACY ? undefined : p.jump;
  const airborne = jump ? jump.airborne : now < r.jumpUntil;
  const depth = (LEGACY ? undefined : p.pose.crouchDepth) ?? (p.pose.crouching ? 1 : 0);
  r.duck = p.pose.crouching || depth > 0.4;
  r.lift += ((airborne ? JUMP_LIFT : 0) - r.lift) * Math.min(1, dt * (airborne ? 16 : 9));
  r.air = airborne || r.lift > JUMP_LIFT * 0.45;
  r.squash += ((r.duck ? Math.max(0.6, depth) : 0) - r.squash) * Math.min(1, dt * 14);

  // Crop size from the torso (grows quickly, shrinks slowly; not while bent or jumping).
  const torso = torsoOf(k, A);
  if (torso && !r.duck && !airborne) {
    const hs = torso * 3.25;
    if (!r.hs) r.hs = hs;
    else r.hs += (hs - r.hs) * Math.min(1, dt * (hs > r.hs ? 6 : 0.4));
  }
  if (!r.hs) r.hs = Math.max(0.3, raw.bbox.h);
  // Floor: the lower ankle (or from the hips), following down quickly and up slowly.
  const ankles = [KP.leftAnkle, KP.rightAnkle].filter((i) => k[i].score >= MIN_SCORE).map((i) => k[i].y);
  const hipY = (k[KP.leftHip].y + k[KP.rightHip].y) / 2;
  const f = ankles.length ? Math.max(...ankles) : hipY + r.hs * 0.5;
  if (!r.floor) r.floor = f;
  else if (!airborne) r.floor += (f - r.floor) * Math.min(1, dt * (f > r.floor ? 10 : 1));
  r.cx += (raw.center.x - r.cx) * Math.min(1, dt * 20);

  // Sideways: how far they've stepped from home (torso lengths), plus leaning.
  let drift: number;
  if (p.motion && !LEGACY) drift = p.motion.drift.x;
  else {
    r.homeX ??= raw.center.x;
    r.homeX += (raw.center.x - r.homeX) * Math.min(1, dt / 4);
    drift = ((raw.center.x - r.homeX) * A) / Math.max(0.05, torso ?? r.hs / 3.25);
  }
  const lean = (LEGACY ? undefined : p.pose.leanAngle) ?? p.pose.lean * 0.3;
  let want = (drift + lean * 1.6) / 0.75;
  if (Math.abs(want) < 0.1) want = 0;
  want = Math.max(-1, Math.min(1, want));
  r.off += (want - r.off) * Math.min(1, dt * 10);
}

/** The cut-out that belongs to this player: by id from the tracker, else nearest torso. */
function cutoutFor(seg: Segmentation | null, p: Player): Cutout | null {
  if (!seg) return null;
  const byId = seg.people.find((c) => c.player === p.id);
  if (byId) return byId;
  const c0 = camSpace(p).center;
  let best: Cutout | null = null;
  let bestD = 0.15;
  for (const c of seg.people) {
    if ((c.player ?? -1) >= 0 || !c.anchor) continue;
    const d = Math.hypot((1 - c.anchor.x - c0.x) * game.frame.aspect, c.anchor.y - c0.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

const STICK: [number, number][] = [
  [KP.leftShoulder, KP.rightShoulder], [KP.leftShoulder, KP.leftElbow], [KP.leftElbow, KP.leftWrist],
  [KP.rightShoulder, KP.rightElbow], [KP.rightElbow, KP.rightWrist], [KP.leftShoulder, KP.leftHip],
  [KP.rightShoulder, KP.rightHip], [KP.leftHip, KP.rightHip], [KP.leftHip, KP.leftKnee],
  [KP.leftKnee, KP.leftAnkle], [KP.rightHip, KP.rightKnee], [KP.rightKnee, KP.rightAnkle],
];

/**
 * Paint the card: a window around the player in camera space, WINDOW × their standing height
 * tall with their feet at the bottom, so everyone fills their card the same (normalised).
 * Mirrored like the screen. The cut-out if there is one, else a glowing stick figure.
 */
function paintCard(r: Runner, p: Player, seg: Segmentation | null) {
  const g = r.g;
  const raw = camSpace(p);
  const A = game.frame.aspect;
  const wh = r.hs * WINDOW;
  const ww = (wh * (TW / TH)) / A; // in frame widths
  const left = r.cx - ww / 2;
  const top = r.floor + r.hs * 0.03 - wh;
  const X = (x: number) => ((x - left) / ww) * TW;
  const Y = (y: number) => ((y - top) / wh) * TH;
  g.clearRect(0, 0, TW, TH);
  const c = cutoutFor(seg, p);
  r.hasCutout = !!c;
  if (c) {
    // Keep the picture on them between cut-outs (~10 a second).
    const dx = c.anchor ? raw.center.x - (1 - c.anchor.x) : 0;
    const dy = c.anchor ? raw.center.y - c.anchor.y : 0;
    const xl = X(1 - c.box.x1 + dx);
    const xr = X(1 - c.box.x0 + dx);
    const yt = Y(c.box.y0 + dy);
    const yb = Y(c.box.y1 + dy);
    g.save();
    g.translate(xr, yt); // un-mirrored picture -> mirrored, like the screen
    g.scale(-1, 1);
    g.drawImage(c.image, 0, 0, xr - xl, yb - yt);
    g.restore();
  } else {
    const k = raw.keypoints;
    const ok = (i: number) => k[i].score >= MIN_SCORE;
    const pt = (i: number) => [X(k[i].x), Y(k[i].y)] as const;
    const lw = TH * 0.055;
    g.lineCap = g.lineJoin = 'round';
    for (const [col, w, blur] of [[p.color, lw, 14], ['#ffffff', lw * 0.38, 0]] as const) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.shadowColor = p.color;
      g.shadowBlur = blur;
      g.beginPath();
      for (const [a, b] of STICK) {
        if (!ok(a) || !ok(b)) continue;
        g.moveTo(...pt(a));
        g.lineTo(...pt(b));
      }
      g.stroke();
    }
    if (ok(KP.nose)) {
      const [nx, ny] = pt(KP.nose);
      const rad = (r.hs / wh) * TH * 0.075;
      g.shadowBlur = 14;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(nx, ny - rad * 0.3, rad, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#fff';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.arc(nx + s * rad * 0.38, ny - rad * 0.4, rad * 0.2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.shadowBlur = 0;
  }
  r.tex.needsUpdate = true;
}

/** Place the card, its shadow and ring in the world. */
function poseRunner(r: Runner, now: number, dt: number) {
  const x = r.laneX + r.off * SIDE;
  r.card.position.set(x, r.lift, 0);
  // Upright, turned (about the vertical only) to face the camera.
  r.card.rotation.set(0, Math.atan2(camera.position.x - x, camera.position.z), 0);
  r.wobble *= Math.exp(-dt * 3);
  r.card.rotation.z = Math.sin(now / 45) * 0.35 * r.wobble;
  r.card.scale.set(1 + 0.12 * r.squash, 1 - 0.3 * r.squash, 1);
  r.shadow.position.set(x, 0.02, 0.15);
  const s = 1 - 0.45 * (r.lift / JUMP_LIFT);
  r.shadow.scale.set(s, s, 1);
  const u = r.mat.uniforms;
  u.uTime.value = now / 1000;
  const power = Math.max(0, (r.powerUntil - now) / 1000);
  // Fades in fast, and flickers off over the last second as a warning.
  const target = power <= 0 ? 0 : power < 1 ? (Math.sin(now / 50) > 0 ? 1 : 0.3) : 1;
  u.uPower.value += (target - u.uPower.value) * Math.min(1, dt * 12);
  u.uFlash.value = Math.max(0, u.uFlash.value - dt * 2.5);
  u.uOpacity.value = now < r.hurtUntil && Math.sin(now / 60) > 0.2 ? 0.35 : 1;
  r.ring.visible = power > 0;
  if (power > 0) {
    r.ring.position.set(x, 0.03, 0.1);
    const ru = (r.ring.material as THREE.ShaderMaterial).uniforms;
    ru.uFrac.value = power / POWER_S;
    ru.uTime.value = now / 1000;
    // Sparkle trail.
    if (Math.random() < dt * 30) {
      sparkle(v3(x + (Math.random() - 0.5) * CARD_W * 0.8, r.lift + Math.random() * CARD_H * 0.85, 0.2), new THREE.Color().setHSL(Math.random(), 1, 0.6));
    }
  }
}

/** Lanes left to right as players stand (re-sorted only outside play, so lanes stay put). */
function syncRunners(now: number, dt: number) {
  const players = game.frame.players;
  for (const p of players) {
    let r = runners.get(p.slot);
    if (!r) {
      r = makeRunner(p);
      runners.set(p.slot, r);
    }
    if (r.id !== p.id) {
      // Someone new took over this slot: start their crop afresh.
      r.id = p.id;
      r.hs = r.floor = 0;
      r.homeX = null;
    }
    updateRunner(r, p, now, dt);
  }
  for (const r of [...runners.values()]) if (now - r.lastSeen > 2500) removeRunner(r);
  const inPlay = flow.state === 'playing' || flow.state === 'countdown';
  const xOf = (s: number) => {
    const p = players.find((q) => q.slot === s);
    return p ? camSpace(p).center.x : 0.5;
  };
  if (!inPlay) laneOrder = [...runners.keys()].sort((a, b) => xOf(a) - xOf(b));
  else {
    // Keep the order; a newcomer slots in where they stand.
    for (const s of runners.keys()) {
      if (laneOrder.includes(s)) continue;
      const i = laneOrder.findIndex((o) => xOf(o) > xOf(s));
      if (i < 0) laneOrder.push(s);
      else laneOrder.splice(i, 0, s);
    }
  }
  const n = laneOrder.length;
  laneOrder.forEach((s, i) => {
    const r = runners.get(s)!;
    const want = (i - (n - 1) / 2) * LANE_W;
    r.laneX += (want - r.laneX) * Math.min(1, dt * 4);
  });
  paths.forEach((m, i) => {
    const r = runners.get(laneOrder[i]);
    m.visible = !!r;
    if (r) m.position.x = r.laneX;
  });
}

// ---------- obstacles ----------

type Kind = 'wall' | 'bar' | 'left' | 'right' | 'coins' | 'qblock' | 'star';
interface Spec {
  kind: Kind;
  /** -1..1: which side (coins, star). */
  sub: number;
  pipe?: boolean;
  /** Coins along with the obstacle: lateral -1..1, height, z offset. */
  coins: { x: number; y: number; dz: number }[];
}
interface Coin {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  dz: number;
  taken: boolean;
}
interface LaneItem {
  group: THREE.Group;
  state: 'pending' | 'cleared' | 'hit' | 'knocked' | 'missed' | 'taken';
  satisfied: boolean;
  coins: Coin[];
  /** Knocked flying by a powered-up player. */
  vel?: V3;
  spin?: V3;
  block?: THREE.Mesh;
}
interface Row {
  z: number;
  spec: Spec;
  lanes: Map<number, LaneItem>;
}
let rows: Row[] = [];

const HAZARDS: Kind[] = ['wall', 'bar', 'left', 'right'];
const isHazard = (k: Kind) => HAZARDS.includes(k);

function addBlock(g: THREE.Group, x: number, y: number, mat: THREE.Material = brickMat): THREE.Mesh {
  const m = new THREE.Mesh(blockGeo, mat);
  m.position.set(x, y, 0);
  g.add(m);
  return m;
}

function addPipe(g: THREE.Group, x: number, h: number) {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, h - 0.35, 28), pipeMat);
  body.position.set(x, (h - 0.35) / 2, 0);
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.35, 28), pipeMat);
  lip.position.set(x, h - 0.175, 0);
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), pipeDark);
  hole.rotation.x = -Math.PI / 2;
  hole.position.set(x, h + 0.005, 0);
  g.add(body, lip, hole);
}

/** Build one lane's copy of a row. */
function buildItem(spec: Spec): LaneItem {
  const g = new THREE.Group();
  const it: LaneItem = { group: g, state: 'pending', satisfied: false, coins: [] };
  const B = BLOCK;
  switch (spec.kind) {
    case 'wall':
      for (const x of [-B, 0, B]) addBlock(g, x, B / 2);
      break;
    case 'bar':
      for (const x of [-B, 0, B]) addBlock(g, x, 1.32 + B / 2);
      // Little posts at the ends so it doesn't look like it's falling.
      for (const x of [-1.5 * B - 0.06, 1.5 * B + 0.06]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.32 + B, 0.1), new THREE.MeshLambertMaterial({ color: 0x8a5a2b }));
        post.position.set(x, (1.32 + B) / 2, 0);
        g.add(post);
      }
      break;
    case 'left':
    case 'right': {
      const s = spec.kind === 'left' ? -1 : 1;
      if (spec.pipe) addPipe(g, s * 0.7, 1.9);
      else for (const x of [s * 1.0, s * 0.28]) for (let j = 0; j < 3; j++) addBlock(g, x, B / 2 + j * B);
      break;
    }
    case 'qblock':
      it.block = addBlock(g, 0, Q_Y + B / 2, qMat);
      break;
    case 'star': {
      const st = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, transparent: true }));
      st.scale.set(0.95, 0.95, 1);
      st.position.set(spec.sub * SIDE, 1.15, 0);
      st.name = 'star';
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.set(1.5, 1.5, 1);
      glow.position.copy(st.position);
      glow.name = 'glow';
      g.add(glow, st);
      break;
    }
    case 'coins':
      break;
  }
  for (const c of spec.coins) {
    const mesh = new THREE.Mesh(coinGeo, coinMat);
    mesh.position.set(c.x * SIDE, c.y, c.dz);
    g.add(mesh);
    it.coins.push({ mesh, x: c.x * SIDE, y: c.y, dz: c.dz, taken: false });
  }
  scene.add(g);
  return it;
}

let rng = Math.random;
const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];

/** The next row, the same for every lane. */
function nextSpec(t: number, star: boolean): Spec {
  if (star) return { kind: 'star', sub: STAR_FIRST && !stats.stars ? 0 : pick([-1, 0, 1]), coins: [] };
  const kinds: [Kind, number][] = [
    ['wall', 3],
    ['left', 2],
    ['right', 2],
    ['coins', 1.5],
    ['qblock', t > 5 ? 1 : 0],
    ['bar', t > 8 ? 3 : 0],
  ];
  let total = kinds.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  let kind: Kind = 'wall';
  for (const [k, w] of kinds) {
    if ((roll -= w) < 0) {
      kind = k;
      break;
    }
  }
  const spec: Spec = { kind, sub: 0, coins: [] };
  if (kind === 'left' || kind === 'right') {
    spec.pipe = rng() < 0.4;
    const free = kind === 'left' ? 1 : -1;
    spec.coins.push({ x: free, y: 0.75, dz: 0 }); // a coin for the side you should be on
  } else if (kind === 'wall') {
    if (rng() < 0.5) spec.coins.push({ x: 0, y: 1.7, dz: 0 }); // over the wall: jump for it
  } else if (kind === 'coins') {
    spec.sub = pick([-1, 0, 1]);
    const high = rng() < 0.3;
    for (let i = 0; i < 4; i++) spec.coins.push({ x: spec.sub, y: high ? 1.2 + 0.5 * Math.sin((i / 3) * Math.PI) : 0.75, dz: i * 1.3 });
  }
  return spec;
}

function spawnRow(spec: Spec) {
  const row: Row = { z: SPAWN_Z, spec, lanes: new Map() };
  for (const s of laneOrder) row.lanes.set(s, buildItem(spec));
  rows.push(row);
  lastSpawned = spec.kind;
}

// ---------- effects ----------

interface Spark {
  s: THREE.Sprite;
  v: V3;
  age: number;
  life: number;
}
const sparks: Spark[] = [];
const sparkPool: THREE.Sprite[] = [];
function sparkle(at: V3, color: THREE.Color, v = v3((Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.8, 0.2 + Math.random() * 0.5), size = 0.32, life = 0.8) {
  const s = sparkPool.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkleTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  (s.material as THREE.SpriteMaterial).color.copy(color);
  s.position.copy(at);
  s.scale.set(size, size, 1);
  s.renderOrder = 3;
  scene.add(s);
  sparks.push({ s, v, age: 0, life });
}
function burst(at: V3, n: number, rainbow: boolean, color = new THREE.Color('#ffd23f')) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 2 + Math.random() * 3;
    sparkle(at, rainbow ? new THREE.Color().setHSL(Math.random(), 1, 0.6) : color, v3(Math.cos(a) * sp, 1.5 + Math.random() * 3, Math.sin(a) * sp * 0.5), 0.4, 0.7);
  }
}

interface Pop {
  text: string;
  color: string;
  at: number;
  pos: V3;
  size: number;
}
let pops: Pop[] = [];
function pop(text: string, color: string, pos: V3, size = 1) {
  pops.push({ text, color, at: performance.now(), pos: pos.clone(), size });
}

/** Coins popping out of "?" blocks. */
let flyingCoins: { m: THREE.Mesh; t: number }[] = [];

function sfxCoin() {
  blip(988, 70, 'square', 0.1);
  setTimeout(() => blip(1319, 170, 'square', 0.1), 70);
}
function sfxBump() {
  noise(180, 0.35);
  blip(200, 240, 'sawtooth', 0.14, 80);
}
function sfxStar() {
  [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => blip(f, 110, 'triangle', 0.16), i * 75));
}
function sfxKnock() {
  blip(330, 100, 'square', 0.14, 900);
  noise(90, 0.2);
}

// ---------- the rules ----------

/** Has this runner avoided this hazard (right now)? */
function avoids(r: Runner, kind: Kind): boolean {
  const x = r.off * SIDE; // lane-relative
  switch (kind) {
    case 'wall':
      return r.air;
    case 'bar':
      return r.duck;
    case 'left':
      return x - BODY > 0.06;
    case 'right':
      return x + BODY < -0.06;
    default:
      return true;
  }
}

let speed = 3;
let nextRowAt = 0;
let nextStarAt = 0;
let lastSpawned: Kind = 'wall';
let startedAt = 0;
let saidStarAt = 0;
let stats = { rows: 0, cleared: 0, hits: 0, knocked: 0, coins: 0, stars: 0, qblocks: 0 };

function score(r: Runner, pts: number, text: string, color: string, at: V3, size = 0.8) {
  if (!flow.playing) return;
  flow.addScore(r.slot, pts);
  pop(text, color, at, size);
}

function updateRows(dt: number, now: number) {
  const t = flow.elapsed;
  const grace = speed * 0.14;
  const half = BLOCK / 2;
  for (const row of rows) {
    row.z -= speed * dt;
    for (const [slot, it] of row.lanes) {
      const r = runners.get(slot);
      if (it.vel) {
        // Knocked flying.
        it.vel.y -= 14 * dt;
        it.group.position.addScaledVector(it.vel, dt);
        it.group.rotation.x += it.spin!.x * dt;
        it.group.rotation.z += it.spin!.z * dt;
        continue;
      }
      it.group.position.set(r ? r.laneX : it.group.position.x, 0, row.z);
      if (!r || !flow.playing) continue; // only while playing (rows drift on behind the results)
      const lx = r.off * SIDE;
      const kind = row.spec.kind;
      // Hazards: avoided at any moment while passing -> cleared; else bump (or knock it away).
      if (isHazard(kind) && it.state === 'pending') {
        if (row.z < half + grace && avoids(r, kind)) it.satisfied = true;
        if (row.z <= -speed * 0.06) {
          const top = v3(r.card.position.x, CARD_H + 0.3 + r.lift, 0);
          if (it.satisfied) {
            it.state = 'cleared';
            r.streak++;
            stats.cleared++;
            score(r, 1, r.streak >= 5 && r.streak % 5 === 0 ? `${r.streak} in a row!` : '+1', '#ffffff', top, r.streak % 5 === 0 ? 1 : 0.7);
          } else if (now < r.powerUntil) {
            it.state = 'knocked';
            it.vel = v3((Math.random() - 0.5) * 6, 7 + Math.random() * 3, -9 - Math.random() * 4);
            it.spin = v3((Math.random() - 0.5) * 12, 0, (Math.random() - 0.5) * 12);
            stats.knocked++;
            sfxKnock();
            burst(v3(r.card.position.x, 1, 0.3), 14, true);
            score(r, 2, 'POW! +2', '#ffe14d', top, 1);
          } else if (now < r.hurtUntil) {
            it.state = 'missed'; // still blinking from the last bump
          } else {
            it.state = 'hit';
            r.hits++;
            r.streak = 0;
            r.hurtUntil = now + HURT_S * 1000;
            r.wobble = 1;
            r.mat.uniforms.uFlash.value = 1;
            stats.hits++;
            sfxBump();
            burst(v3(r.card.position.x, 0.9, 0.3), 10, false, new THREE.Color('#ff8a5c'));
            score(r, -1, 'Bump! -1', '#ff6b6b', top, 1);
          }
        }
      }
      // Coins.
      for (const c of it.coins) {
        if (c.taken) continue;
        c.mesh.rotation.y = now / 220 + c.dz;
        const cz = row.z + c.dz;
        if (Math.abs(cz) < 0.35 + grace * 0.5 && Math.abs(lx - c.x) < 0.55 && (c.y < 1.3 || r.air)) {
          c.taken = true;
          c.mesh.visible = false;
          r.coins++;
          stats.coins++;
          sfxCoin();
          burst(v3(r.card.position.x, c.y + r.lift * 0.3, 0.2), 6, false);
          score(r, 1, '+1', '#ffd23f', v3(r.card.position.x, CARD_H + 0.2 + r.lift, 0), 0.7);
        }
      }
      // "?" block: jump into it.
      if (kind === 'qblock' && it.state === 'pending' && Math.abs(row.z) < 0.55 + grace * 0.5 && r.air && Math.abs(lx) < 0.8) {
        it.state = 'taken';
        it.block!.material = usedMat;
        it.block!.position.y += 0.15;
        stats.qblocks++;
        sfxCoin();
        blip(520, 60, 'square', 0.12);
        const m = new THREE.Mesh(coinGeo, coinMat);
        m.position.set(r.card.position.x, Q_Y + BLOCK, 0.3);
        scene.add(m);
        flyingCoins.push({ m, t: 0 });
        score(r, 3, '+3', '#ffd23f', v3(r.card.position.x, Q_Y + 1.1, 0), 1);
      }
      if (kind === 'qblock' && it.state === 'taken' && it.block!.position.y > Q_Y + BLOCK / 2) {
        it.block!.position.y = Math.max(Q_Y + BLOCK / 2, it.block!.position.y - dt * 0.8);
      }
      // The star.
      if (kind === 'star') {
        const st = it.group.getObjectByName('star') as THREE.Sprite | undefined;
        const glow = it.group.getObjectByName('glow') as THREE.Sprite | undefined;
        if (st && glow) {
          st.position.y = 1.15 + Math.sin(now / 200) * 0.12;
          (st.material as THREE.SpriteMaterial).rotation = Math.sin(now / 300) * 0.3;
          glow.position.y = st.position.y;
          (glow.material as THREE.SpriteMaterial).color.setHSL((now / 1500) % 1, 1, 0.6);
          if (Math.random() < dt * 12) sparkle(st.position.clone().add(it.group.position).add(v3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 0)), new THREE.Color().setHSL(Math.random(), 1, 0.65), undefined, 0.25, 0.6);
        }
        if (it.state === 'pending' && Math.abs(row.z) < 0.6 + grace * 0.5 && Math.abs(lx - row.spec.sub * SIDE) < 0.62) {
          it.state = 'taken';
          it.group.visible = false;
          r.powerUntil = now + POWER_S * 1000;
          r.hurtUntil = 0;
          stats.stars++;
          sfxStar();
          burst(v3(r.card.position.x, 1.2, 0.3), 30, true);
          score(r, 3, 'STAR! +3', '#ffffff', v3(r.card.position.x, CARD_H + 0.6, 0), 0.9);
          if (now - saidStarAt > 3000) {
            saidStarAt = now;
            say('Rainbow star!', { interrupt: true });
          }
        }
      }
    }
  }
  // Gone behind the players (or flown off): remove.
  rows = rows.filter((row) => {
    let alive = row.z > END_Z;
    for (const it of row.lanes.values()) if (it.vel && it.group.position.y > -5) alive = true;
    if (!alive) for (const it of row.lanes.values()) it.group.removeFromParent();
    return alive;
  });
  // Spawning.
  if (flow.playing && t >= nextRowAt) {
    const starDue = t >= nextStarAt && isHazard(lastSpawned) === false ? true : t >= nextStarAt + 3;
    spawnRow(nextSpec(t, starDue));
    stats.rows++;
    if (starDue) nextStarAt = t + 16 + Math.random() * 10;
    nextRowAt = t + gapAt(t) * (lastSpawned === 'coins' ? 1.4 : 1);
  }
}

function clearRows() {
  for (const row of rows) for (const it of row.lanes.values()) it.group.removeFromParent();
  rows = [];
}

// ---------- scenery at the sides ----------

interface Prop {
  o: THREE.Object3D;
  side: number;
  dist: number;
}
const props: Prop[] = [];
{
  const bushMat = new THREE.SpriteMaterial({ map: bushTex, transparent: true });
  for (let i = 0; i < 26; i++) {
    const side = i % 2 ? 1 : -1;
    const r = Math.random();
    let o: THREE.Object3D;
    if (r < 0.55) {
      const s = new THREE.Sprite(bushMat);
      const k = 1.1 + Math.random() * 1.2;
      s.scale.set(k, k, 1);
      s.center.set(0.5, 0.12);
      o = s;
    } else if (r < 0.75) {
      const g = new THREE.Group();
      addPipe(g, 0, 1 + Math.random() * 1.6);
      o = g;
    } else {
      const g = new THREE.Group();
      const n = 1 + Math.floor(Math.random() * 3);
      const y = 2 + Math.random() * 1.5;
      for (let j = 0; j < n; j++) addBlock(g, j * BLOCK, y, j === 1 || n === 1 ? qMat : brickMat);
      o = g;
    }
    o.position.z = SPAWN_Z - (i / 26) * (SPAWN_Z - END_Z);
    scene.add(o);
    props.push({ o, side, dist: 1.2 + Math.random() * 7 });
  }
}
function updateProps(dt: number) {
  const half = (Math.max(1, laneOrder.length) * LANE_W) / 2;
  for (const p of props) {
    p.o.position.z -= speed * dt;
    if (p.o.position.z < END_Z) p.o.position.z += SPAWN_Z - END_Z;
    p.o.position.x = p.side * (half + p.dist);
  }
}

// ---------- round ----------

prepareSpeech(['Block Dash! Step aside, jump and duck to dodge the blocks!', 'Rainbow star!']);

flow.on('start', () => {
  clearRows();
  for (const r of runners.values()) {
    r.powerUntil = r.hurtUntil = 0;
    r.streak = r.coins = r.hits = 0;
  }
  rng = Math.random;
  nextRowAt = 1.2;
  nextStarAt = STAR_FIRST ?? 9 + Math.random() * 4;
  stats = { rows: 0, cleared: 0, hits: 0, knocked: 0, coins: 0, stars: 0, qblocks: 0 };
  startedAt = performance.now();
  say('Block Dash! Step aside, jump and duck to dodge the blocks!');
});
flow.on('end', () => {
  for (const r of runners.values()) r.powerUntil = 0;
});

game.on('jump', (e) => {
  const r = runners.get(e.slot);
  if (!r) return;
  r.jumpUntil = performance.now() + JUMP_FALLBACK_MS;
  if (flow.playing) blip(380, 170, 'square', 0.05, 760);
});

// ---------- camera ----------

const CAM = v3(2.2, 3.6, 7.6);
const LOOK = v3(0, 0.7, 2.0);

const camPos = v3(3, 4.5, 10);
const camLook = v3(0, 1, 2);
/** ?cam=x,y,z,lx,ly,lz[,fov] overrides the camera for one player (tuning). */
const camOverride = new URLSearchParams(location.search).get('cam')?.split(',').map(Number) ?? null;
if (camOverride?.[6]) {
  camera.fov = camOverride[6];
  camera.updateProjectionMatrix();
}
function placeCamera(dt: number) {
  const n = Math.max(1, laneOrder.length);
  const span = n * LANE_W;
  const o = camOverride ?? [CAM.x, CAM.y, CAM.z, LOOK.x, LOOK.y, LOOK.z];
  // In front of the players and above, a little to the side: a 3/4 view of their fronts.
  // Pulled back for more lanes so everyone fits.
  const back = (span - LANE_W) * 0.5;
  const want = v3(o[0] + span * 0.15, o[1] + back * 0.45, o[2] + back * 1.1);
  const look = v3(o[3], o[4], o[5] + back * 0.25);
  const k = Math.min(1, dt * 2);
  camPos.lerp(want, k);
  camLook.lerp(look, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ---------- HUD ----------

let W = 1;
let H = 1;
function toScreen(p: V3): { x: number; y: number; z: number } {
  const q = p.clone().project(camera);
  return { x: (q.x + 1) * 0.5 * W, y: (1 - q.y) * 0.5 * H, z: q.z };
}

function drawHud(now: number) {
  for (const pp of pops) {
    const age = (now - pp.at) / 1200;
    const s = toScreen(pp.pos);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age * age);
    drawText(ctx, pp.text, s.x, Math.max(H * 0.15, s.y) - age * H * 0.06, (H / 22) * pp.size, pp.color);
    ctx.restore();
  }
  pops = pops.filter((pp) => now - pp.at < 1200);
  // Star timer over powered players.
  for (const r of runners.values()) {
    const left = (r.powerUntil - now) / 1000;
    if (left <= 0) continue;
    const s = toScreen(v3(r.card.position.x, r.lift + CARD_H + 0.15, 0));
    drawText(ctx, `★ ${Math.ceil(left)}`, s.x, s.y, H / 26, `hsl(${(now / 4) % 360} 100% 70%)`);
  }
  if (flow.state === 'playing' && now - startedAt < 7000) {
    drawText(ctx, 'Step aside · Jump over walls · Duck under bars', W / 2, H * 0.9, Math.min(H / 24, W / 36));
  }
}

// ---------- main loop ----------

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = stage.resize());
  fitCanvas(hud, ctx);
  flow.update(now);
  syncRunners(now, dt);

  const want = flow.playing ? speedAt(flow.elapsed) : game.paused || flow.state === 'countdown' ? 0 : flow.state === 'playing' ? 0 : 3;
  speed += (want - speed) * Math.min(1, dt * 3);
  grassTex.offset.y -= (speed * dt) / GRASS_TILE;
  pathTex.offset.y -= (speed * dt) / PATH_W;
  updateRows(dt, now);
  updateProps(dt);

  placeCamera(dt);
  const seg = game.segmentation();
  for (const r of runners.values()) {
    const p = game.frame.players.find((q) => q.slot === r.slot);
    if (p) paintCard(r, p, seg);
    poseRunner(r, now, dt);
  }
  for (const sp of sparks) {
    sp.age += dt;
    sp.v.y -= 2 * dt;
    sp.s.position.addScaledVector(sp.v, dt);
    (sp.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - sp.age / sp.life);
    (sp.s.material as THREE.SpriteMaterial).rotation += dt * 3;
  }
  for (const sp of sparks.filter((x) => x.age >= x.life)) {
    sp.s.removeFromParent();
    sparkPool.push(sp.s);
  }
  for (let i = sparks.length - 1; i >= 0; i--) if (sparks[i].age >= sparks[i].life) sparks.splice(i, 1);
  for (const fc of flyingCoins) {
    fc.t += dt;
    fc.m.position.y += dt * (3.5 - fc.t * 6);
    fc.m.rotation.y += dt * 14;
    if (fc.t > 0.7) fc.m.removeFromParent();
  }
  flyingCoins = flyingCoins.filter((fc) => fc.t <= 0.7);

  renderer.render(scene, camera);
  ctx.clearRect(0, 0, W, H);
  drawHud(now);
  flow.drawOverlay(ctx, W, H);
  requestAnimationFrame(loop);
}

// Read-only peek for automated tests and debugging.
(window as unknown as { runner: () => object }).runner = () => ({
  state: flow.state,
  elapsed: +flow.elapsed.toFixed(2),
  scores: flow.scores,
  speed: +speed.toFixed(2),
  stats,
  laneOrder,
  cutouts: game.segmentation()?.people.length ?? 0,
  runners: [...runners.values()].map((r) => ({
    slot: r.slot,
    id: r.id,
    laneX: +r.laneX.toFixed(2),
    off: +r.off.toFixed(2),
    lift: +r.lift.toFixed(2),
    air: r.air,
    duck: r.duck,
    power: Math.max(0, +((r.powerUntil - performance.now()) / 1000).toFixed(1)),
    hurt: performance.now() < r.hurtUntil,
    streak: r.streak,
    coins: r.coins,
    hits: r.hits,
    cutout: r.hasCutout,
    hs: +r.hs.toFixed(3),
  })),
  rows: rows.map((row) => ({
    kind: row.spec.kind,
    z: +row.z.toFixed(2),
    sub: row.spec.sub,
    lanes: Object.fromEntries([...row.lanes].map(([s, it]) => [s, it.state])),
  })),
  players: game.frame.players.map((p) => ({
    slot: p.slot,
    airborne: p.jump?.airborne ?? null,
    crouching: p.pose.crouching,
    crouchDepth: p.pose.crouchDepth ?? null,
    drift: p.motion?.drift.x ?? null,
    lean: p.pose.leanAngle ?? p.pose.lean,
  })),
  camera: camera.position.toArray().map((v) => +v.toFixed(2)),
  size: [W, H],
});

requestAnimationFrame(loop);
