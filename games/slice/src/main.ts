/**
 * Fruit Swipe — fruit flies up, fast hands slice it. Each player scores in their
 * own colour. Bombs cost points. 60-second rounds.
 *
 * The lobby, countdown, timer, scores, pause and results screens all come from
 * the SDK's RoundFlow — this file is only the fruit.
 *
 * Artwork: art/generate.py (Gemini) -> public/art. Each fruit has a whole sprite and
 * a cut-face "-half" sprite; a sliced fruit flies apart as two cut halves.
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
  screenMapper,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

/** Hand speed needed to slice, in frame-heights per second. */
const SLICE_SPEED = 0.9;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame();
const flow = new RoundFlow(game, { title: 'Fruit Swipe', seconds: 60 });

const FRUITS = [
  { name: 'watermelon', juice: '#ff4d6d', size: 1.3 },
  { name: 'orange', juice: '#ff9f1c', size: 0.9 },
  { name: 'apple', juice: '#fff1d6', size: 0.85 },
  { name: 'lemon', juice: '#ffe14d', size: 0.8 },
  { name: 'plum', juice: '#ffb347', size: 0.7 },
] as const;
type FruitKind = (typeof FRUITS)[number];

const assets = await loadAssets({
  images: {
    background: 'art/background.jpg',
    bomb: 'art/bomb.png',
    ...Object.fromEntries(FRUITS.flatMap((f) => [[f.name, `art/${f.name}.png`], [`${f.name}-half`, `art/${f.name}-half.png`]])),
  },
});
/** Sprites are cut out with a little margin: draw them this much bigger than the hit circle. */
const SPRITE = 2.25;

interface Thing {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  spin: number;
  kind: FruitKind | 'bomb';
  dead: boolean;
}
interface Half {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  spin: number;
  kind: FruitKind;
  life: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}
/** Juice that splats on the scenery and fades. */
interface Splat {
  x: number;
  y: number;
  r: number;
  color: string;
  life: number;
  blobs: { dx: number; dy: number; r: number }[];
}
interface Pop {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}

let things: Thing[] = [];
let halves: Half[] = [];
let particles: Particle[] = [];
let splats: Splat[] = [];
let pops: Pop[] = [];
let nextSpawn = 0;
let shake = 0;
const trails = new Map<string, { x: number; y: number; t: number }[]>();
const lastHand = new Map<string, Vec2>();
let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);

flow.on('start', () => {
  things = [];
  halves = [];
  splats = [];
  nextSpawn = 0;
});

// ---------- loop ----------

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  const players = game.frame.players;
  flow.update(now);
  const live = flow.playing; // false in lobby/results and while paused

  ctx.save();
  if (shake > 0) {
    shake -= dt;
    ctx.translate((Math.random() - 0.5) * 30 * shake, (Math.random() - 0.5) * 30 * shake);
  }
  background();
  game.drawPeople(ctx, W, H); // the players themselves, behind the fruit and menus
  // The hand trails are what matters; the cut-outs show the rest. Without cut-outs (G off,
  // simulator) a faint body so players can see where they are.
  if (!game.peopleVisible) for (const p of players) drawSkeleton(ctx, p, mapper.map, { alpha: 0.25, lineWidth: 14 });

  if (live) spawn(now, players.length);
  updateThings(live ? dt : 0);
  hands(players, now, live);
  updateEffects(dt);
  flow.drawOverlay(ctx, W, H);
  ctx.restore();
  requestAnimationFrame(loop);
}

/** The orchard, blurred and dimmed once so the flying fruit and the players stand out. */
const scenery = (() => {
  const img = assets.images.background;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.filter = 'blur(3px) saturate(0.75) brightness(0.62)';
  g.drawImage(img, -8, -8, img.width + 16, img.height + 16); // overscan so the blur has no soft edge
  return c;
})();

function background() {
  const img = scenery;
  // Cover the screen (plus the shake margin).
  const k = Math.max((W + 100) / img.width, (H + 100) / img.height);
  ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
  // Juice splats on the scenery.
  for (const s of splats) {
    ctx.globalAlpha = 0.55 * Math.max(0, 1 - s.life / 1.6);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    for (const b of s.blobs) {
      ctx.moveTo(s.x + b.dx + b.r, s.y + b.dy);
      ctx.arc(s.x + b.dx, s.y + b.dy, b.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------- fruit ----------

function spawn(now: number, playerCount: number) {
  if (now < nextSpawn) return;
  const gap = 900 / (0.6 + 0.4 * Math.max(1, playerCount));
  nextSpawn = now + gap * (0.6 + Math.random() * 0.8);
  const n = Math.random() < 0.25 ? 3 : Math.random() < 0.4 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const bomb = Math.random() < 0.12;
    const kind = bomb ? 'bomb' : FRUITS[(Math.random() * FRUITS.length) | 0];
    const r = H * 0.055 * (bomb ? 0.9 : (kind as FruitKind).size);
    const x = W * (0.15 + Math.random() * 0.7);
    const g = H * 1.3;
    const height = H * (0.5 + Math.random() * 0.35);
    things.push({
      x,
      y: H + r,
      vx: (W / 2 - x) * (0.2 + Math.random() * 0.4),
      vy: -Math.sqrt(2 * g * height),
      r,
      rot: Math.random() * 6,
      spin: (Math.random() - 0.5) * 4,
      kind,
      dead: false,
    });
  }
  blip(220 + Math.random() * 80, 80, 'sine', 0.05);
}

function updateThings(dt: number) {
  const g = H * 1.3;
  for (const t of things) {
    t.vy += g * dt;
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.rot += t.spin * dt;
    if (t.y > H + t.r * 2 && t.vy > 0) t.dead = true;
    drawThing(t);
  }
  things = things.filter((t) => !t.dead);

  for (const h of halves) {
    h.vy += g * dt;
    h.x += h.vx * dt;
    h.y += h.vy * dt;
    h.rot += h.spin * dt;
    h.life += dt;
    // The cut face, squashed into a tumbling half that flips over as it spins.
    const s = h.r * SPRITE * 0.95;
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(h.rot);
    ctx.scale(0.55 + 0.45 * Math.abs(Math.cos(h.life * 3)), 1);
    ctx.drawImage(assets.images[`${h.kind.name}-half`], -s / 2, -s / 2, s, s);
    ctx.restore();
  }
  halves = halves.filter((h) => h.y < H + h.r * 3);
}

function drawThing(t: Thing) {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.rot);
  const s = t.r * SPRITE;
  if (t.kind === 'bomb') {
    // A red warning glow behind the bomb, and a flickering spark on its fuse.
    const glow = ctx.createRadialGradient(0, 0, t.r * 0.6, 0, 0, t.r * 1.5);
    glow.addColorStop(0, 'rgba(255, 60, 60, 0.55)');
    glow.addColorStop(1, 'rgba(255, 60, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, t.r * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(assets.images.bomb, -s / 2, -s / 2, s, s);
    ctx.fillStyle = Math.random() < 0.5 ? '#ffbe0b' : '#fff3b0';
    ctx.beginPath();
    ctx.arc(s * 0.12, -s * 0.43, t.r * (0.12 + Math.random() * 0.12), 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.drawImage(assets.images[t.kind.name], -s / 2, -s / 2, s, s);
  }
  ctx.restore();
}

// ---------- hands & slicing ----------

function hands(players: Player[], now: number, live: boolean) {
  const seen = new Set<string>();
  for (const p of players) {
    for (const w of [KP.leftWrist, KP.rightWrist]) {
      const k = p.keypoints[w];
      if (k.score < 0.4) continue;
      const key = `${p.id}:${w}`;
      seen.add(key);
      const pos = mapper.map(k);
      const prev = lastHand.get(key) ?? pos;
      lastHand.set(key, pos);
      // How fast the hand swipes, not the whole body: jumping or running across doesn't slice.
      const body = bodyVelocity(p);
      const speed = Math.hypot(k.vx - body.x, k.vy - body.y);
      const fast = speed > SLICE_SPEED;

      const trail = trails.get(key) ?? [];
      trail.push({ ...pos, t: now });
      while (trail.length && now - trail[0].t > (fast ? 160 : 60)) trail.shift();
      trails.set(key, trail);
      drawTrail(trail, p.color, fast);

      if (fast && live) {
        for (const t of things) {
          if (t.dead || segCircle(prev, pos, t)) continue;
          t.dead = true;
          if (t.kind === 'bomb') bombHit(t, p);
          else sliceFruit(t, t.kind, p, pos.x - prev.x, pos.y - prev.y);
        }
      }
    }
  }
  for (const key of [...trails.keys()]) if (!seen.has(key)) (trails.delete(key), lastHand.delete(key));
}

/** The body centre's velocity in the same (laid-out) units as the keypoints' vx/vy. */
function bodyVelocity(p: Player): Vec2 {
  const s = p.transform?.scale ?? 1;
  return { x: (p.motion?.vx ?? 0) * s, y: (p.motion?.vy ?? 0) * s };
}

/** True if the segment a→b MISSES the circle (so we can `continue` on misses). */
function segCircle(a: Vec2, b: Vec2, c: Thing): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
  const px = a.x + u * dx - c.x;
  const py = a.y + u * dy - c.y;
  return px * px + py * py > (c.r * 1.15) ** 2;
}

function drawTrail(trail: { x: number; y: number }[], color: string, fast: boolean) {
  // The hand itself: always shown, even when it's still (a still trail has no length to draw).
  const tip = trail[trail.length - 1];
  if (!tip) return;
  ctx.save();
  for (const [r, c] of [
    [14, color],
    [5, '#fff'],
  ] as const) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (trail.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [w, c] of [
    [fast ? 26 : 16, color],
    [fast ? 10 : 6, '#fff'],
  ] as const) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.beginPath();
    trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.restore();
}

function sliceFruit(t: Thing, kind: FruitKind, p: Player, dx: number, dy: number) {
  const ang = Math.atan2(dy, dx);
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  for (const s of [1, -1]) {
    halves.push({
      x: t.x,
      y: t.y,
      vx: t.vx * 0.5 + nx * s * 220,
      vy: Math.min(t.vy, 0) * 0.3 + ny * s * 220,
      r: t.r,
      rot: ang + (s > 0 ? Math.PI : 0),
      spin: s * 3,
      kind,
      life: 0,
    });
  }
  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 150 + Math.random() * 350;
    particles.push({
      x: t.x,
      y: t.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0,
      max: 0.4 + Math.random() * 0.4,
      size: 4 + Math.random() * 8,
      color: kind.juice,
    });
  }
  splats.push({
    x: t.x,
    y: t.y,
    r: t.r * 0.7,
    color: kind.juice,
    life: 0,
    blobs: Array.from({ length: 7 }, () => {
      const a = Math.random() * Math.PI * 2;
      const d = t.r * (0.6 + Math.random() * 0.7);
      return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: t.r * (0.12 + Math.random() * 0.22) };
    }),
  });
  flow.addScore(p.slot, 1);
  pops.push({ x: t.x, y: t.y, text: '+1', color: p.color, life: 0 });
  blip(500 + Math.random() * 300, 90, 'triangle', 0.18, 1200);
}

function bombHit(t: Thing, p: Player) {
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 200 + Math.random() * 600;
    particles.push({
      x: t.x,
      y: t.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0,
      max: 0.5 + Math.random() * 0.5,
      size: 6 + Math.random() * 12,
      color: Math.random() < 0.5 ? '#ffbe0b' : '#ff4d6d',
    });
  }
  flow.addScore(p.slot, -3);
  pops.push({ x: t.x, y: t.y, text: '-3', color: '#ff4d6d', life: 0 });
  shake = 0.4;
  noise(400, 0.35);
}

// ---------- effects & HUD ----------

function updateEffects(dt: number) {
  for (const q of particles) {
    q.life += dt;
    q.vy += H * 1.3 * dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    ctx.globalAlpha = Math.max(0, 1 - q.life / q.max);
    ctx.fillStyle = q.color;
    ctx.beginPath();
    ctx.arc(q.x, q.y, q.size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  particles = particles.filter((q) => q.life < q.max);

  for (const p of pops) {
    p.life += dt;
    ctx.globalAlpha = Math.max(0, 1 - p.life);
    drawText(ctx, p.text, p.x, p.y - p.life * 90, H / 14, p.color);
  }
  ctx.globalAlpha = 1;
  pops = pops.filter((p) => p.life < 1);

  for (const s of splats) s.life += dt;
  splats = splats.filter((s) => s.life < 1.6);
}

requestAnimationFrame(loop);

// Read-only peek for automated tests.
(window as unknown as { slice: () => object }).slice = () => ({
  state: flow.state,
  things: things.map((t) => (t.kind === 'bomb' ? 'bomb' : t.kind.name)),
  halves: halves.length,
});
