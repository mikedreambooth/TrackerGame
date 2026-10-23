/**
 * Halloween Heads — pumpkins, skulls, ghosts and vampire heads fall from the night sky.
 * Line your head up with one as it falls: close enough and it snaps onto your head and
 * moves with you for a few seconds, then fades. Catch another while you're still wearing
 * one and the old head cracks in two and falls off, for bonus points (more for each
 * crack in a row). 60-second rounds, 1–4 players.
 *
 * Artwork: art/generate.py (Gemini, Pixar-ish cartoon style) -> public/art.
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
  screenMapper,
  theme,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

type Kind = 'pumpkin' | 'skull' | 'ghost' | 'vampire';
const KINDS: Kind[] = ['pumpkin', 'skull', 'ghost', 'vampire'];

/** How long a caught head stays on, and how long it takes to fade at the end (ms). */
const WEAR_MS = 4000;
const FADE_MS = 600;
const CATCH_POINTS = 1;
/** Extra for cracking a head off with a new one; grows with each crack in a row. */
const CRACK_BONUS = 2;

interface Falling {
  kind: Kind;
  /** Screen pixels. */
  x: number;
  y: number;
  vy: number;
  rot: number;
  spin: number;
  /** For the ghost's sway and the vampire's swoops. */
  phase: number;
  baseX: number;
}

interface Worn {
  kind: Kind;
  since: number;
  /** Snap animation: where it was caught (pixels). */
  from: Vec2;
}

interface Half {
  kind: Kind;
  side: -1 | 1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  size: number;
  at: number;
}

interface Pop {
  x: number;
  y: number;
  text: string;
  color: string;
  at: number;
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame();
const assets = await loadAssets({
  images: {
    pumpkin: 'art/pumpkin.png',
    skull: 'art/skull.png',
    ghost: 'art/ghost.png',
    vampire: 'art/vampire.png',
    background: 'art/background.jpg',
  },
});
const flow = new RoundFlow(game, {
  title: 'Halloween Heads',
  subtitle: 'Catch the falling heads with your head! Raise both hands to start.',
  seconds: 60,
});

let falling: Falling[] = [];
let halves: Half[] = [];
let pops: Pop[] = [];
/** By player id. */
const worn = new Map<number, Worn>();
/** Cracks in a row per player id (reset when a head fades off). */
const streak = new Map<number, number>();
let nextSpawn = 0;
let W = 1;
let H = 1;
let mapper = screenMapper(4 / 3, 1, 1);

prepareSpeech(['Catch the falling heads with your head!', 'Crack!', 'Double crack!']);

flow.on('start', () => {
  falling = [];
  halves = [];
  pops = [];
  worn.clear();
  streak.clear();
  nextSpawn = performance.now() + 800;
  say('Catch the falling heads with your head!');
});

/** A player's head on screen: centre, radius and tilt. Null if the face isn't seen. */
function headOf(p: Player): { x: number; y: number; r: number; tilt: number } | null {
  const k = p.keypoints;
  const ok = (i: number) => k[i].score > 0.3;
  if (!ok(KP.nose)) return null;
  const nose = mapper.map(k[KP.nose]);
  const eyes = ok(KP.leftEye) && ok(KP.rightEye) ? [mapper.map(k[KP.leftEye]), mapper.map(k[KP.rightEye])] : null;
  const ears = ok(KP.leftEar) && ok(KP.rightEar) ? [mapper.map(k[KP.leftEar]), mapper.map(k[KP.rightEar])] : null;
  // Head width: ear to ear when both show, otherwise from the shoulders.
  const r = Math.max(ears ? Math.hypot(ears[0].x - ears[1].x, ears[0].y - ears[1].y) * 0.75 : 0, mapper.len(p.shoulderWidth) * 0.45, H * 0.04);
  // Tilt from the eye line (mirrored image: the left eye is on the right of the screen).
  let tilt = 0;
  if (eyes) {
    const [l, rt] = eyes[0].x > eyes[1].x ? [eyes[1], eyes[0]] : [eyes[0], eyes[1]];
    tilt = Math.max(-0.6, Math.min(0.6, Math.atan2(rt.y - l.y, rt.x - l.x)));
  }
  // The middle of the head is a little above the nose.
  return { x: nose.x, y: nose.y - r * 0.25, r, tilt };
}

/** Falling heads are about this big (px). */
const fallSize = () => H * 0.17;

function spawn(now: number) {
  // Where players can actually reach: the part of the screen the camera covers.
  const left = Math.max(W * 0.06, mapper.map({ x: 0.08, y: 0 }).x);
  const right = Math.min(W * 0.94, mapper.map({ x: 0.92, y: 0 }).x);
  const kind = KINDS[Math.floor(Math.random() * KINDS.length)];
  const x = left + Math.random() * (right - left);
  // Speeds up through the round.
  const pace = 1 + flow.elapsed / 60;
  const speed = { pumpkin: 0.16, skull: 0.22, ghost: 0.12, vampire: 0.17 }[kind] * H * pace;
  falling.push({ kind, x, y: -fallSize(), vy: speed, rot: (Math.random() - 0.5) * 0.4, spin: (Math.random() - 0.5) * 1.2, phase: Math.random() * 6, baseX: x });
  const players = Math.max(1, game.frame.players.length);
  nextSpawn = now + (1700 - Math.min(800, flow.elapsed * 15)) / Math.sqrt(players);
}

function update(dt: number, now: number) {
  if (now >= nextSpawn) spawn(now);
  for (const f of falling) {
    f.phase += dt;
    f.y += f.vy * dt;
    f.rot += f.spin * dt;
    if (f.kind === 'ghost') f.x = f.baseX + Math.sin(f.phase * 2.2) * W * 0.05; // floaty sway
    if (f.kind === 'vampire') f.x = f.baseX + Math.sin(f.phase * 3.5) * W * 0.03; // bat-like swoops
  }
  falling = falling.filter((f) => f.y < H + fallSize());

  // Catch: a falling head close enough to a player's head snaps on.
  for (const p of game.frame.players) {
    const head = headOf(p);
    if (!head) continue;
    const reach = Math.max(head.r * 1.1, H * 0.06);
    const i = falling.findIndex((f) => Math.hypot(f.x - head.x, f.y - head.y) < reach);
    if (i < 0) continue;
    const f = falling.splice(i, 1)[0];
    const old = worn.get(p.id);
    let points = CATCH_POINTS;
    if (old) {
      const n = (streak.get(p.id) ?? 0) + 1;
      streak.set(p.id, n);
      points += CRACK_BONUS * n;
      crack(old.kind, head, now);
      pops.push({ x: head.x, y: head.y - head.r * 2.2, text: `CRACK! +${points}`, color: theme.accent, at: now });
      say(n >= 2 ? 'Double crack!' : 'Crack!', { interrupt: true });
    } else {
      pops.push({ x: head.x, y: head.y - head.r * 2.2, text: `+${points}`, color: p.color, at: now });
      blip(520, 140, 'triangle', 0.15, 880);
    }
    worn.set(p.id, { kind: f.kind, since: now, from: { x: f.x, y: f.y } });
    flow.addScore(p.slot, points);
  }

  // Worn heads fade off after a while (and the crack streak ends).
  for (const [id, wh] of worn) {
    if (now - wh.since > WEAR_MS || !game.frame.players.some((p) => p.id === id)) {
      worn.delete(id);
      streak.delete(id);
    }
  }
}

/** The old head splits down a jagged line; the halves tumble away. */
function crack(kind: Kind, head: { x: number; y: number; r: number }, now: number) {
  noise(260, 0.35);
  blip(200, 220, 'square', 0.15, 60);
  const size = head.r * 2.7;
  for (const side of [-1, 1] as const) {
    halves.push({
      kind,
      side,
      x: head.x,
      y: head.y,
      vx: side * (120 + Math.random() * 80),
      vy: -260 - Math.random() * 80,
      rot: 0,
      spin: side * (2 + Math.random() * 2),
      size,
      at: now,
    });
  }
}

// The jagged crack, as x offsets (fraction of size) from top to bottom.
const CRACK = [0.02, -0.06, 0.05, -0.04, 0.07, -0.03, 0.04, 0];

function drawHalf(hf: Half, now: number) {
  const age = (now - hf.at) / 1000;
  const img = assets.images[hf.kind];
  const s = hf.size;
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - age / 1.4);
  ctx.translate(hf.x, hf.y);
  ctx.rotate(hf.rot);
  ctx.beginPath();
  // Clip to this side of the crack line.
  ctx.moveTo(hf.side * s, -s / 2);
  CRACK.forEach((dx, i) => ctx.lineTo(dx * s, -s / 2 + (s * i) / (CRACK.length - 1)));
  ctx.lineTo(hf.side * s, s / 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, -s / 2, -s / 2, s, s);
  // Dark edge along the break.
  ctx.strokeStyle = 'rgba(30,10,40,0.8)';
  ctx.lineWidth = Math.max(2, s * 0.02);
  ctx.beginPath();
  CRACK.forEach((dx, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, dx * s, -s / 2 + (s * i) / (CRACK.length - 1)));
  ctx.stroke();
  ctx.restore();
}

// ---------- frame ----------

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  flow.update(now);
  if (flow.playing) update(dt, now);

  drawBackground();
  game.drawPeople(ctx, W, H); // the players themselves, behind everything else
  const players = game.frame.players;
  for (const p of players) drawSkeleton(ctx, p, mapper.map, { alpha: 0.35, lineWidth: 10, head: false });

  for (const f of falling) {
    const s = fallSize();
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    if (f.kind === 'ghost') ctx.globalAlpha = 0.85 + Math.sin(f.phase * 4) * 0.1;
    ctx.drawImage(assets.images[f.kind], -s / 2, -s / 2, s, s);
    ctx.restore();
  }

  // Players' heads: what they're wearing, or a ring showing where their head is.
  for (const p of players) {
    const head = headOf(p);
    if (!head) continue;
    const wh = worn.get(p.id);
    if (wh) {
      const age = now - wh.since;
      const snap = Math.min(1, age / 150);
      const x = wh.from.x + (head.x - wh.from.x) * snap;
      const y = wh.from.y + (head.y - wh.from.y) * snap;
      const s = head.r * 2.7 * (1 + Math.max(0, 0.15 - age / 1000)); // little pop on landing
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (WEAR_MS - age) / FADE_MS));
      ctx.translate(x, y);
      ctx.rotate(head.tilt);
      ctx.drawImage(assets.images[wh.kind], -s / 2, -s / 2, s, s);
      ctx.restore();
      // Time left on this head.
      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(head.x, head.y, head.r * 1.55, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, 1 - age / WEAR_MS));
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 10]);
      ctx.lineDashOffset = -now / 40;
      ctx.beginPath();
      ctx.arc(head.x, head.y, head.r * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const hf of halves) {
    hf.vy += 900 * dt;
    hf.x += hf.vx * dt;
    hf.y += hf.vy * dt;
    hf.rot += hf.spin * dt;
    drawHalf(hf, now);
  }
  halves = halves.filter((hf) => now - hf.at < 1400);

  for (const pp of pops) {
    const age = (now - pp.at) / 1000;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age);
    drawText(ctx, pp.text, pp.x, pp.y - age * H * 0.08, H / 16, pp.color);
    ctx.restore();
  }
  pops = pops.filter((pp) => now - pp.at < 1000);

  flow.drawOverlay(ctx, W, H);
  requestAnimationFrame(loop);
}

/** The night scene, covering the screen, slightly dimmed so the heads stand out. */
function drawBackground() {
  const img = assets.images.background;
  const k = Math.max(W / img.width, H / img.height);
  ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
  ctx.fillStyle = 'rgba(15, 5, 35, 0.25)';
  ctx.fillRect(0, 0, W, H);
}

// Read-only peek for automated tests and debugging.
(window as unknown as { halloween: () => object }).halloween = () => ({
  state: flow.state,
  scores: flow.scores,
  falling: falling.map((f) => `${f.kind}@${Math.round(f.x)},${Math.round(f.y)}`),
  worn: [...worn.entries()].map(([id, wh]) => `${id}:${wh.kind}`),
  heads: game.frame.players.map((p) => headOf(p)).map((hd) => hd && `${Math.round(hd.x)},${Math.round(hd.y)} r${Math.round(hd.r)}`),
});

requestAnimationFrame(loop);
