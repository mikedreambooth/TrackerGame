/**
 * Fruit Swipe — fruit flies up, fast hands slice it. Each player scores in their
 * own colour. Bombs cost points. 60-second rounds, raise both hands to start.
 */
import {
  KP,
  blip,
  createGame,
  drawSkeleton,
  fitCanvas,
  noise,
  screenMapper,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

const ROUND_SECONDS = 60;
/** Hand speed needed to slice, in frame-heights per second. */
const SLICE_SPEED = 0.9;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame();

const FRUITS = [
  { rind: '#2a9d3a', flesh: '#ff4d6d', seed: '#1b1030', size: 1.3 }, // watermelon
  { rind: '#ff9f1c', flesh: '#ffbf69', seed: '#fff3', size: 0.9 }, // orange
  { rind: '#e63946', flesh: '#fff1d6', seed: '#6b3e26', size: 0.85 }, // apple
  { rind: '#ffd60a', flesh: '#fff7c2', seed: '#0000', size: 0.8 }, // lemon
  { rind: '#7209b7', flesh: '#c77dff', seed: '#3c096c', size: 0.7 }, // plum
];
type FruitKind = (typeof FRUITS)[number];

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
interface Pop {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}

type State = 'lobby' | 'countdown' | 'playing' | 'results';
let state: State = 'lobby';
let stateAt = performance.now();
let things: Thing[] = [];
let halves: Half[] = [];
let particles: Particle[] = [];
let pops: Pop[] = [];
let scores: Record<number, number> = {};
let colors: Record<number, string> = {};
let nextSpawn = 0;
let shake = 0;
const trails = new Map<string, { x: number; y: number; t: number }[]>();
const lastHand = new Map<string, Vec2>();
let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);

function setState(s: State) {
  state = s;
  stateAt = performance.now();
  if (s === 'countdown') {
    things = [];
    halves = [];
    scores = {};
    colors = {};
    for (const p of game.frame.players) {
      scores[p.slot] = 0;
      colors[p.slot] = p.color;
    }
  }
  if (s === 'playing') nextSpawn = 0;
  if (s === 'results') game.reportScores(scores);
}

game.on('handsUp', () => {
  if (state === 'lobby') setState('countdown');
  else if (state === 'results' && performance.now() - stateAt > 2500) setState('countdown');
});

// ---------- loop ----------

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  const players = game.frame.players;
  const elapsed = (now - stateAt) / 1000;

  ctx.save();
  if (shake > 0) {
    shake -= dt;
    ctx.translate((Math.random() - 0.5) * 30 * shake, (Math.random() - 0.5) * 30 * shake);
  }
  background();
  for (const p of players) drawSkeleton(ctx, p, mapper.map, { alpha: 0.25, lineWidth: 14 });

  if (state === 'countdown' && elapsed >= 3) setState('playing');
  if (state === 'playing') {
    for (const p of players) {
      // Late joiners get a score slot too.
      scores[p.slot] ??= 0;
      colors[p.slot] ??= p.color;
    }
    spawn(now, players.length);
    if (elapsed >= ROUND_SECONDS) setState('results');
  }

  updateThings(dt);
  hands(players, now);
  updateEffects(dt);
  hud(now, elapsed, players);
  ctx.restore();
  requestAnimationFrame(loop);
}

function background() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0b3d3a');
  g.addColorStop(1, '#06201f');
  ctx.fillStyle = g;
  ctx.fillRect(-50, -50, W + 100, H + 100);
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 2;
  for (let x = 0; x < W; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
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
    ctx.save();
    ctx.translate(h.x, h.y);
    ctx.rotate(h.rot);
    ctx.fillStyle = h.kind.rind;
    ctx.beginPath();
    ctx.arc(0, 0, h.r, 0, Math.PI);
    ctx.fill();
    ctx.fillStyle = h.kind.flesh;
    ctx.beginPath();
    ctx.arc(0, 0, h.r * 0.85, 0, Math.PI);
    ctx.fill();
    ctx.restore();
  }
  halves = halves.filter((h) => h.y < H + h.r * 3);
}

function drawThing(t: Thing) {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.rot);
  if (t.kind === 'bomb') {
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(0, 0, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ff4d6d';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-t.r * 0.4, -t.r * 0.4);
    ctx.lineTo(t.r * 0.4, t.r * 0.4);
    ctx.moveTo(t.r * 0.4, -t.r * 0.4);
    ctx.lineTo(-t.r * 0.4, t.r * 0.4);
    ctx.stroke();
    ctx.fillStyle = Math.random() < 0.5 ? '#ffbe0b' : '#ff4d6d';
    ctx.beginPath();
    ctx.arc(0, -t.r * 1.15, t.r * 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = t.kind.rind;
    ctx.beginPath();
    ctx.arc(0, 0, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.arc(-t.r * 0.35, -t.r * 0.35, t.r * 0.25, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- hands & slicing ----------

function hands(players: Player[], now: number) {
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
      const speed = Math.hypot(k.vx, k.vy);
      const fast = speed > SLICE_SPEED;

      const trail = trails.get(key) ?? [];
      trail.push({ ...pos, t: now });
      while (trail.length && now - trail[0].t > (fast ? 160 : 60)) trail.shift();
      trails.set(key, trail);
      drawTrail(trail, p.color, fast);

      if (fast && state === 'playing') {
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
  if (trail.length < 2) {
    const p = trail[0];
    if (!p) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
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
      color: kind.flesh,
    });
  }
  scores[p.slot] = (scores[p.slot] ?? 0) + 1;
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
  scores[p.slot] = Math.max(0, (scores[p.slot] ?? 0) - 3);
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
    text(p.text, p.x, p.y - p.life * 90, H / 14, p.color);
  }
  ctx.globalAlpha = 1;
  pops = pops.filter((p) => p.life < 1);
}

function text(s: string, x: number, y: number, size: number, color: string) {
  ctx.font = `900 ${Math.round(size)}px ui-rounded, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(4, size / 8);
  ctx.strokeStyle = '#1b1030';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function hud(now: number, elapsed: number, players: Player[]) {
  if (state === 'lobby') {
    text('Fruit Swipe', W / 2, H * 0.3, H / 7, '#ffbe0b');
    text(players.length ? 'Raise both hands to start!' : 'Step in to play!', W / 2, H * 0.5, H / 14, '#fff');
    return;
  }
  if (state === 'countdown') {
    const n = Math.ceil(3 - elapsed);
    const pulse = 1 + (1 - (elapsed % 1)) * 0.3;
    text(String(n), W / 2, H / 2, (H / 3) * pulse, '#ffbe0b');
  }
  if (state === 'playing') {
    const left = Math.max(0, ROUND_SECONDS - elapsed);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, 0, W, 14);
    ctx.fillStyle = left < 10 ? '#ff4d6d' : '#ffbe0b';
    ctx.fillRect(0, 0, (W * left) / ROUND_SECONDS, 14);
    if (left < 10 && Math.floor(now / 500) % 2) text(String(Math.ceil(left)), W / 2, H * 0.1, H / 10, '#ff4d6d');
  }
  // Scoreboard.
  const slots = Object.keys(scores)
    .map(Number)
    .sort((a, b) => a - b);
  if (state === 'results') {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, H);
    const best = Math.max(...slots.map((s) => scores[s]), 0);
    text('Time up!', W / 2, H * 0.2, H / 9, '#ffbe0b');
    slots.forEach((s, i) => {
      const x = (W * (i + 1)) / (slots.length + 1);
      text(`${scores[s]}`, x, H * 0.48, H / 6, colors[s] ?? '#fff');
      if (scores[s] === best && best > 0) text('★', x, H * 0.32, H / 9, '#ffbe0b');
    });
    if (now - stateAt > 2500) text('Hands up to play again!', W / 2, H * 0.78, H / 16, '#fff');
    return;
  }
  slots.forEach((s, i) => {
    const x = 60 + i * 130;
    ctx.fillStyle = colors[s] ?? '#fff';
    ctx.beginPath();
    ctx.roundRect(x - 50, 30, 110, 64, 18);
    ctx.fill();
    text(String(scores[s]), x + 5, 63, 40, '#fff');
  });
}

requestAnimationFrame(loop);
