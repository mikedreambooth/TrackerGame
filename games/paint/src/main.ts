/**
 * Air Painting — paint on the TV with your hands.
 *
 *  - Raise a hand to paint with it; lower it (below your waist) to stop.
 *  - Touch a paint pot along the top to change your colour (rainbow, sparkle
 *    and rubber too). Each player has their own brush.
 *  - Buttons (hold a hand on them, or tap): "Idea" — the voice suggests
 *    something to draw; "New picture"; "Home".
 *  - On a touch screen, fingers paint too.
 *
 * Free play: no timer, no scores.
 */
import {
  DwellMenu,
  KP,
  blip,
  createGame,
  drawText,
  fitCanvas,
  prepareSpeech,
  say,
  screenMapper,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

type Brush = { kind: 'color'; color: string } | { kind: 'rainbow' } | { kind: 'sparkle' } | { kind: 'eraser' };
const POTS: Brush[] = [
  { kind: 'color', color: '#e63946' },
  { kind: 'color', color: '#ff9f1c' },
  { kind: 'color', color: '#ffd60a' },
  { kind: 'color', color: '#2a9d3a' },
  { kind: 'color', color: '#3a86ff' },
  { kind: 'color', color: '#7209b7' },
  { kind: 'color', color: '#ff70a6' },
  { kind: 'color', color: '#8d5524' },
  { kind: 'color', color: '#1b1030' },
  { kind: 'rainbow' },
  { kind: 'sparkle' },
  { kind: 'eraser' },
];
const IDEAS = [
  'a snowman',
  'a Christmas tree',
  'a cat',
  'a dog',
  'a big smiley face',
  'a house',
  'a rocket',
  'a fish',
  'a rainbow',
  'the sun',
  'a monster',
  'a flower',
  'a car',
  'a dinosaur',
  'Santa',
  'a present',
  'your family',
  'a robot',
  'a butterfly',
  'a castle',
];
const PAPER = '#fdf6e3';
const TOOLBAR = 0.14; // top band (fraction of height): no painting here

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// Painting near the top with both hands up is normal — not "go home".
const game = await createGame({ exitGesture: false, autoPause: false });
prepareSpeech(['Paint something! Raise your hands to paint.', ...IDEAS.map((i) => `How about drawing ${i}?`), 'New picture!']);

let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);

// ---------- paper ----------

const paper = document.createElement('canvas');
const pctx = paper.getContext('2d')!;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
function fitPaper() {
  const w = Math.round(W * DPR);
  const h = Math.round(H * DPR);
  if (paper.width === w && paper.height === h) return;
  // Keep the picture when the window changes size.
  const old = paper.width ? (() => {
    const c = document.createElement('canvas');
    c.width = paper.width;
    c.height = paper.height;
    c.getContext('2d')!.drawImage(paper, 0, 0);
    return c;
  })() : null;
  paper.width = w;
  paper.height = h;
  pctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (old) pctx.drawImage(old, 0, 0, W, H);
}
function clearPaper() {
  pctx.save();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, paper.width, paper.height);
  pctx.restore();
}

// ---------- brushes ----------

interface Painter {
  brush: Brush;
  last: Map<number, Vec2 | null>; // per hand (wrist index or pointer id)
  hue: number;
}
const painters = new Map<string, Painter>();
function painter(key: string, slot: number): Painter {
  let p = painters.get(key);
  if (!p) painters.set(key, (p = { brush: POTS[[0, 4, 2, 3][slot % 4]], last: new Map(), hue: slot * 90 }));
  return p;
}

function strokeSeg(pt: Painter, a: Vec2, b: Vec2, width: number) {
  const br = pt.brush;
  pctx.save();
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';
  pctx.lineWidth = width;
  if (br.kind === 'eraser') {
    pctx.globalCompositeOperation = 'destination-out';
    pctx.lineWidth = width * 2.2;
    pctx.strokeStyle = '#000';
  } else if (br.kind === 'rainbow') {
    pt.hue = (pt.hue + Math.hypot(b.x - a.x, b.y - a.y) * 0.6) % 360;
    pctx.strokeStyle = `hsl(${pt.hue}, 90%, 55%)`;
  } else if (br.kind === 'sparkle') {
    pt.hue = (pt.hue + 7) % 360;
    pctx.strokeStyle = `hsla(${pt.hue}, 95%, 70%, 0.5)`;
    pctx.lineWidth = width * 0.5;
  } else pctx.strokeStyle = br.color;
  pctx.beginPath();
  pctx.moveTo(a.x, a.y);
  pctx.lineTo(b.x, b.y);
  pctx.stroke();
  if (br.kind === 'sparkle' && Math.random() < 0.6) {
    // Little stars along the line.
    const r = width * (0.35 + Math.random() * 0.4);
    const x = b.x + (Math.random() - 0.5) * width * 1.5;
    const y = b.y + (Math.random() - 0.5) * width * 1.5;
    pctx.fillStyle = `hsl(${(pt.hue + 60) % 360}, 100%, 60%)`;
    pctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r;
      const ang = (i * Math.PI) / 5 - Math.PI / 2;
      pctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
    }
    pctx.closePath();
    pctx.fill();
  }
  pctx.restore();
}

/** Continue (or start/stop) a stroke for one hand. Big jumps (tracking glitches) start a new stroke. */
function paintTo(pt: Painter, hand: number, at: Vec2 | null, width: number) {
  const prev = pt.last.get(hand) ?? null;
  if (at && prev && Math.hypot(at.x - prev.x, at.y - prev.y) < Math.max(W, H) * 0.2) strokeSeg(pt, prev, at, width);
  pt.last.set(hand, at);
}

// ---------- paint pots ----------

function potRect(i: number) {
  const n = POTS.length;
  const area = W * 0.66; // pots take the left two-thirds; buttons on the right
  const size = Math.min(H * TOOLBAR * 0.75, (area / n) * 0.85);
  const x = W * 0.02 + (area / n) * (i + 0.5);
  return { x, y: H * TOOLBAR * 0.5, r: size / 2 };
}
function potAt(p: Vec2): number {
  for (let i = 0; i < POTS.length; i++) {
    const r = potRect(i);
    if (Math.hypot(p.x - r.x, p.y - r.y) < r.r * 1.25) return i;
  }
  return -1;
}
function pickPot(pt: Painter, i: number) {
  if (pt.brush === POTS[i]) return;
  pt.brush = POTS[i];
  blip(500 + i * 60, 80, 'triangle', 0.12);
}

function drawPots(selected: Map<number, string[]>) {
  POTS.forEach((b, i) => {
    const { x, y, r } = potRect(i);
    ctx.save();
    // Pot
    ctx.fillStyle = '#e0d6c3';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.35, r * 1.05, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    // Paint
    if (b.kind === 'color') ctx.fillStyle = b.color;
    else if (b.kind === 'rainbow') {
      const g = ctx.createLinearGradient(x - r, y, x + r, y);
      ['#e63946', '#ff9f1c', '#ffd60a', '#2a9d3a', '#3a86ff', '#7209b7'].forEach((c, j) => g.addColorStop(j / 5, c));
      ctx.fillStyle = g;
    } else if (b.kind === 'sparkle') ctx.fillStyle = '#ffe66d';
    else ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (b.kind === 'sparkle') drawText(ctx, '✦', x, y, r * 1.2, '#ff70a6', { stroke: false });
    if (b.kind === 'eraser') drawText(ctx, '⌫', x, y, r * 1.1, '#555', { stroke: false });
    // Who's using it: coloured rings.
    (selected.get(i) ?? []).forEach((c, j) => {
      ctx.strokeStyle = c;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x, y, r + 5 + j * 7, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  });
}

// ---------- buttons ----------

/** Buttons follow the real hand position (like the pots), not the usual body-relative cursor. */
const handOnScreen = (p: Player): Vec2 | null => {
  const k = p.keypoints;
  const hipY = Math.min(k[KP.leftHip].y, k[KP.rightHip].y);
  const hands = [KP.leftWrist, KP.rightWrist].filter((i) => k[i].score > 0.4 && k[i].y < hipY);
  if (!hands.length) return null;
  const top = hands.reduce((a, b) => (k[a].y < k[b].y ? a : b));
  const s = mapper.map(k[top]);
  return { x: s.x / W, y: s.y / H };
};
const menu = new DwellMenu(
  [
    { id: 'idea', label: '💡 Idea', x: 0.74, y: TOOLBAR / 2, w: 0.1, h: TOOLBAR * 0.8, color: '#ffbe0b' },
    { id: 'new', label: 'New', x: 0.85, y: TOOLBAR / 2, w: 0.1, h: TOOLBAR * 0.8, color: '#06d6a0' },
    { id: 'home', label: 'Home', x: 0.95, y: TOOLBAR / 2, w: 0.08, h: TOOLBAR * 0.8, color: '#3a2a80' },
  ],
  1300,
  handOnScreen,
);
let idea = { text: '', t: 0 };
function onButton(id: string) {
  if (id === 'idea') {
    const pick = IDEAS[Math.floor(Math.random() * IDEAS.length)];
    idea = { text: `Draw ${pick}!`, t: performance.now() };
    void say(`How about drawing ${pick}?`, { interrupt: true });
  } else if (id === 'new') {
    clearPaper();
    blip(700, 200, 'sine', 0.12, 300);
    void say('New picture!', { interrupt: true });
  } else if (id === 'home') game.exit();
}

// ---------- touch / mouse painting ----------

// (In the launcher's simulator mode touches move the pretend hands instead.)
const touchPainter = painter('touch', 0);
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  const at = { x: e.clientX, y: e.clientY };
  if (at.y < H * TOOLBAR) {
    const i = potAt(at);
    if (i >= 0) pickPot(touchPainter, i);
    return;
  }
  touchPainter.last.set(e.pointerId, at);
  strokeSeg(touchPainter, at, { x: at.x + 0.1, y: at.y }, Math.max(8, H * 0.018));
});
canvas.addEventListener('pointermove', (e) => {
  if (!touchPainter.last.get(e.pointerId)) return;
  const at = { x: e.clientX, y: e.clientY };
  if (at.y < H * TOOLBAR) {
    touchPainter.last.set(e.pointerId, null);
    return;
  }
  paintTo(touchPainter, e.pointerId, at, Math.max(8, H * 0.018));
});
const lift = (e: PointerEvent) => touchPainter.last.set(e.pointerId, null);
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);

// ---------- loop ----------

let started = false;
function loop(now: number) {
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  fitPaper();
  const players = game.frame.players;
  if (!started && players.length) {
    started = true;
    void say('Paint something! Raise your hands to paint.');
  }

  // Hands paint (or pick pots).
  for (const p of players) {
    const pt = painter(`p${p.id}`, p.slot);
    const k = p.keypoints;
    const hipY = Math.min(k[KP.leftHip].y, k[KP.rightHip].y);
    const sw = Math.max(p.shoulderWidth, 0.03);
    const width = Math.max(6, mapper.len(sw) * 0.16);
    for (const w of [KP.leftWrist, KP.rightWrist]) {
      const kp = k[w];
      const raised = kp.score > 0.5 && kp.y < hipY - sw * 0.15;
      const at = raised ? mapper.map(kp) : null;
      if (at && at.y < H * TOOLBAR) {
        const i = potAt(at);
        if (i >= 0) pickPot(pt, i);
        paintTo(pt, w, null, width);
        continue;
      }
      paintTo(pt, w, at, width);
    }
  }
  const pick = menu.update(players, now);
  if (pick) onButton(pick);

  // Draw: paper, picture, faint players, hand brushes, toolbar.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(120, 100, 60, 0.06)';
  ctx.lineWidth = 1;
  for (let y = H * TOOLBAR; y < H; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.drawImage(paper, 0, 0, W, H);

  for (const p of players) {
    const k = p.keypoints;
    // A faint outline of yourself, so you know where you are.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = p.color;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(6, mapper.len(p.shoulderWidth) * 0.12);
    for (const [a, b] of [
      [KP.leftShoulder, KP.rightShoulder],
      [KP.leftShoulder, KP.leftElbow],
      [KP.leftElbow, KP.leftWrist],
      [KP.rightShoulder, KP.rightElbow],
      [KP.rightElbow, KP.rightWrist],
      [KP.leftShoulder, KP.leftHip],
      [KP.rightShoulder, KP.rightHip],
      [KP.leftHip, KP.rightHip],
    ]) {
      if (k[a].score < 0.3 || k[b].score < 0.3) continue;
      const pa = mapper.map(k[a]);
      const pb = mapper.map(k[b]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    if (k[KP.nose].score > 0.3) {
      const n = mapper.map(k[KP.nose]);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, mapper.len(p.shoulderWidth) * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // Brush tips: filled while painting, hollow while lifted.
    const pt = painter(`p${p.id}`, p.slot);
    const br = pt.brush;
    const tip = br.kind === 'color' ? br.color : br.kind === 'rainbow' ? `hsl(${pt.hue}, 90%, 55%)` : br.kind === 'sparkle' ? '#ffd60a' : '#999';
    for (const w of [KP.leftWrist, KP.rightWrist]) {
      if (k[w].score < 0.4) continue;
      const s = mapper.map(k[w]);
      const down = !!pt.last.get(w);
      const r = Math.max(10, mapper.len(p.shoulderWidth) * 0.13);
      ctx.save();
      ctx.lineWidth = 4;
      ctx.strokeStyle = p.color;
      ctx.fillStyle = tip;
      ctx.beginPath();
      ctx.arc(s.x, s.y, down ? r : r * 1.3, 0, Math.PI * 2);
      if (down) ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Toolbar
  ctx.fillStyle = 'rgba(255, 250, 240, 0.92)';
  ctx.fillRect(0, 0, W, H * TOOLBAR);
  ctx.fillStyle = 'rgba(120, 100, 60, 0.25)';
  ctx.fillRect(0, H * TOOLBAR - 3, W, 3);
  const selected = new Map<number, string[]>();
  for (const p of players) {
    const i = POTS.indexOf(painter(`p${p.id}`, p.slot).brush);
    selected.set(i, [...(selected.get(i) ?? []), p.color]);
  }
  drawPots(selected);
  menu.draw(ctx, W, H);

  // Idea banner
  const age = (now - idea.t) / 1000;
  if (idea.text && age < 6) {
    ctx.globalAlpha = Math.min(1, (6 - age) * 2);
    drawText(ctx, idea.text, W / 2, H * 0.24, Math.min(H / 11, W / (idea.text.length * 0.6)), '#ff70a6');
    ctx.globalAlpha = 1;
  }
  if (!players.length) {
    drawText(ctx, 'Step in front of the camera to paint', W / 2, H * 0.55, Math.min(H / 16, W / 26), '#7209b7');
  } else if (now % 20000 < 6000) {
    drawText(ctx, 'Raise a hand to paint · lower it to stop · touch a pot for a new colour', W / 2, H - 26, Math.min(H / 34, W / 60), '#7a6a4f', { stroke: false, weight: 700 });
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Read-only peek for automated tests.
(window as unknown as { paint: () => object }).paint = () => {
  // Fraction of the picture that has paint on it (sampled).
  const data = pctx.getImageData(0, 0, paper.width, paper.height).data;
  let painted = 0;
  let n = 0;
  for (let i = 3; i < data.length; i += 4 * 97) {
    n++;
    if (data[i] > 0) painted++;
  }
  return {
    players: game.frame.players.length,
    painted: +(painted / Math.max(1, n)).toFixed(4),
    brushes: [...painters.entries()].map(([k, p]) => [k, p.brush.kind === 'color' ? p.brush.color : p.brush.kind]),
  };
};
