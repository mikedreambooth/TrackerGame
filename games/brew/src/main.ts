/**
 * Witches' Brew — a cauldron bubbles in the middle of the cottage. The recipe scroll says
 * which three ingredients the potion needs. Ingredients float through the air: grab one
 * with a hand, then throw it at the cauldron (or just carry it over and drop it in).
 * Right ingredient: splash and a point; all three: the potion's done, poof, and a new
 * recipe. Wrong one: the cauldron burps a cloud of smelly smoke. 90-second rounds,
 * 1–4 players working on the same potion.
 *
 * Throws are helped: anything thrown roughly towards the cauldron flies in on an arc.
 *
 * Artwork: art/generate.py (Gemini) -> public/art.
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

const INGREDIENTS = ['frog', 'eyeball', 'bat', 'toadstool', 'spider', 'crystal'] as const;
type Ingredient = (typeof INGREDIENTS)[number];
const NAMES: Record<Ingredient, string> = {
  frog: 'a frog',
  eyeball: 'an eyeball',
  bat: 'a bat',
  toadstool: 'a toadstool',
  spider: 'a spider',
  crystal: 'a magic crystal',
};
/** Each new potion turns the brew a new colour. */
const POTIONS = ['#7CFC00', '#ff4fd8', '#40c4ff', '#ffd23f', '#b388ff', '#ff6b35'];
const RECIPE_SIZE = 3;
const RECIPE_BONUS = 3;
/** A grabbed ingredient can't be thrown straight away (catching is a fast move too). */
const HOLD_BEFORE_THROW_MS = 250;

interface Floater {
  kind: Ingredient;
  x: number;
  y: number;
  vx: number;
  baseY: number;
  phase: number;
  spin: number;
}

interface Thrown {
  kind: Ingredient;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  /** Player slot that threw it (for the points). */
  slot: number;
  color: string;
  /** Aimed at the cauldron: lands in it when it comes down. */
  aimed: boolean;
}

interface Held {
  kind: Ingredient;
  since: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  life: number;
  age: number;
  /** Smoke rises and grows; everything else falls. */
  smoke?: boolean;
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
    cauldron: 'art/cauldron.png',
    background: 'art/background.jpg',
    ...Object.fromEntries(INGREDIENTS.map((k) => [k, `art/${k}.png`])),
  },
});
const flow = new RoundFlow(game, {
  title: "Witches' Brew",
  subtitle: 'Catch what the recipe needs and throw it in the cauldron! Raise both hands to start.',
  seconds: 90,
});

let floaters: Floater[] = [];
let thrown: Thrown[] = [];
let particles: Particle[] = [];
let pops: Pop[] = [];
/** By `${playerId}:${side}`. */
const held = new Map<string, Held>();
let recipe: Ingredient[] = [];
let added = new Set<Ingredient>();
let potion = 0;
let potionsMade = 0;
let nextSpawn = 0;
let burpAt = -1e9;
let poofAt = -1e9;
let W = 1;
let H = 1;
let mapper = screenMapper(4 / 3, 1, 1);

prepareSpeech([
  "Witches' Brew! Catch the ingredients and throw them in the cauldron!",
  'Potion complete!',
  'Yuck!',
  'Splash!',
]);

flow.on('start', () => {
  floaters = [];
  thrown = [];
  particles = [];
  pops = [];
  held.clear();
  potionsMade = 0;
  newRecipe();
  nextSpawn = performance.now() + 500;
  say("Witches' Brew! Catch the ingredients and throw them in the cauldron!");
});

function newRecipe() {
  const pool = [...INGREDIENTS].sort(() => Math.random() - 0.5);
  recipe = pool.slice(0, RECIPE_SIZE);
  added = new Set();
  potion = (potion + 1) % POTIONS.length;
  setTimeout(() => say(`We need ${NAMES[recipe[0]]}, ${NAMES[recipe[1]]} and ${NAMES[recipe[2]]}!`), potionsMade ? 1800 : 3500);
}

const needed = () => recipe.filter((k) => !added.has(k));

// ---------- layout ----------

const itemSize = () => H * 0.13;
const cauldronSize = () => H * 0.46;
/** Where the cauldron stands: on the floor line the players' feet are on. */
const floorY = () => H * Math.min(0.99, (game.frame.baseline ?? 0.95) + 0.02);
/** The cauldron's opening: where things go in. */
function mouth(): { x: number; y: number; rx: number; ry: number } {
  const s = cauldronSize();
  const top = floorY() - s;
  return { x: W / 2, y: top + s * 0.13, rx: s * 0.36, ry: s * 0.07 };
}

/** A point just beyond the wrist, where the fingers are, in pixels. */
function handOf(p: Player, side: 'left' | 'right'): Vec2 | null {
  const k = p.keypoints;
  const wrist = k[side === 'left' ? KP.leftWrist : KP.rightWrist];
  const elbow = k[side === 'left' ? KP.leftElbow : KP.rightElbow];
  if (wrist.score < 0.35) return null;
  const tip = elbow.score >= 0.35 ? { x: wrist.x + (wrist.x - elbow.x) * 0.3, y: wrist.y + (wrist.y - elbow.y) * 0.3 } : wrist;
  return mapper.map(tip);
}

/** Hand velocity in pixels per second. */
function handVelocity(p: Player, side: 'left' | 'right'): Vec2 {
  const k = p.keypoints[side === 'left' ? KP.leftWrist : KP.rightWrist];
  return { x: mapper.len(k.vx * game.frame.aspect), y: mapper.len(k.vy) };
}

/** The hand's swing on its own, without the body's movement (pixels per second). */
function swingVelocity(p: Player, side: 'left' | 'right'): Vec2 {
  const v = handVelocity(p, side);
  const s = p.transform?.scale ?? 1;
  return { x: v.x - mapper.len((p.motion?.vx ?? 0) * s * game.frame.aspect), y: v.y - mapper.len((p.motion?.vy ?? 0) * s) };
}

// ---------- play ----------

function spawn(now: number) {
  const fromLeft = Math.random() < 0.5;
  const want = needed();
  // Mostly things the recipe needs, so there's always something to catch.
  const kind = want.length && Math.random() < 0.6 ? want[Math.floor(Math.random() * want.length)] : INGREDIENTS[Math.floor(Math.random() * INGREDIENTS.length)];
  const speed = W * (0.09 + Math.random() * 0.06) * (1 + flow.elapsed / 120);
  const y = H * (0.2 + Math.random() * 0.3);
  floaters.push({ kind, x: fromLeft ? -itemSize() : W + itemSize(), y, baseY: y, vx: fromLeft ? speed : -speed, phase: Math.random() * 6, spin: (Math.random() - 0.5) * 1.5 });
  nextSpawn = now + Math.max(700, 1500 - flow.elapsed * 6) / Math.sqrt(Math.max(1, game.frame.players.length));
}

function update(dt: number, now: number) {
  if (now >= nextSpawn && floaters.length < 7) spawn(now);
  for (const f of floaters) {
    f.phase += dt;
    f.x += f.vx * dt;
    f.y = f.baseY + Math.sin(f.phase * 2) * H * 0.03;
  }
  floaters = floaters.filter((f) => f.x > -itemSize() * 2 && f.x < W + itemSize() * 2);

  const m = mouth();
  const seen = new Set<string>();
  for (const p of game.frame.players) {
    for (const side of ['left', 'right'] as const) {
      const id = `${p.id}:${side}`;
      seen.add(id);
      const hand = handOf(p, side);
      if (!hand) continue;
      const h = held.get(id);
      if (!h) {
        // Grab: touch a floating ingredient.
        const i = floaters.findIndex((f) => Math.hypot(f.x - hand.x, f.y - hand.y) < itemSize() * 0.6);
        if (i >= 0) {
          held.set(id, { kind: floaters[i].kind, since: now });
          floaters.splice(i, 1);
          blip(700, 90, 'triangle', 0.12, 1100);
          sparkle(hand.x, hand.y, p.color, 8);
        }
        continue;
      }
      // Carried over the cauldron: drop it in.
      if (Math.abs(hand.x - m.x) < m.rx && hand.y > m.y - H * 0.12 && hand.y < m.y + H * 0.05) {
        held.delete(id);
        land(h.kind, p.slot, p.color);
        continue;
      }
      // Thrown: a fast swing of the arm lets go (walking or jumping while carrying doesn't).
      const swing = swingVelocity(p, side);
      const speed = Math.hypot(swing.x, swing.y);
      const v = handVelocity(p, side);
      if (now - h.since > HOLD_BEFORE_THROW_MS && speed > Math.max(mapper.len(p.shoulderWidth) * 4.5, H * 0.9)) {
        held.delete(id);
        throwIt(h.kind, hand, v, p);
      }
    }
  }
  // Hands that left the camera drop what they held.
  for (const id of held.keys()) if (!seen.has(id)) held.delete(id);

  for (const t of thrown) {
    t.vy += H * 2 * dt;
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.rot += t.spin * dt;
  }
  thrown = thrown.filter((t) => {
    if (t.aimed && t.vy > 0 && t.y >= m.y && Math.abs(t.x - m.x) < m.rx * 1.2) {
      land(t.kind, t.slot, t.color);
      return false;
    }
    return t.y < H + itemSize() && t.x > -itemSize() * 2 && t.x < W + itemSize() * 2;
  });
}

/**
 * Let go of an ingredient. Anything thrown roughly towards the cauldron is put on an arc that
 * lands in it (kids aren't great shots at a camera); throw it away and it's gone.
 */
function throwIt(kind: Ingredient, from: Vec2, v: Vec2, p: Player) {
  const m = mouth();
  const dx = m.x - from.x;
  const dy = m.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const speed = Math.hypot(v.x, v.y) || 1;
  const towards = (v.x * dx + v.y * dy) / (dist * speed) > Math.cos((75 * Math.PI) / 180);
  const t = Math.min(1.1, Math.max(0.45, dist / (speed * 1.2)));
  const g = H * 2;
  thrown.push({
    kind,
    x: from.x,
    y: from.y,
    vx: towards ? dx / t : v.x,
    vy: towards ? dy / t - 0.5 * g * t : v.y,
    rot: 0,
    spin: (Math.random() - 0.5) * 12,
    slot: p.slot,
    color: p.color,
    aimed: towards,
  });
  noise(90, 0.12);
}

/** Something went in the pot. */
function land(kind: Ingredient, slot: number, color: string) {
  const m = mouth();
  const now = performance.now();
  const brew = POTIONS[potion];
  if (needed().includes(kind)) {
    added.add(kind);
    flow.addScore(slot, 1);
    splash(m.x, m.y, brew, 24);
    pops.push({ x: m.x, y: m.y - H * 0.12, text: '+1', color, at: now });
    blip(330, 160, 'sine', 0.2, 120);
    setTimeout(() => blip(520, 120, 'sine', 0.15, 900), 120);
    if (!needed().length) {
      potionsMade++;
      poofAt = now;
      for (const p of game.frame.players) flow.addScore(p.slot, RECIPE_BONUS);
      pops.push({ x: m.x, y: m.y - H * 0.25, text: `Potion complete! +${RECIPE_BONUS}`, color: theme.accent, at: now });
      say('Potion complete!', { interrupt: true });
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 180, 'triangle', 0.15), i * 120));
      sparkle(m.x, m.y - H * 0.05, '#fff', 30);
      for (const c of POTIONS) sparkle(m.x, m.y - H * 0.05, c, 8);
      setTimeout(newRecipe, 1200);
    }
  } else {
    burpAt = now;
    pops.push({ x: m.x, y: m.y - H * 0.12, text: 'Yuck!', color: '#a7c957', at: now });
    say('Yuck!', { interrupt: true });
    noise(400, 0.25);
    blip(110, 400, 'sawtooth', 0.12, 60);
    for (let i = 0; i < 14; i++) {
      particles.push({ x: m.x + (Math.random() - 0.5) * m.rx, y: m.y, vx: (Math.random() - 0.5) * 60, vy: -H * (0.15 + Math.random() * 0.15), r: H * (0.03 + Math.random() * 0.03), color: '#6b705c', life: 1.6, age: 0, smoke: true });
    }
  }
}

function splash(x: number, y: number, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const v = H * (0.5 + Math.random() * 0.6);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: H * (0.008 + Math.random() * 0.01), color, life: 0.9, age: 0 });
  }
}

function sparkle(x: number, y: number, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = H * (0.2 + Math.random() * 0.4);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: H * 0.007, color, life: 0.7, age: 0 });
  }
}

// ---------- drawing ----------

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  flow.update(now);
  if (flow.playing) update(dt, now);

  drawBackground();
  game.drawPeople(ctx, W, H); // the players themselves, behind the cauldron and menus
  const players = game.frame.players;
  // The hands are drawn below (with what they hold); the cut-outs show the rest. Without
  // cut-outs (G off, simulator) a faint body so players can see where they are.
  if (!game.peopleVisible) for (const p of players) drawSkeleton(ctx, p, mapper.map, { alpha: 0.3, lineWidth: 10 });
  drawCauldron(now);
  if (flow.state !== 'lobby') drawRecipe(now);

  const s = itemSize();
  for (const f of floaters) {
    const want = needed().includes(f.kind);
    // A soft glow behind the ones the recipe needs.
    if (want) {
      ctx.save();
      ctx.globalAlpha = 0.45 + Math.sin(now / 200) * 0.15;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, s * 0.7);
      g.addColorStop(0, theme.accent);
      g.addColorStop(1, 'rgba(255,190,11,0)');
      ctx.fillStyle = g;
      ctx.fillRect(f.x - s, f.y - s, s * 2, s * 2);
      ctx.restore();
    }
    drawItem(f.kind, f.x, f.y, s, Math.sin(f.phase) * 0.2);
  }
  for (const t of thrown) drawItem(t.kind, t.x, t.y, s, t.rot);

  // Hands, and whatever they're holding.
  for (const p of players) {
    for (const side of ['left', 'right'] as const) {
      const hand = handOf(p, side);
      if (!hand) continue;
      const h = held.get(`${p.id}:${side}`);
      if (h) drawItem(h.kind, hand.x, hand.y - s * 0.15, s * 1.05, Math.sin(now / 150) * 0.15);
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.globalAlpha = h ? 0.6 : 0.9;
      ctx.beginPath();
      ctx.arc(hand.x, hand.y, H * 0.022, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const pt of particles) {
    pt.age += dt;
    pt.vy += pt.smoke ? -H * 0.05 * dt : H * 1.2 * dt;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - pt.age / pt.life) * (pt.smoke ? 0.6 : 1);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.r * (pt.smoke ? 1 + pt.age : 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  particles = particles.filter((pt) => pt.age < pt.life);

  for (const pp of pops) {
    const age = (now - pp.at) / 1200;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age);
    drawText(ctx, pp.text, pp.x, pp.y - age * H * 0.1, H / 15, pp.color);
    ctx.restore();
  }
  pops = pops.filter((pp) => now - pp.at < 1200);

  flow.drawOverlay(ctx, W, H);
  requestAnimationFrame(loop);
}

function drawItem(kind: Ingredient, x: number, y: number, s: number, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.drawImage(assets.images[kind], -s / 2, -s / 2, s, s);
  ctx.restore();
}

function drawBackground() {
  const img = assets.images.background;
  const k = Math.max(W / img.width, H / img.height);
  ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
  ctx.fillStyle = 'rgba(20, 5, 35, 0.2)';
  ctx.fillRect(0, 0, W, H);
}

/** The cauldron, its brew tinted this potion's colour, bubbles, steam and the odd burp. */
function drawCauldron(now: number) {
  const s = cauldronSize();
  const m = mouth();
  const brew = POTIONS[potion];
  const burp = Math.max(0, 1 - (now - burpAt) / 500);
  const poof = Math.max(0, 1 - (now - poofAt) / 1500);
  // Glow above the pot.
  const glow = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, s * (0.8 + poof * 0.8));
  glow.addColorStop(0, brew + '88');
  glow.addColorStop(1, brew + '00');
  ctx.fillStyle = glow;
  ctx.fillRect(m.x - s * 2, m.y - s * 2, s * 4, s * 3);

  ctx.save();
  // A little wobble when it burps.
  ctx.translate(W / 2, floorY());
  ctx.scale(1 + burp * 0.06 * Math.sin(now / 30), 1 - burp * 0.05 * Math.sin(now / 30));
  ctx.drawImage(assets.images.cauldron, -s / 2, -s, s, s);
  ctx.restore();
  // Re-colour the brew on top.
  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.fillStyle = brew;
  ctx.beginPath();
  ctx.ellipse(m.x, m.y, m.rx * 0.95, m.ry * 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Bubbles rising and popping.
  for (let i = 0; i < 9; i++) {
    const cycle = ((now / 1000) * (0.6 + (i % 3) * 0.25) + i * 0.37) % 1;
    const bx = m.x + Math.sin(i * 12.9) * m.rx * 0.8;
    const by = m.y - cycle * s * (0.12 + poof * 0.3);
    ctx.save();
    ctx.globalAlpha = 1 - cycle;
    ctx.fillStyle = brew;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, s * (0.02 + 0.02 * ((i * 7) % 3)) * (0.6 + cycle * 0.6), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** The recipe scroll: three ingredient pictures, ticked off as they go in. */
function drawRecipe(now: number) {
  const n = recipe.length;
  const cell = H * 0.11;
  const pad = H * 0.02;
  const w = n * cell + (n + 1) * pad;
  const x0 = W / 2 - w / 2;
  const y0 = H * 0.05;
  ctx.save();
  ctx.fillStyle = '#f4e1b6';
  ctx.strokeStyle = '#8a5a2b';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, cell + pad * 2, pad);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  drawText(ctx, 'Recipe', W / 2, y0 - H * 0.005, H / 34, '#f4e1b6');
  recipe.forEach((k, i) => {
    const cx = x0 + pad + i * (cell + pad) + cell / 2;
    const cy = y0 + pad + cell / 2;
    const done = added.has(k);
    ctx.save();
    ctx.globalAlpha = done ? 0.4 : 1;
    const bounce = done ? 0 : Math.sin(now / 250 + i) * cell * 0.04;
    ctx.drawImage(assets.images[k], cx - cell / 2, cy - cell / 2 + bounce, cell, cell);
    ctx.restore();
    if (done) drawText(ctx, '✓', cx, cy, cell * 0.8, '#2a9d3a');
  });
  if (potionsMade) drawText(ctx, `Potions: ${potionsMade}`, x0 + w + H * 0.02, y0 + cell / 2 + pad, H / 30, '#f4e1b6', { align: 'left' });
}

// Read-only peek for automated tests and debugging.
(window as unknown as { brew: () => object }).brew = () => ({
  state: flow.state,
  scores: flow.scores,
  recipe,
  added: [...added],
  potionsMade,
  floaters: floaters.map((f) => `${f.kind}@${Math.round(f.x)},${Math.round(f.y)}`),
  held: [...held.entries()].map(([id, h]) => `${id}=${h.kind}`),
  thrown: thrown.length,
});

requestAnimationFrame(loop);
