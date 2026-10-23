/**
 * Jousting — two knights charge at each other from either side of the lists.
 * Run on the spot to gallop: the faster your legs, the faster your horse. When the
 * lances meet, the faster knight unseats the other (close speeds: both lances
 * shatter, nobody scores). First to 3 points wins.
 *
 * Whoever stands on the left charges from the left. On your own, you joust the
 * Black Knight (the computer), who rides a little harder each time you win a pass.
 */
import {
  DwellMenu,
  blip,
  createGame,
  drawCountdown,
  drawPaused,
  drawText,
  drawTitle,
  fitCanvas,
  noise,
  playerColor,
  playerName,
  prepareSpeech,
  say,
  theme,
  type Player,
} from '@trackergame/sdk';
import { art } from './art';
import { SEAT, bob, drawBarrier, drawHorse, drawKnight, drawLists } from './draw';

/** Metres between the two starting ends. */
const TRACK = 50;
const TOP_SPEED = 10; // m/s
/** Speeds closer than this at the clash are a draw: both lances shatter. */
const TIE_MARGIN = 0.8;
const WIN_POINTS = 3;
const IMPACT_SECONDS = 3.2;
const CPU_COLOR = '#3d405b';
const CPU_NAME = 'The Black Knight';

type Stage = 'lobby' | 'intro' | 'ready' | 'charge' | 'impact' | 'result';
type Side = 'left' | 'right';

interface Knight {
  side: Side;
  dir: 1 | -1;
  /** null = the computer. */
  playerId: number | null;
  slot: number | null;
  name: string;
  color: string;
  score: number;
  /** Metres from this knight's own end. */
  pos: number;
  speed: number;
  phase: number;
  /** Set when unseated: where (metres) and when. */
  fellAt: { pos: number; t: number } | null;
  broken: boolean;
}

interface Splinter {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  color: string;
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame({ people: false }); // players are avatars here, not camera cut-outs

let stage: Stage = 'lobby';
let stageAt = performance.now();
let left: Knight | null = null;
let right: Knight | null = null;
let passes = 0;
/** Black Knight's pace for this pass (m/s). */
let cpuPace = 6;
let lastCount = -1;
let message = '';
let shake = 0;
let splinters: Splinter[] = [];

const startMenu = new DwellMenu([{ id: 'start', label: 'Joust!', x: 0.5, y: 0.64, w: 0.24, h: 0.13, color: '#6a4c93' }]);
const endMenu = new DwellMenu([
  { id: 'again', label: 'Rematch', x: 0.35, y: 0.5, w: 0.26, h: 0.13, color: '#6a4c93' },
  { id: 'home', label: 'Home', x: 0.65, y: 0.5, w: 0.2, h: 0.13, color: '#3a2a80' },
]);

const NAMES = ['Red', 'Blue', 'Yellow', 'Green', CPU_NAME];
prepareSpeech([
  'Jousting! Run on the spot to gallop. The fastest knight wins!',
  'Charge!',
  'Lances shattered! Go again!',
  ...NAMES.map((n) => `${n} wins the pass!`),
  ...NAMES.map((n) => `${n} wins the tournament!`),
]);

const since = () => (performance.now() - stageAt) / 1000;

function go(s: Stage) {
  stage = s;
  stageAt = performance.now();
  lastCount = -1;
}

/** The two outermost people, left → right by where they stand. */
function joustersInView(): Player[] {
  const ps = [...game.frame.players].sort((a, b) => a.center.x - b.center.x);
  return ps.length > 2 ? [ps[0], ps[ps.length - 1]] : ps;
}

function knight(side: Side, p: Player | undefined): Knight {
  return {
    side,
    dir: side === 'left' ? 1 : -1,
    playerId: p?.id ?? null,
    slot: p?.slot ?? null,
    name: p ? playerName(p.slot) : CPU_NAME,
    color: p ? playerColor(p.slot) : CPU_COLOR,
    score: 0,
    pos: 0,
    speed: 0,
    phase: 0,
    fellAt: null,
    broken: false,
  };
}

function startTournament() {
  const ps = joustersInView();
  if (!ps.length) return;
  if (ps.length === 2) {
    left = knight('left', ps[0]);
    right = knight('right', ps[1]);
  } else {
    // On your own: you ride from your side of the room, the Black Knight from the other.
    const onLeft = ps[0].center.x < 0.5;
    left = knight('left', onLeft ? ps[0] : undefined);
    right = knight('right', onLeft ? undefined : ps[0]);
  }
  passes = 0;
  say('Jousting! Run on the spot to gallop. The fastest knight wins!', { interrupt: true });
  go('intro');
}

function newPass() {
  for (const k of [left!, right!]) {
    k.pos = 0;
    k.speed = 0;
    k.fellAt = null;
    k.broken = false;
  }
  passes++;
  splinters = [];
  // The Black Knight gets keener as the human scores.
  const human = left!.playerId !== null ? left! : right!;
  cpuPace = 5 + Math.random() * 2.5 + human.score * 0.9;
  message = '';
  go('ready');
}

const playerOf = (k: Knight) => (k.playerId !== null ? game.frame.players.find((p) => p.id === k.playerId) : undefined);

/** How fast this knight wants to go right now (m/s), from running on the spot. */
function targetSpeed(k: Knight): number {
  if (k.playerId === null) return since() < 0.4 ? 0 : cpuPace; // a beat to react to "Charge!"
  const p = playerOf(k);
  const effort = p ? p.pose.run : 0;
  return effort < 0.6 ? 0 : Math.min(TOP_SPEED, effort * 2.4);
}

/** Moves the horses; returns true at the moment the lances meet. */
function ride(dt: number): boolean {
  for (const k of [left!, right!]) {
    k.speed += (targetSpeed(k) - k.speed) * Math.min(1, dt * 2.5);
    k.pos += k.speed * dt;
    k.phase += k.speed * dt * 1.4;
  }
  return left!.pos + right!.pos >= TRACK;
}

function clash() {
  const l = left!;
  const r = right!;
  const now = performance.now();
  shake = 0.35;
  noise(350, 0.4);
  blip(120, 200, 'square', 0.2, 50);
  if (Math.abs(l.speed - r.speed) < TIE_MARGIN) {
    l.broken = r.broken = true;
    message = 'Lances shattered!';
    say('Lances shattered! Go again!', { interrupt: true });
  } else {
    const [win, lose] = l.speed > r.speed ? [l, r] : [r, l];
    win.broken = true;
    win.score++;
    lose.fellAt = { pos: lose.pos, t: now };
    message = `${win.name} unseats ${lose.name}!`;
    if (win.score < WIN_POINTS) say(`${win.name} wins the pass!`, { interrupt: true });
    setTimeout(() => {
      blip(523, 140, 'triangle', 0.15);
      setTimeout(() => blip(659, 140, 'triangle', 0.15), 150);
      setTimeout(() => blip(784, 260, 'triangle', 0.15), 300);
    }, 500);
  }
  go('impact');
}

function burst(x: number, y: number, colors: string[]) {
  for (let i = 0; i < 28; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 150 + Math.random() * 450;
    splinters.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 200,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 20,
      color: colors[i % colors.length],
    });
  }
}

function finish() {
  const win = left!.score >= WIN_POINTS ? left! : right!;
  say(`${win.name} wins the tournament!`, { interrupt: true });
  const scores: Record<number, number> = {};
  for (const k of [left!, right!]) if (k.slot !== null) scores[k.slot] = k.score;
  game.reportScores(scores);
  go('result');
}

// ---------- frame ----------

let last = performance.now();
function loop(now: number) {
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { w, h } = fitCanvas(canvas, ctx);
  const t = since();
  const horizon = h * 0.5;
  const backLane = h * 0.7;
  const frontLane = h * 0.93;
  const s = h * 0.32;
  const sBack = s * 0.85;
  const lance = 1.0;
  // Screen x for a knight: lances (length `lance`·s) just reach the other shield when pos sum = TRACK.
  const xL = w * 0.1;
  const xR = w * 0.9;
  const scale = (xR - xL - s * (lance + 0.1)) / TRACK;
  const screenX = (k: Knight, pos = k.pos) => (k.side === 'left' ? xL + pos * scale : xR - pos * scale);

  // Slow motion right at the clash.
  if (stage === 'impact' && t < 0.6) dt *= 0.25;

  ctx.save();
  if (shake > 0) {
    shake -= dt;
    ctx.translate((Math.random() - 0.5) * 60 * shake, (Math.random() - 0.5) * 60 * shake);
  }
  drawLists(ctx, w, h, horizon);

  if (stage === 'lobby') {
    lobby(w, h, now, backLane, frontLane, s, sBack, xL, xR);
  } else if (left && right) {
    if (stage === 'charge' && !game.paused) {
      if (ride(dt)) {
        clash();
        burst(screenX(left) + s * 0.55, (backLane + frontLane) / 2 - s * 1.0, ['#e9c46a', '#f8f9fa', left.color, right.color]);
      }
    } else if (stage === 'impact') {
      // Horses run on past each other and slow down; unseated knights lie where they fell.
      for (const k of [left, right]) {
        k.speed *= Math.pow(0.4, dt);
        k.pos += k.speed * dt;
        k.phase += k.speed * dt * 1.4;
      }
    }

    // Left knight rides the far lane, right knight the near one, either side of the barrier.
    drawRider(left, screenX(left), backLane, sBack, lance);
    drawBarrier(ctx, w, h * 0.8, h * 0.08);
    drawRider(right, screenX(right), frontLane, s, lance);
    if (left.fellAt) drawFallen(left, screenX(left, left.fellAt.pos), backLane, sBack, lance, now);
    if (right.fellAt) drawFallen(right, screenX(right, right.fellAt.pos), frontLane, s, lance, now);
    drawSplinters(dt, h);
    hud(w, h, t, now);
  }
  ctx.restore();
  requestAnimationFrame(loop);
}

function drawRider(k: Knight, x: number, ground: number, size: number, lance: number) {
  const gait = { phase: k.phase, stride: Math.min(1, k.speed / 6) };
  drawHorse(ctx, x, ground, size, k.dir, k.color, gait);
  if (k.fellAt) return;
  const cheer = (stage === 'impact' && since() > 1 && k.broken && !otherOf(k).broken) || (stage === 'result' && k.score >= WIN_POINTS);
  drawKnight(ctx, x, ground, size, k.dir, k.color, lance, { broken: k.broken, cheer }, bob(gait));
}

function drawFallen(k: Knight, x: number, ground: number, size: number, lance: number, now: number) {
  const fall = Math.min(1, (now - k.fellAt!.t) / 700);
  drawKnight(ctx, x, ground, size, k.dir, k.color, lance, { fall });
}

const otherOf = (k: Knight) => (k === left ? right! : left!);

function drawSplinters(dt: number, h: number) {
  for (const p of splinters) {
    p.vy += 900 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-10, -2.5, 20, 5);
    ctx.restore();
  }
  splinters = splinters.filter((p) => p.y < h + 40);
}

function lobby(w: number, h: number, now: number, backLane: number, frontLane: number, s: number, sBack: number, xL: number, xR: number) {
  const ps = joustersInView();
  const preview = (p: Player | undefined, side: Side) => {
    const k = knight(side, p);
    const [x, ground, size] = side === 'left' ? [xL, backLane, sBack] : [xR, frontLane, s];
    // Horses prance a little when their rider runs on the spot.
    const run = p ? Math.min(1, p.pose.run / 4) : 0;
    const gait = { phase: now / 120, stride: run };
    drawHorse(ctx, x, ground, size, k.dir, k.color, gait);
    drawKnight(ctx, x, ground, size, k.dir, k.color, 1.0, {}, bob(gait));
    drawText(ctx, p ? k.name : ps.length ? CPU_NAME : '?', x, ground - size * (SEAT + 0.75), h / 24, k.color === CPU_COLOR ? '#fff' : k.color);
    const hint = p && standHint(p);
    if (hint) drawText(ctx, hint, x, ground - size * (SEAT + 0.6), h / 32, theme.accent);
  };
  if (ps.length === 2) {
    preview(ps[0], 'left');
    preview(ps[1], 'right');
  } else if (ps.length === 1) {
    const onLeft = ps[0].center.x < 0.5;
    preview(onLeft ? ps[0] : undefined, 'left');
    preview(onLeft ? undefined : ps[0], 'right');
  }
  drawBarrier(ctx, w, h * 0.8, h * 0.08);
  drawTitle(ctx, w, h, 'Jousting', ps.length ? 'Hold a hand on Joust! to begin' : 'Step in to joust! (1 or 2 knights)');
  drawText(ctx, 'Run on the spot to gallop · fastest knight unseats the other · first to 3', w / 2, h * 0.53, h / 28);
  if (game.frame.players.length > 2) drawText(ctx, 'Two knights at a time — the two on the outside ride', w / 2, h * 0.58, h / 30, theme.accent);
  if (ps.length) {
    if (startMenu.update(game.frame.players, now) === 'start') startTournament();
    startMenu.draw(ctx, w, h);
  }
}

function hud(w: number, h: number, t: number, now: number) {
  const l = left!;
  const r = right!;
  // Names, points (shields) and speed bars in the top corners.
  for (const k of [l, r]) {
    const isLeft = k.side === 'left';
    const x = isLeft ? w * 0.03 : w * 0.97;
    const align = isLeft ? 'left' : 'right';
    drawText(ctx, k.name, x, h * 0.06, h / 20, k.color === CPU_COLOR ? '#fff' : k.color, { align });
    for (let i = 0; i < WIN_POINTS; i++) {
      const cx = isLeft ? x + h * 0.03 + i * h * 0.065 : x - h * 0.03 - i * h * 0.065;
      shield(cx, h * 0.135, h * 0.025, i < k.score ? k.color : null);
    }
    if (stage === 'ready' || stage === 'charge') {
      const p = playerOf(k);
      const v = stage === 'ready' ? (k.playerId === null ? 0 : Math.min(TOP_SPEED, (p?.pose.run ?? 0) * 2.4)) : k.speed;
      const bw = w * 0.22;
      const bx = isLeft ? x : x - bw;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.roundRect(bx, h * 0.19, bw, h * 0.03, h * 0.015);
      ctx.fill();
      ctx.fillStyle = k.color === CPU_COLOR ? '#adb5bd' : k.color;
      const fw = (bw * Math.min(v, TOP_SPEED)) / TOP_SPEED;
      ctx.beginPath();
      ctx.roundRect(isLeft ? bx : bx + bw - fw, h * 0.19, Math.max(fw, h * 0.03), h * 0.03, h * 0.015);
      ctx.fill();
      const hint = p && standHint(p);
      if (hint) drawText(ctx, hint, x, h * 0.26, h / 32, theme.accent, { align });
    }
  }
  drawText(ctx, `Pass ${passes}`, w / 2, h * 0.06, h / 26, theme.accent);

  switch (stage) {
    case 'intro':
      drawText(ctx, `${l.name}  vs  ${r.name}`, w / 2, h * 0.3, h / 12);
      drawText(ctx, 'Run on the spot to gallop!', w / 2, h * 0.4, h / 22);
      if (t > 3.5) newPass();
      break;
    case 'ready': {
      const n = Math.ceil(3 - t);
      if (n !== lastCount && n > 0) {
        lastCount = n;
        blip(440, 120, 'square', 0.12);
      }
      drawCountdown(ctx, w, h, 3 - t);
      drawText(ctx, 'Start running!', w / 2, h * 0.42, h / 20, theme.accent);
      if (t >= 3) {
        say('Charge!', { interrupt: true });
        blip(660, 160, 'sawtooth', 0.12);
        setTimeout(() => blip(880, 320, 'sawtooth', 0.12), 170);
        go('charge');
      }
      break;
    }
    case 'charge':
      if (game.paused) drawPaused(ctx, w, h);
      else {
        const pulse = 1 + Math.sin(now / 90) * 0.05;
        drawText(ctx, t < 1 ? 'CHARGE!' : 'RUN ON THE SPOT!', w / 2, h * 0.3, (h / 11) * pulse, theme.accent);
      }
      break;
    case 'impact':
      if (t > 0.3) drawText(ctx, message, w / 2, h * 0.3, h / 14, '#fff');
      if (t > IMPACT_SECONDS) {
        if (l.score >= WIN_POINTS || r.score >= WIN_POINTS) finish();
        else newPass();
      }
      break;
    case 'result': {
      ctx.fillStyle = 'rgba(10,6,30,0.45)';
      ctx.fillRect(0, 0, w, h);
      const win = l.score >= WIN_POINTS ? l : r;
      drawText(ctx, `${win.name} wins!`, w / 2, h * 0.24, h / 9, win.color === CPU_COLOR ? '#fff' : win.color);
      drawText(ctx, `${l.score}  –  ${r.score}`, w / 2, h * 0.35, h / 14);
      if (t > 2.5) {
        const pick = endMenu.update(game.frame.players, now);
        if (pick === 'again') startTournament();
        if (pick === 'home') game.exit();
        endMenu.draw(ctx, w, h);
      }
      break;
    }
  }
}

/** Running is read from the knees: a nudge when the camera can't see them well, or null. */
function standHint(p: Player): string | null {
  if (p.distance === 'close') return 'Step back a little';
  if (p.distance === 'far') return 'Step closer';
  return null;
}

/** A little heater shield: filled with `color` for a point won, empty outline otherwise. */
function shield(x: number, y: number, r: number, color: string | null) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y - r);
  ctx.lineTo(x + r, y + r * 0.2);
  ctx.quadraticCurveTo(x + r * 0.9, y + r * 1.1, x, y + r * 1.5);
  ctx.quadraticCurveTo(x - r * 0.9, y + r * 1.1, x - r, y + r * 0.2);
  ctx.closePath();
  ctx.fillStyle = color ?? 'rgba(0,0,0,0.3)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color ? '#ffd166' : 'rgba(255,255,255,0.6)';
  ctx.stroke();
  if (color) ctx.drawImage(art.crest, x - r * 0.8, y - r * 0.75, r * 1.6, r * 1.6);
  ctx.restore();
}

// Read-only peek for automated tests and debugging.
(window as unknown as { joust: () => object }).joust = () => ({
  stage,
  passes,
  left: left && { name: left.name, score: left.score, pos: left.pos, speed: left.speed, cpu: left.playerId === null },
  right: right && { name: right.name, score: right.score, pos: right.pos, speed: right.speed, cpu: right.playerId === null },
});

requestAnimationFrame(loop);
