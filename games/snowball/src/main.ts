/**
 * Snowball Fight — crouch to scoop up snow, swing an arm to throw, move to dodge.
 *
 *  - 2 players: throw at each other. Snowballs are aimed at where the other
 *    player was when you threw and take about a second to arrive, so stepping
 *    or ducking out of the way dodges them.
 *  - 1 player: cheeky elves pop up behind the snow wall. Hit them before they
 *    duck down — and dodge the snowballs they throw back at you!
 *
 * Throwing works with any fast arm swing (and the "punch" gesture), so it
 * doesn't need a perfect overarm throw.
 */
import {
  KP,
  RoundFlow,
  blip,
  createGame,
  drawText,
  fitCanvas,
  noise,
  prepareSpeech,
  say,
  screenMapper,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

const START_AMMO = 3;
const MAX_AMMO = 5;
/** Wrist speed (shoulder-widths per second) that counts as a throw. */
const THROW_SPEED = 6;
const THROW_COOLDOWN = 0.8;
const FLIGHT = 0.95;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame();
const flow = new RoundFlow(game, {
  title: 'Snowball Fight',
  seconds: 60,
  subtitle: 'Raise both hands to start!',
});
prepareSpeech(['Snowball fight!', 'Crouch down to make snowballs!', 'Splat!', 'What a snowball fight!']);

// ---------- state ----------

interface Thrower {
  ammo: number;
  lastThrow: number;
  lastScoop: number;
  splatUntil: number;
  splatAt: Vec2 | null;
}
interface Ball {
  from: Vec2; // screen px at throw
  to: Vec2; // aimed impact point
  t: number;
  /** Who threw it: a player slot, or -1 for an elf. */
  by: number;
  /** Target: player id, or elf index. */
  target: { kind: 'player'; id: number } | { kind: 'elf'; i: number } | { kind: 'screen' };
  /** Shrinks when thrown into the distance (at elves), grows when an elf throws at you. */
  scaleFrom: number;
  scaleTo: number;
}
interface Elf {
  x: number; // 0..1 across the snow wall
  up: number; // 0 hidden → 1 fully up
  state: 'hidden' | 'rising' | 'up' | 'falling' | 'hit';
  until: number;
  throwAt: number;
}
interface Flake {
  x: number;
  y: number;
  r: number;
  v: number;
}

const throwers = new Map<number, Thrower>();
let balls: Ball[] = [];
let elves: Elf[] = [];
let splats: { x: number; y: number; r: number; life: number }[] = [];
let screenSplat = 0;
let pops: { x: number; y: number; text: string; color: string; life: number }[] = [];
const flakes: Flake[] = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), r: 1 + Math.random() * 3, v: 0.03 + Math.random() * 0.06 }));
let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);
let clock = 0; // play seconds

const thrower = (p: Player): Thrower => {
  let t = throwers.get(p.id);
  if (!t) throwers.set(p.id, (t = { ammo: START_AMMO, lastThrow: -9, lastScoop: -9, splatUntil: 0, splatAt: null }));
  return t;
};

flow.on('start', () => {
  throwers.clear();
  balls = [];
  splats = [];
  pops = [];
  clock = 0;
  elves = Array.from({ length: 5 }, (_, i) => ({ x: 0.12 + i * 0.19, up: 0, state: 'hidden' as const, until: 1 + i * 0.7, throwAt: 0 }));
  void say('Snowball fight!', { interrupt: true });
});
flow.on('end', () => void say('What a snowball fight!'));

// ---------- helpers ----------

const solo = () => game.frame.players.length < 2;

function chest(p: Player): Vec2 {
  const k = p.keypoints;
  return mapper.map({
    x: (k[KP.leftShoulder].x + k[KP.rightShoulder].x + k[KP.leftHip].x + k[KP.rightHip].x) / 4,
    y: (k[KP.leftShoulder].y * 2 + k[KP.leftHip].y) / 3,
  });
}
const S = (p: Player) => Math.max(mapper.len(p.shoulderWidth), 30);

const wallY = () => H * 0.42;
function elfPos(e: Elf): Vec2 {
  return { x: W * e.x, y: wallY() - H * 0.07 * e.up };
}

// Scoop: crouching makes snowballs.
game.on('crouch', (e) => {
  if (!flow.playing) return;
  const p = game.frame.players.find((q) => q.id === e.playerId);
  if (!p) return;
  const t = thrower(p);
  if (clock - t.lastScoop < 0.6) return;
  t.lastScoop = clock;
  const before = t.ammo;
  t.ammo = Math.min(MAX_AMMO, t.ammo + 2);
  if (t.ammo > before) {
    blip(300, 90, 'triangle', 0.12, 500);
    const c = chest(p);
    pops.push({ x: c.x, y: c.y + S(p), text: `+${t.ammo - before} ❄`, color: '#fff', life: 0.9 });
  }
});
game.on('punch', (e) => {
  const p = game.frame.players.find((q) => q.id === e.playerId);
  if (p) tryThrow(p, e.hand === 'left' ? KP.leftWrist : KP.rightWrist);
});

function tryThrow(p: Player, wrist: number) {
  if (!flow.playing) return;
  const t = thrower(p);
  if (clock - t.lastThrow < THROW_COOLDOWN) return;
  if (t.ammo <= 0) {
    if (clock - t.lastThrow > 2) {
      const c = chest(p);
      pops.push({ x: c.x, y: c.y - S(p) * 2, text: 'Crouch for snow!', color: '#9be7ff', life: 1.2 });
      t.lastThrow = clock - THROW_COOLDOWN + 1; // don't nag every frame
    }
    return;
  }
  const from = mapper.map(p.keypoints[wrist]);
  let ball: Ball | null = null;
  if (!solo()) {
    // Nearest other player.
    const others = game.frame.players.filter((q) => q.id !== p.id);
    const me = chest(p);
    const target = others.reduce((a, b) => (Math.abs(chest(a).x - me.x) < Math.abs(chest(b).x - me.x) ? a : b));
    const aim = chest(target);
    ball = { from, to: { x: aim.x, y: aim.y - S(target) * 0.3 }, t: 0, by: p.slot, target: { kind: 'player', id: target.id }, scaleFrom: 1, scaleTo: 1 };
  } else {
    // Nearest elf that's up (or the nearest one at all, for a near miss).
    const upElves = elves.map((e, i) => ({ e, i })).filter(({ e }) => e.state === 'up' || e.state === 'rising');
    const pool = upElves.length ? upElves : elves.map((e, i) => ({ e, i }));
    const best = pool.reduce((a, b) => (Math.abs(W * a.e.x - from.x) < Math.abs(W * b.e.x - from.x) ? a : b));
    const aim = elfPos({ ...best.e, up: 1 });
    ball = { from, to: { x: aim.x, y: aim.y + H * 0.01 }, t: 0, by: p.slot, target: { kind: 'elf', i: best.i }, scaleFrom: 1, scaleTo: 0.45 };
  }
  t.ammo--;
  t.lastThrow = clock;
  balls.push(ball);
  noise(80, 0.08);
  blip(500, 80, 'sine', 0.08, 900);
}

// Fast arm swings throw.
game.onFrame((f) => {
  if (!flow.playing) return;
  for (const p of f.players) {
    const sw = Math.max(p.shoulderWidth, 0.03);
    const k = p.keypoints;
    const hipY = Math.min(k[KP.leftHip].y, k[KP.rightHip].y);
    for (const w of [KP.leftWrist, KP.rightWrist]) {
      const kp = k[w];
      if (kp.score < 0.4 || kp.y > hipY) continue;
      // Only the throwing motion counts — the hand moving away from its
      // shoulder — not the arm swinging back afterwards.
      const sh = k[w === KP.leftWrist ? KP.leftShoulder : KP.rightShoulder];
      const outward = (kp.x - sh.x) * kp.vx + (kp.y - sh.y) * kp.vy > 0;
      if (outward && Math.hypot(kp.vx, kp.vy) / sw > THROW_SPEED) tryThrow(p, w);
    }
  }
});

// ---------- update ----------

function step(dt: number, players: Player[]) {
  clock += dt;
  // Snowballs
  for (const b of balls) b.t += dt;
  for (const b of balls.filter((b) => b.t >= FLIGHT)) {
    if (b.target.kind === 'player') {
      const id = b.target.id;
      const victim = players.find((q) => q.id === id);
      if (victim) {
        const k = victim.keypoints;
        const parts = [chest(victim), mapper.map(k[KP.nose])];
        const hit = parts.some((pt) => Math.hypot(pt.x - b.to.x, pt.y - b.to.y) < S(victim) * 0.85);
        if (hit) {
          flow.addScore(b.by, 1);
          const tv = thrower(victim);
          tv.splatUntil = clock + 1.2;
          splats.push({ x: b.to.x, y: b.to.y, r: S(victim) * 0.5, life: 1.2 });
          pops.push({ x: b.to.x, y: b.to.y - S(victim), text: 'SPLAT!', color: '#fff', life: 1 });
          noise(180, 0.3);
          blip(160, 150, 'square', 0.1, 80);
        } else {
          splats.push({ x: b.to.x, y: b.to.y, r: H * 0.03, life: 0.6 });
          pops.push({ x: b.to.x, y: b.to.y - 30, text: 'Dodged!', color: '#9be7ff', life: 0.8 });
        }
      }
    } else if (b.target.kind === 'elf') {
      const e = elves[b.target.i];
      if (e && (e.state === 'up' || e.state === 'rising') && e.up > 0.5) {
        e.state = 'hit';
        e.until = clock + 0.7;
        flow.addScore(b.by, 1);
        pops.push({ x: b.to.x, y: b.to.y - H * 0.08, text: 'BONK! +1', color: '#ffd60a', life: 1 });
        blip(900, 120, 'triangle', 0.15, 1400);
      } else {
        pops.push({ x: b.to.x, y: b.to.y - H * 0.05, text: 'missed!', color: '#ccc', life: 0.7 });
      }
      splats.push({ x: b.to.x, y: b.to.y, r: H * 0.02, life: 0.8 });
    } else {
      // An elf's snowball reaching the front of the screen: did the player move?
      const near = players.some((p) => {
        const c = chest(p);
        const n = mapper.map(p.keypoints[KP.nose]);
        return [c, n].some((pt) => Math.hypot(pt.x - b.to.x, pt.y - b.to.y) < S(p) * 0.9);
      });
      if (near) {
        screenSplat = 1;
        noise(250, 0.35);
        void say('Splat!');
      } else pops.push({ x: b.to.x, y: b.to.y, text: 'Dodged!', color: '#9be7ff', life: 0.8 });
    }
  }
  balls = balls.filter((b) => b.t < FLIGHT);

  // Elves (solo only)
  if (solo()) {
    for (const e of elves) {
      if (e.state === 'hidden' && clock >= e.until && elves.filter((x) => x.state !== 'hidden').length < 2 + Math.floor(clock / 25)) {
        e.state = 'rising';
        e.until = clock + 1.6 + Math.random() * 1.6 - Math.min(0.8, clock / 60);
        e.throwAt = clock + 0.6 + Math.random();
      }
      if (e.state === 'rising') {
        e.up = Math.min(1, e.up + dt * 5);
        if (e.up >= 1) e.state = 'up';
      }
      if (e.state === 'up' || e.state === 'rising') {
        if (clock >= e.throwAt && players.length && Math.random() < 0.35) {
          // Throw at the player: grows towards the screen, aimed at their chest now.
          const p = players[0];
          const aim = chest(p);
          balls.push({ from: elfPos(e), to: aim, t: 0, by: -1, target: { kind: 'screen' }, scaleFrom: 0.45, scaleTo: 3 });
          e.throwAt = Infinity;
        } else if (clock >= e.throwAt) e.throwAt = Infinity;
        if (clock >= e.until) e.state = 'falling';
      }
      if (e.state === 'falling' || e.state === 'hit') {
        if (e.state === 'hit' && clock < e.until) continue;
        e.up = Math.max(0, e.up - dt * 4);
        if (e.up <= 0) {
          e.state = 'hidden';
          e.until = clock + 0.4 + Math.random() * 1.8;
        }
      }
    }
  }
}

// ---------- drawing ----------

function background(dt: number) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0b2545');
  g.addColorStop(0.55, '#3e5c76');
  g.addColorStop(0.56, '#e9f5ff');
  g.addColorStop(1, '#cfe8ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Moon and hills
  ctx.fillStyle = '#fefae0';
  ctx.beginPath();
  ctx.arc(W * 0.85, H * 0.12, H * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f1f8ff';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.ellipse(W * (0.1 + i * 0.3), H * 0.56, W * 0.25, H * 0.09, 0, Math.PI, 0);
    ctx.fill();
  }
  // Snow wall the elves hide behind.
  if (solo() && flow.state === 'playing') {
    for (const e of elves) drawElf(e);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#b8d8f0';
    ctx.lineWidth = 3;
    const y = wallY();
    ctx.beginPath();
    ctx.moveTo(0, y + H * 0.06);
    for (let x = 0; x <= W; x += W / 24) ctx.quadraticCurveTo(x + W / 48, y - H * 0.012, x + W / 24, y);
    ctx.lineTo(W, y + H * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // Falling snow
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const f of flakes) {
    f.y += f.v * dt;
    f.x += Math.sin(f.y * 20 + f.r) * 0.0005;
    if (f.y > 1) {
      f.y = 0;
      f.x = Math.random();
    }
    ctx.beginPath();
    ctx.arc(f.x * W, f.y * H, f.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawElf(e: Elf) {
  if (e.up <= 0) return;
  const p = elfPos(e);
  const s = H * 0.035;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (e.state === 'hit') ctx.rotate(Math.sin(performance.now() / 40) * 0.2);
  // body
  ctx.fillStyle = '#2a9d3a';
  ctx.beginPath();
  ctx.roundRect(-s * 0.8, s * 0.6, s * 1.6, s * 1.6, s * 0.4);
  ctx.fill();
  // face
  ctx.fillStyle = '#ffd7ba';
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2);
  ctx.fill();
  // ears
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, -s * 0.1);
  ctx.lineTo(-s * 1.2, -s * 0.5);
  ctx.lineTo(-s * 0.6, s * 0.2);
  ctx.moveTo(s * 0.7, -s * 0.1);
  ctx.lineTo(s * 1.2, -s * 0.5);
  ctx.lineTo(s * 0.6, s * 0.2);
  ctx.fill();
  // hat
  ctx.fillStyle = '#e63946';
  ctx.beginPath();
  ctx.moveTo(-s * 0.8, -s * 0.35);
  ctx.lineTo(s * 0.8, -s * 0.35);
  ctx.lineTo(s * 0.5, -s * 1.7);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(s * 0.5, -s * 1.7, s * 0.22, 0, Math.PI * 2);
  ctx.fill();
  // eyes
  ctx.fillStyle = '#1b1030';
  if (e.state === 'hit') {
    ctx.font = `900 ${s * 0.5}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('x  x', 0, s * 0.05);
  } else {
    ctx.beginPath();
    ctx.arc(-s * 0.25, -s * 0.05, s * 0.1, 0, Math.PI * 2);
    ctx.arc(s * 0.25, -s * 0.05, s * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(p: Player) {
  const k = p.keypoints;
  const s = S(p);
  const t = thrower(p);
  const LIMBS: [number, number][] = [
    [KP.leftShoulder, KP.rightShoulder],
    [KP.leftShoulder, KP.leftElbow],
    [KP.leftElbow, KP.leftWrist],
    [KP.rightShoulder, KP.rightElbow],
    [KP.rightElbow, KP.rightWrist],
    [KP.leftShoulder, KP.leftHip],
    [KP.rightShoulder, KP.rightHip],
    [KP.leftHip, KP.rightHip],
    [KP.leftHip, KP.leftKnee],
    [KP.leftKnee, KP.leftAnkle],
    [KP.rightHip, KP.rightKnee],
    [KP.rightKnee, KP.rightAnkle],
  ];
  ctx.save();
  ctx.lineCap = 'round';
  // Puffy winter coat: white outline, coloured fill.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? p.color : '#1b263b';
    ctx.lineWidth = s * (pass ? 0.3 : 0.38);
    for (const [a, b] of LIMBS) {
      if (k[a].score < 0.3 || k[b].score < 0.3) continue;
      const pa = mapper.map(k[a]);
      const pb = mapper.map(k[b]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }
  // Mittens
  for (const w of [KP.leftWrist, KP.rightWrist]) {
    if (k[w].score < 0.3) continue;
    const m = mapper.map(k[w]);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(m.x, m.y, s * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Head with bobble hat.
  if (k[KP.nose].score > 0.3) {
    const n = mapper.map(k[KP.nose]);
    ctx.fillStyle = '#ffd7ba';
    ctx.beginPath();
    ctx.arc(n.x, n.y, s * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(n.x, n.y - s * 0.08, s * 0.38, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(n.x - s * 0.4, n.y - s * 0.12, s * 0.8, s * 0.12);
    ctx.beginPath();
    ctx.arc(n.x, n.y - s * 0.5, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b1030';
    ctx.beginPath();
    ctx.arc(n.x - s * 0.12, n.y + s * 0.05, s * 0.05, 0, Math.PI * 2);
    ctx.arc(n.x + s * 0.12, n.y + s * 0.05, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
    // Snowball supply above the head.
    if (flow.state === 'playing') {
      const ay = Math.max(120, n.y - s * 0.95); // keep on screen
      for (let i = 0; i < t.ammo; i++) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#9fc3e0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x + (i - (t.ammo - 1) / 2) * s * 0.32, ay, s * 0.13, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (t.ammo === 0) drawText(ctx, 'Crouch to scoop snow!', n.x, ay, Math.max(18, s * 0.22), '#9be7ff');
    }
  }
  // Got splatted: snow stuck on them.
  if (clock < t.splatUntil) {
    const c = chest(p);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(c.x + Math.cos(i * 1.7) * s * 0.3, c.y - s * 0.4 + Math.sin(i * 2.3) * s * 0.3, s * (0.12 + (i % 3) * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBalls() {
  for (const b of balls) {
    const u = Math.min(1, b.t / FLIGHT);
    const x = b.from.x + (b.to.x - b.from.x) * u;
    // Arc upwards (lob) for throws between players; straight-ish into/out of the distance.
    const lob = b.target.kind === 'player' ? H * 0.22 : b.target.kind === 'elf' ? H * 0.12 : H * 0.05;
    const y = b.from.y + (b.to.y - b.from.y) * u - Math.sin(u * Math.PI) * lob;
    const scale = b.scaleFrom + (b.scaleTo - b.scaleFrom) * (b.target.kind === 'screen' ? u * u : u);
    const r = H * 0.022 * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.ellipse(x, b.to.y + H * 0.05, r, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#9fc3e0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function effects(dt: number) {
  for (const s of splats) {
    s.life -= dt;
    ctx.globalAlpha = Math.max(0, Math.min(1, s.life * 2));
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.arc(s.x + Math.cos(i * 0.9) * s.r, s.y + Math.sin(i * 0.9) * s.r * 0.6, s.r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  splats = splats.filter((s) => s.life > 0);
  for (const p of pops) {
    p.life -= dt;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
    drawText(ctx, p.text, p.x, p.y - (1 - p.life) * 30, Math.max(22, H / 26), p.color);
  }
  pops = pops.filter((p) => p.life > 0);
  ctx.globalAlpha = 1;
  // Elf snowball hit the screen!
  if (screenSplat > 0) {
    screenSplat -= dt * 0.6;
    ctx.globalAlpha = Math.max(0, Math.min(1, screenSplat * 1.5));
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 14; i++) {
      const a = i * 0.45;
      ctx.beginPath();
      ctx.arc(W / 2 + Math.cos(a) * W * 0.18 * (0.6 + (i % 3) * 0.3), H / 2 + Math.sin(a) * H * 0.2 * (0.6 + (i % 2) * 0.4), H * (0.08 + (i % 4) * 0.03), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, H * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (screenSplat > 0.5) drawText(ctx, 'SPLAT!', W / 2, H / 2, H / 8, '#3e5c76', { stroke: false });
  }
}

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  const players = game.frame.players;
  flow.update(now);
  if (flow.playing) step(dt, players);

  background(dt);
  game.drawPeople(ctx, W, H); // the players themselves, under their snow suits and menus
  for (const p of players) drawPlayer(p);
  drawBalls();
  effects(dt);
  flow.drawOverlay(ctx, W, H);
  if (flow.state === 'lobby') {
    drawText(ctx, 'Crouch to scoop snow · swing your arm to throw · move to dodge', W / 2, H * 0.53, Math.min(H / 26, W / 44));
    drawText(ctx, players.length >= 2 ? '2 players: throw at each other!' : 'On your own? The elves want a snowball fight!', W / 2, H * 0.59, Math.min(H / 30, W / 46), '#9be7ff');
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Read-only peek for automated tests.
(window as unknown as { snowball: () => object }).snowball = () => ({
  state: flow.state,
  solo: solo(),
  clock: +clock.toFixed(1),
  balls: balls.length,
  elvesUp: elves.filter((e) => e.state !== 'hidden').length,
  scores: flow.scores,
  ammo: [...throwers.values()].map((t) => t.ammo),
  screenSplat: +screenSplat.toFixed(2),
});
