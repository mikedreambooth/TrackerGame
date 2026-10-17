/**
 * Silly Mirror — the "hello world" of the console. Everyone in view becomes a
 * cartoon with googly eyes and a hat. Fast hands throw sparkles, jumps go BOING,
 * hands up sets off confetti. No rules, no losing: perfect for the first go.
 */
import { BONES, KP, blip, createGame, fitCanvas, screenMapper, type Player, type Vec2 } from '@trackergame/sdk';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// No rules and nothing to lose, so no auto-pause needed.
const game = await createGame({ autoPause: false });

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  shape: 'dot' | 'star' | 'rect';
  spin: number;
}
interface Pop {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}
interface Eyes {
  l: Vec2;
  r: Vec2;
  lv: Vec2;
  rv: Vec2;
}

const particles: Particle[] = [];
const pops: Pop[] = [];
const eyes = new Map<number, Eyes>();
let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);
/** Arms and legs only — the torso is drawn as a filled shape. */
const TORSO = new Set<number>([KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip]);
const LIMBS = BONES.filter(([a, b]) => !(TORSO.has(a) && TORSO.has(b)));
const CONFETTI = ['#ff4d6d', '#3a86ff', '#ffbe0b', '#2ec4b6', '#ffffff', '#8338ec'];

function burst(x: number, y: number, n: number, colors: string[], speed: number, shape: Particle['shape']) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random());
    particles.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - speed * 0.3,
      life: 0,
      max: 0.8 + Math.random() * 0.8,
      size: 6 + Math.random() * 10,
      color: colors[(Math.random() * colors.length) | 0],
      shape,
      spin: Math.random() * 10 - 5,
    });
  }
}

const find = (id: number) => game.frame.players.find((p) => p.id === id);

game.on('jump', (e) => {
  const p = find(e.playerId);
  if (!p) return;
  const c = mapper.map(p.center);
  burst(c.x, c.y + mapper.len(p.shoulderWidth), 30, ['#ffbe0b', '#fff'], 500, 'star');
  pops.push({ x: c.x, y: c.y - mapper.len(p.shoulderWidth) * 2.5, text: 'BOING!', color: p.color, life: 0 });
  blip(300, 300, 'square', 0.12, 900);
});

game.on('handsUp', (e) => {
  const p = find(e.playerId);
  if (!p) return;
  for (const w of [KP.leftWrist, KP.rightWrist]) {
    const s = mapper.map(p.keypoints[w]);
    burst(s.x, s.y, 40, CONFETTI, 600, 'rect');
  }
  blip(880, 200, 'triangle', 0.15, 1320);
});

game.on('join', () => blip(520, 150, 'sine', 0.2, 780));

// Every gesture gets a cartoon reaction, so kids discover them by playing.
function shout(playerId: number, text: string, at: number, colors: string[], freq: number, slide: number) {
  const p = find(playerId);
  if (!p) return;
  const s = mapper.map(p.keypoints[at]);
  burst(s.x, s.y, 24, colors, 450, 'star');
  pops.push({ x: s.x, y: s.y - mapper.len(p.shoulderWidth), text, color: p.color, life: 0 });
  blip(freq, 220, 'square', 0.1, slide);
}
game.on('clap', (e) => {
  const p = find(e.playerId);
  if (!p) return;
  const a = mapper.map(p.keypoints[KP.leftWrist]);
  const b = mapper.map(p.keypoints[KP.rightWrist]);
  burst((a.x + b.x) / 2, (a.y + b.y) / 2, 30, CONFETTI, 500, 'rect');
  pops.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 60, text: 'CLAP!', color: p.color, life: 0 });
  blip(1200, 90, 'square', 0.12, 600);
});
game.on('punch', (e) =>
  shout(e.playerId, 'POW!', e.hand === 'left' ? KP.leftWrist : KP.rightWrist, ['#ff4d6d', '#ffbe0b'], 220, 110),
);
game.on('kick', (e) =>
  shout(e.playerId, 'KICK!', e.foot === 'left' ? KP.leftAnkle : KP.rightAnkle, ['#2ec4b6', '#fff'], 300, 150),
);
game.on('crouch', (e) => shout(e.playerId, 'SQUISH!', KP.nose, ['#8338ec', '#fff'], 500, 200));
game.on('lean', (e) => shout(e.playerId, e.direction === 'left' ? '⟵ WHOA!' : 'WHOA! ⟶', KP.nose, ['#3a86ff'], 400, 600));
game.on('armsOut', (e) => shout(e.playerId, 'WHEEE! ✈', KP.nose, ['#ffbe0b', '#fff'], 600, 1200));
game.on('leave', (e) => eyes.delete(e.playerId));

let last = performance.now();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);

  background(now);
  const players = game.frame.players;
  for (const p of players) {
    sparkles(p);
    drawCartoon(p, dt, now);
  }
  updateParticles(dt);
  if (!players.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `900 ${Math.round(H / 14)}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Step in front of the mirror!', W / 2, H / 2);
  }
  requestAnimationFrame(frame);
}

function background(now: number) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2b1260');
  g.addColorStop(1, '#120f2b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Floating bubbles.
  for (let i = 0; i < 18; i++) {
    const x = ((i * 137) % 100) / 100 * W + Math.sin(now / 2000 + i) * 30;
    const y = H - (((now / 40 + i * 211) % (H + 200)) - 100);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.arc(x, y, 20 + (i % 5) * 12, 0, Math.PI * 2);
    ctx.fill();
  }
  // Floor.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, H * 0.86, W, H * 0.14);
}

function sparkles(p: Player) {
  for (const w of [KP.leftWrist, KP.rightWrist]) {
    const k = p.keypoints[w];
    if (k.score < 0.4) continue;
    const speed = Math.hypot(k.vx, k.vy); // normalised units/sec
    if (speed > 1.2 && Math.random() < 0.8) {
      const s = mapper.map(k);
      burst(s.x, s.y, 2, [p.color, '#fff'], 120, 'dot');
    }
  }
}

function drawCartoon(p: Player, dt: number, now: number) {
  const k = p.keypoints;
  const S = (i: number) => mapper.map(k[i]);
  const ok = (i: number) => k[i].score > 0.3;
  const sw = mapper.len(p.shoulderWidth);
  const limb = Math.max(14, sw * 0.32);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Body: a rounded torso polygon.
  if ([KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip].every(ok)) {
    const pts = [S(KP.leftShoulder), S(KP.rightShoulder), S(KP.rightHip), S(KP.leftHip)];
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = limb * 1.2;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Belly stripe.
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    const c = mapper.map(p.center);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, sw * 0.25, sw * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Limbs with outline.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? p.color : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = pass ? limb : limb + 8;
    for (const [a, b] of LIMBS) {
      if (!ok(a) || !ok(b)) continue;
      const pa = S(a);
      const pb = S(b);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }

  // Hands and feet.
  ctx.fillStyle = '#fff';
  for (const i of [KP.leftWrist, KP.rightWrist]) {
    if (!ok(i)) continue;
    const s = S(i);
    ctx.beginPath();
    ctx.arc(s.x, s.y, limb * 0.85, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#1b1030';
  for (const i of [KP.leftAnkle, KP.rightAnkle]) {
    if (!ok(i)) continue;
    const s = S(i);
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + limb * 0.3, limb, limb * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Head.
  if (ok(KP.nose)) {
    const n = S(KP.nose);
    const r = Math.max(30, sw * 0.55);
    const hc = { x: n.x, y: n.y - r * 0.15 };
    ctx.fillStyle = '#ffd6a5';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(hc.x, hc.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    googlyEyes(p, hc, r, dt);
    // Smile that grows when moving.
    const energy = Math.min(1, Math.hypot(k[KP.leftWrist].vx, k[KP.leftWrist].vy, k[KP.rightWrist].vx, k[KP.rightWrist].vy) / 3);
    ctx.strokeStyle = '#1b1030';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(hc.x, hc.y + r * 0.25, r * (0.25 + energy * 0.2), 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    hat(p.slot, hc, r, p.color, now);
  }
  ctx.restore();
}

function googlyEyes(p: Player, hc: Vec2, r: number, dt: number) {
  const offL = { x: hc.x - r * 0.38, y: hc.y - r * 0.2 };
  const offR = { x: hc.x + r * 0.38, y: hc.y - r * 0.2 };
  let e = eyes.get(p.id);
  if (!e) {
    e = { l: { ...offL }, r: { ...offR }, lv: { x: 0, y: 0 }, rv: { x: 0, y: 0 } };
    eyes.set(p.id, e);
  }
  // Pupils are springs hanging inside the eye: they lag and wobble.
  const spring = (pos: Vec2, vel: Vec2, anchor: Vec2) => {
    const ax = (anchor.x - pos.x) * 60 - vel.x * 4;
    const ay = (anchor.y - pos.y) * 60 - vel.y * 4 + 400; // gravity
    vel.x += ax * dt;
    vel.y += ay * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    const max = r * 0.17;
    const dx = pos.x - anchor.x;
    const dy = pos.y - anchor.y;
    const d = Math.hypot(dx, dy);
    if (d > max) {
      pos.x = anchor.x + (dx / d) * max;
      pos.y = anchor.y + (dy / d) * max;
    }
  };
  spring(e.l, e.lv, offL);
  spring(e.r, e.rv, offR);
  for (const [o, pu] of [
    [offL, e.l],
    [offR, e.r],
  ] as const) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1b1030';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(o.x, o.y, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1b1030';
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }
}

function hat(slot: number, hc: Vec2, r: number, color: string, now: number) {
  const top = hc.y - r * 0.85;
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  switch (slot) {
    case 0: // party hat
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(hc.x - r * 0.55, top + r * 0.1);
      ctx.lineTo(hc.x, top - r * 1.1);
      ctx.lineTo(hc.x + r * 0.55, top + r * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffbe0b';
      ctx.beginPath();
      ctx.arc(hc.x, top - r * 1.1, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 1: // crown
      ctx.fillStyle = '#ffbe0b';
      ctx.beginPath();
      ctx.moveTo(hc.x - r * 0.6, top + r * 0.1);
      for (let i = 0; i <= 4; i++) {
        const x = hc.x - r * 0.6 + (i * r * 1.2) / 4;
        ctx.lineTo(x, i % 2 ? top - r * 0.2 : top - r * 0.6);
      }
      ctx.lineTo(hc.x + r * 0.6, top + r * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case 2: // top hat
      ctx.fillStyle = '#1b1030';
      ctx.fillRect(hc.x - r * 0.75, top - r * 0.05, r * 1.5, r * 0.2);
      ctx.fillRect(hc.x - r * 0.45, top - r * 0.9, r * 0.9, r * 0.9);
      ctx.fillStyle = color;
      ctx.fillRect(hc.x - r * 0.45, top - r * 0.3, r * 0.9, r * 0.18);
      break;
    default: {
      // wobbly antenna
      const sway = Math.sin(now / 200) * r * 0.3;
      ctx.strokeStyle = '#1b1030';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(hc.x, top + r * 0.1);
      ctx.quadraticCurveTo(hc.x, top - r * 0.5, hc.x + sway, top - r * 0.9);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hc.x + sway, top - r * 0.9, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function updateParticles(dt: number) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life += dt;
    if (q.life > q.max) {
      particles.splice(i, 1);
      continue;
    }
    q.vy += 900 * dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    const a = 1 - q.life / q.max;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = q.color;
    ctx.translate(q.x, q.y);
    ctx.rotate(q.spin * q.life);
    if (q.shape === 'rect') ctx.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2);
    else if (q.shape === 'star') star(q.size);
    else {
      ctx.beginPath();
      ctx.arc(0, 0, q.size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.life += dt;
    if (p.life > 1) {
      pops.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = 1 - p.life;
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6;
    ctx.font = `900 ${Math.round(H / 12)}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const y = p.y - p.life * 80;
    ctx.strokeText(p.text, p.x, y);
    ctx.fillText(p.text, p.x, y);
    ctx.restore();
  }
  if (particles.length > 800) particles.splice(0, particles.length - 800);
}

function star(size: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? size * 0.45 : size;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

requestAnimationFrame(frame);
