/**
 * Sword Duel — two players (or one against the computer) face the camera, but
 * their knights face each other side-on in a castle courtyard. Whoever stands on
 * the left gets the left (Red) side.
 *
 *   Shield = your LEFT hand: up by your face blocks HIGH swings, down by your
 *            waist blocks LOW swings; either blocks a THRUST
 *   Duck   = squat down → a HIGH swing whooshes over your head
 *   Sword  = swing your RIGHT hand fast: high, low, or a thrust at the opponent.
 *            Every swing costs stamina, so pace yourself.
 *
 * 3 rounds of 40 s with a short break; a knock-out ends it early.
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
  prepareSpeech,
  say,
  theme,
  type Player,
} from '@trackergame/sdk';
import { BodyReader } from './body';
import { CpuBrain } from './cpu';
import { drawBars, drawCourtyard, drawKnight, drawSparks, drawTelegraph, type Spark } from './draw';
import { Fighter, REST_SHIELD, REST_SWORD, type Attack, type Outcome } from './fighter';

const ROUNDS = 3;
const ROUND_SECONDS = 40;
const BREAK_SECONDS = 8;
const RED = '#e63946';
const BLUE = '#3a86ff';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame({ people: false }); // players are avatars here, not camera cut-outs
const body = new BodyReader();
// A newcomer can take over a departed player's id: start their standing height afresh.
game.on('join', (e) => body.forget(e.playerId));
const bg = new Image();
bg.src = 'art/background.jpg';

type Stage = 'lobby' | 'intro' | 'countdown' | 'fight' | 'break' | 'ko' | 'result';
let stage: Stage = 'lobby';
let stageAt = performance.now();
let round = 1;
let roundElapsed = 0;
let red: Fighter | null = null;
let blue: Fighter | null = null;
let cpu: CpuBrain | null = null;
let winner: Fighter | null = null;
let shake = 0;
let lastCount = -1;
const pops: { x: number; y: number; text: string; color: string; at: number }[] = [];
const sparks: Spark[] = [];
/** Counts of what happened, for tests and the result screen. */
const stats = { swings: 0, hits: 0, blocks: 0, dodges: 0, parries: 0 };

const startMenu = new DwellMenu([{ id: 'start', label: 'En garde!', x: 0.5, y: 0.7, w: 0.28, h: 0.14, color: '#5a189a' }]);
const endMenu = new DwellMenu([
  { id: 'again', label: 'Rematch', x: 0.35, y: 0.82, w: 0.26, h: 0.13, color: '#5a189a' },
  { id: 'home', label: 'Home', x: 0.65, y: 0.82, w: 0.2, h: 0.13, color: '#3a2a80' },
]);

prepareSpeech([
  'Sword duel! Shield up, sword ready!',
  'Round one. En garde!',
  'Round two. En garde!',
  'Final round. En garde!',
  'Knocked out!',
  'Red wins!',
  'Blue wins!',
  'The computer wins!',
  "It's a draw!",
  'End of the round. Catch your breath!',
]);

game.on('handsUp', () => {
  if (stage === 'lobby') startBout();
  else if (stage === 'result' && since() > 3) startBout();
});

const since = () => (performance.now() - stageAt) / 1000;

function go(s: Stage) {
  stage = s;
  stageAt = performance.now();
  lastCount = -1;
}

/** Up to two people, ordered left → right by where they actually stand. */
function knightsInView(): Player[] {
  return [...game.frame.players].sort((a, b) => a.center.x - b.center.x).slice(0, 2);
}

function startBout() {
  const ps = knightsInView();
  if (!ps.length) return;
  if (ps.length === 2) {
    red = new Fighter('left', RED, 'Red', ps[0].id);
    blue = new Fighter('right', BLUE, 'Blue', ps[1].id);
    cpu = null;
  } else {
    // One player: they take the side of the room they stand on, the computer the other.
    const onLeft = ps[0].center.x < 0.5;
    red = new Fighter('left', RED, onLeft ? 'Red' : 'Computer', onLeft ? ps[0].id : null);
    blue = new Fighter('right', BLUE, onLeft ? 'Computer' : 'Blue', onLeft ? null : ps[0].id);
    cpu = new CpuBrain(0.45);
  }
  round = 1;
  winner = null;
  Object.assign(stats, { swings: 0, hits: 0, blocks: 0, dodges: 0, parries: 0 });
  say('Sword duel! Shield up, sword ready!', { interrupt: true });
  go('intro');
}

function roundCall(r: number) {
  return r === ROUNDS ? 'Final round. En garde!' : `Round ${r === 1 ? 'one' : 'two'}. En garde!`;
}

function control(f: Fighter, opp: Fighter, now: number) {
  const p = f.playerId !== null ? game.frame.players.find((q) => q.id === f.playerId) : undefined;
  if (p) {
    f.controls = body.read(p, now);
  } else if (f.playerId === null) {
    f.controls = (cpu ??= new CpuBrain(0.45)).think(f, opp, now);
  } else {
    // That player stepped out: stand still (auto-pause kicks in if nobody's left).
    f.controls = { duck: 0, shieldArm: { ...REST_SHIELD }, swordArm: { ...REST_SWORD }, shield: null };
  }
}

/** Screen layout: knights' feet x positions and size. */
function layout(w: number, h: number) {
  const size = Math.min(h * 0.56, w * 0.42);
  const gap = size * 0.82;
  return { size, lx: w / 2 - gap / 2, rx: w / 2 + gap / 2 };
}

function react(attacker: Fighter, defender: Fighter, kind: Attack, outcome: Outcome, w: number, h: number, floorY: number) {
  const L = layout(w, h);
  const dx = defender.side === 'left' ? L.lx : L.rx;
  const midX = (L.lx + L.rx) / 2 + (dx - (L.lx + L.rx) / 2) * 0.45;
  const y = floorY - L.size * (kind === 'high' ? 0.8 : kind === 'low' ? 0.3 : 0.58);
  // One callout per knight at a time, so they don't pile up.
  const px = dx + (defender.side === 'left' ? -1 : 1) * L.size * 0.25;
  for (let i = pops.length - 1; i >= 0; i--) if (pops[i].x === px) pops.splice(i, 1);
  const pop = (text: string, color: string) => pops.push({ x: px, y: floorY - L.size * 0.95, text, color, at: performance.now() });
  const burst = (n: number, color: string) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 250 + Math.random() * 450;
      sparks.push({ x: midX, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, at: performance.now(), color });
    }
  };
  if (outcome === 'hit') {
    stats.hits++;
    pop(['BONK!', 'BOINK!', 'THWACK!', 'BOP!'][Math.floor(Math.random() * 4)], attacker.color);
    burst(8, '#ffffff');
    shake = 0.25;
    noise(120, 0.3);
    blip(220, 160, 'square', 0.16, 90);
  } else if (outcome === 'blocked') {
    stats.blocks++;
    pop('CLANG!', '#8ecae6');
    burst(22, '#ffd166');
    clang();
  } else if (outcome === 'parried') {
    stats.parries++;
    pop('PARRY!', '#ffd166');
    burst(30, '#ffd166');
    clang();
    setTimeout(clang, 90);
  } else {
    stats.dodges++;
    pop('DUCKED!', '#ffbe0b');
    blip(900, 120, 'sine', 0.12, 1400);
  }
}

function clang() {
  blip(1250, 220, 'triangle', 0.16, 1180);
  blip(1870, 160, 'square', 0.05, 1800);
  noise(40, 0.15);
}

let last = performance.now();
const swingSeen = new Map<Fighter, number>();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { w, h } = fitCanvas(canvas, ctx);
  const floorY = h * 0.88;
  const t = since();
  const L = layout(w, h);

  ctx.save();
  if (shake > 0) {
    shake -= dt;
    ctx.translate((Math.random() - 0.5) * 24 * shake * 4, (Math.random() - 0.5) * 24 * shake * 4);
  }
  drawCourtyard(ctx, w, h, floorY, bg.complete && bg.naturalWidth ? bg : null);

  if (stage === 'lobby') {
    lobby(w, h, now, floorY);
  } else if (red && blue) {
    const fighting = stage === 'fight' && !game.paused;
    if (fighting) {
      roundElapsed += dt;
      control(red, blue, now);
      control(blue, red, now);
      const o1 = red.update(now, dt, blue);
      const o2 = blue.update(now, dt, red);
      if (o1) react(red, blue, red.swing?.kind ?? 'high', o1, w, h, floorY);
      if (o2) react(blue, red, blue.swing?.kind ?? 'high', o2, w, h, floorY);
      for (const f of [red, blue]) {
        if (f.swing && swingSeen.get(f) !== f.swing.t) {
          swingSeen.set(f, f.swing.t);
          stats.swings++;
          noise(90, 0.08); // whoosh
        }
        if (now - f.tiredAt < 30) {
          const x = f.side === 'left' ? L.lx - L.size * 0.25 : L.rx + L.size * 0.25;
          if (!pops.some((p) => p.x === x && now - p.at < 600)) pops.push({ x, y: floorY - L.size * 0.95, text: 'Tired!', color: '#ff9f1c', at: now });
        }
      }
      if (red.ko || blue.ko) {
        winner = red.ko ? blue : red;
        say('Knocked out!', { interrupt: true });
        go('ko');
      } else if (roundElapsed >= ROUND_SECONDS) {
        if (round < ROUNDS) {
          say('End of the round. Catch your breath!', { interrupt: true });
          go('break');
        } else finish();
      }
    } else if (stage !== 'ko' && stage !== 'result') {
      // Keep knights' poses live between rounds so players can see themselves move.
      control(red, blue, now);
      control(blue, red, now);
      red.controls.attack = blue.controls.attack = undefined;
      red.windup = blue.windup = 0;
      red.update(now, dt, blue);
      blue.update(now, dt, red);
    }

    drawKnight(ctx, red, L.lx, floorY, L.size, now);
    drawKnight(ctx, blue, L.rx, floorY, L.size, now);
    drawSparks(ctx, sparks, now, dt);
    drawTelegraph(ctx, red, L.lx, floorY - L.size * 1.2, L.size, now);
    drawTelegraph(ctx, blue, L.rx, floorY - L.size * 1.2, L.size, now);
    drawBars(ctx, w, red, red.name);
    drawBars(ctx, w, blue, blue.name);
    drawPops(h, now);
    hud(w, h, t, now);
  }
  ctx.restore();
  requestAnimationFrame(loop);
}

function lobby(w: number, h: number, now: number, floorY: number) {
  const ps = knightsInView();
  const L = layout(w, h);
  // Preview who'd be on which side, posed from their arms.
  const preview = (p: Player | undefined, side: 'left' | 'right', name: string) => {
    const f = new Fighter(side, side === 'left' ? RED : BLUE, name, p?.id ?? null);
    if (p) {
      const r = body.read(p, now);
      f.shieldArm = r.shieldArm;
      f.swordArm = r.swordArm;
      f.shield = r.shield;
      f.duck = r.duck;
    }
    const x = side === 'left' ? w * 0.13 : w * 0.87;
    drawKnight(ctx, f, x, floorY, L.size * 0.75, now);
    drawText(ctx, name, x, floorY + h * 0.05, h / 22, side === 'left' ? RED : BLUE);
    const hint = p && standHint(p);
    if (hint) drawText(ctx, hint, x, floorY - L.size * 0.85, h / 30, theme.accent);
  };
  if (ps.length === 2) {
    preview(ps[0], 'left', 'Red');
    preview(ps[1], 'right', 'Blue');
  } else if (ps.length === 1) {
    const onLeft = ps[0].center.x < 0.5;
    preview(onLeft ? ps[0] : undefined, 'left', onLeft ? 'Red (you)' : 'Computer');
    preview(onLeft ? undefined : ps[0], 'right', onLeft ? 'Computer' : 'Blue (you)');
  }
  drawTitle(ctx, w, h, 'Sword Duel', ps.length ? 'Raise both hands to start!' : 'Step in to duel! (1 or 2 players)');
  drawText(ctx, 'Left hand = shield  ·  Right hand = sword', w / 2, h * 0.5, h / 24);
  drawText(ctx, 'Shield up for HIGH · down for LOW · duck under HIGH swings', w / 2, h * 0.56, h / 30);
  if (game.frame.players.length > 2) drawText(ctx, 'Two knights at a time — the two on the outside play', w / 2, h * 0.62, h / 30, theme.accent);
  if (ps.length) {
    if (startMenu.update(game.frame.players, now) === 'start') startBout();
    startMenu.draw(ctx, w, h);
  }
}

/** A nudge when the camera can't read this knight well (from the tracker's facing/distance), or null. */
function standHint(p: Player): string | null {
  if (p.distance === 'close') return 'Step back a little';
  if (p.distance === 'far') return 'Step closer';
  if (p.facing && p.facing !== 'front') return 'Face the camera';
  return null;
}

function hud(w: number, h: number, t: number, now: number) {
  if (stage === 'fight' || stage === 'break' || stage === 'countdown') {
    const left = stage === 'fight' ? Math.max(0, ROUND_SECONDS - roundElapsed) : ROUND_SECONDS;
    drawText(ctx, `Round ${round}`, w / 2, 34, 26, theme.accent);
    drawText(ctx, String(Math.ceil(left)), w / 2, 76, 40, left < 10 ? '#ff4d6d' : '#fff');
  }
  switch (stage) {
    case 'intro':
      drawText(ctx, `${red!.name}  vs  ${blue!.name}`, w / 2, h * 0.2, h / 10, '#fff');
      drawText(ctx, 'Left hand = shield · right hand = sword', w / 2, h * 0.3, h / 26);
      if (t > 3) {
        say(roundCall(round), { interrupt: true });
        go('countdown');
      }
      break;
    case 'countdown': {
      const n = Math.ceil(3 - t);
      if (n !== lastCount && n > 0) {
        lastCount = n;
        blip(440, 120, 'square', 0.12);
      }
      drawCountdown(ctx, w, h, 3 - t);
      if (t >= 3) {
        clang();
        roundElapsed = 0;
        cpu?.reset();
        go('fight');
      }
      break;
    }
    case 'fight':
      if (game.paused) drawPaused(ctx, w, h);
      else if (roundElapsed < 1.2) drawText(ctx, 'EN GARDE!', w / 2, h * 0.3, h / 7, theme.accent);
      break;
    case 'break': {
      ctx.fillStyle = 'rgba(10,6,30,0.55)';
      ctx.fillRect(0, 0, w, h);
      drawText(ctx, `End of round ${round}`, w / 2, h * 0.3, h / 10, theme.accent);
      drawText(ctx, `Round ${round + 1} in ${Math.ceil(BREAK_SECONDS - t)}…`, w / 2, h * 0.45, h / 16);
      if (t >= BREAK_SECONDS) {
        round++;
        if (cpu) cpu.skill = Math.min(0.8, cpu.skill + 0.15); // sharper each round
        red!.stamina = blue!.stamina = 100;
        say(roundCall(round), { interrupt: true });
        go('countdown');
      }
      break;
    }
    case 'ko':
      drawText(ctx, 'KNOCKED OUT!', w / 2, h * 0.3, (h / 7) * (1 + Math.max(0, 0.3 - t)), '#ff4d6d');
      if (t > 2.5) finish();
      break;
    case 'result': {
      ctx.fillStyle = 'rgba(10,6,30,0.5)';
      ctx.fillRect(0, 0, w, h);
      const title = winner ? `${winner.name} wins!` : "It's a draw!";
      drawText(ctx, title, w / 2, h * 0.25, h / 8, winner?.color ?? theme.accent);
      drawText(ctx, `${Math.ceil(red!.health)}  –  ${Math.ceil(blue!.health)}`, w / 2, h * 0.4, h / 14);
      drawText(ctx, `${stats.blocks} blocks · ${stats.parries} parries · ${stats.dodges} ducks`, w / 2, h * 0.5, h / 28);
      if (t > 3) {
        const pick = endMenu.update(game.frame.players, now);
        if (pick === 'again') startBout();
        if (pick === 'home') game.exit();
        endMenu.draw(ctx, w, h);
      }
      break;
    }
  }
}

function finish() {
  if (!red || !blue) return;
  if (!winner && Math.abs(red.health - blue.health) >= 1) winner = red.health > blue.health ? red : blue;
  say(
    winner ? (winner.playerId === null ? 'The computer wins!' : `${winner.color === RED ? 'Red' : 'Blue'} wins!`) : "It's a draw!",
  );
  const scores: Record<number, number> = {};
  for (const f of [red, blue]) {
    const p = game.frame.players.find((q) => q.id === f.playerId);
    if (p) scores[p.slot] = Math.ceil(f.health);
  }
  game.reportScores(scores);
  go('result');
}

function drawPops(h: number, now: number) {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    const age = (now - p.at) / 900;
    if (age > 1) {
      pops.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = 1 - age;
    drawText(ctx, p.text, p.x, p.y - age * 60, (h / 11) * (1 + (1 - age) * 0.2), p.color);
    ctx.globalAlpha = 1;
  }
}

// Read-only peek for automated tests and debugging.
const peekFighter = (f: Fighter | null) =>
  f && {
    name: f.name,
    health: f.health,
    stamina: Math.round(f.stamina),
    duck: +f.duck.toFixed(2),
    shield: f.shield,
    shieldArm: { fwd: +f.shieldArm.fwd.toFixed(2), down: +f.shieldArm.down.toFixed(2) },
    swordArm: { fwd: +f.swordArm.fwd.toFixed(2), down: +f.swordArm.down.toFixed(2) },
    swing: f.swing?.kind ?? null,
    windup: f.windup ? f.windupKind : null,
    lastOutcome: f.lastOutcome,
    cpu: f.playerId === null,
  };
(window as unknown as { duel: () => object }).duel = () => ({
  stage,
  round,
  roundElapsed,
  red: peekFighter(red),
  blue: peekFighter(blue),
  stats: { ...stats },
  winner: winner?.name ?? null,
});

requestAnimationFrame(loop);
