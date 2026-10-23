/**
 * Boxing — two players (or one against the computer) face the camera, but
 * their boxers face each other in the ring. Whoever stands on the left gets the
 * left (Red) corner.
 *
 *   Bob    = duck down          → dodges a punch
 *   Weave  = lean your head to the side → dodges a punch
 *   Guard  = gloves up by your face     → blocks most of the damage
 *   Punch  = jab, cross or hook          → costs stamina, so pace yourself
 *
 * 3 rounds of 40 s with a short break; knock-out ends it early.
 *
 * Artwork: art/generate.py (Gemini) -> public/art.
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
  loadAssets,
  noise,
  prepareSpeech,
  say,
  theme,
  type Player,
  type Side,
} from '@trackergame/sdk';
import { BodyReader } from './body';
import { CpuBrain } from './cpu';
import { drawArena, drawBars, drawBelt, drawBoxer, drawBurst, useArt, type Art } from './draw';
import { Fighter, type Outcome } from './fighter';

const ROUNDS = 3;
const ROUND_SECONDS = 40;
const BREAK_SECONDS = 8;
const RED = '#e63946';
const BLUE = '#3a86ff';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame({ people: false }); // players are avatars here, not camera cut-outs
const assets = await loadAssets({
  images: Object.fromEntries(
    ['glove_red', 'glove_blue', 'head_red', 'head_blue', 'pow', 'star', 'belt'].map((k) => [k, `art/${k}.png`]).concat([['background', 'art/background.jpg']]),
  ),
});
useArt(assets.images as Art);
const body = new BodyReader();
// A newcomer can take over a departed player's id: start their standing height afresh.
game.on('join', (e) => body.forget(e.playerId));

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
/** Punch events from the SDK this frame, by player id (with the wrist speed, when the tracker measured it). */
const punches = new Map<number, { hand: Side; speed?: number }>();
const pops: { x: number; y: number; text: string; color: string; at: number; burst: boolean; spin: number }[] = [];

const startMenu = new DwellMenu([{ id: 'start', label: 'Fight!', x: 0.5, y: 0.7, w: 0.26, h: 0.14, color: '#9d0208' }]);
const endMenu = new DwellMenu([
  { id: 'again', label: 'Rematch', x: 0.35, y: 0.82, w: 0.26, h: 0.13, color: '#9d0208' },
  { id: 'home', label: 'Home', x: 0.65, y: 0.82, w: 0.2, h: 0.13, color: '#3a2a80' },
]);

prepareSpeech([
  'Boxing! Duck, weave, and throw those punches!',
  'Round one. Fight!',
  'Round two. Fight!',
  'Final round. Fight!',
  'Knock out!',
  'Red wins!',
  'Blue wins!',
  'The computer wins!',
  "It's a draw!",
  'End of the round. Catch your breath!',
]);

game.on('punch', (e) => punches.set(e.playerId, { hand: e.hand, speed: e.speed }));
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
function boxersInView(): Player[] {
  return [...game.frame.players].sort((a, b) => a.center.x - b.center.x).slice(0, 2);
}

function startBout() {
  const ps = boxersInView();
  if (!ps.length) return;
  if (ps.length === 2) {
    red = new Fighter('left', RED, 'Red', ps[0].id);
    blue = new Fighter('right', BLUE, 'Blue', ps[1].id);
    cpu = null;
  } else {
    // One player: they take the corner on their side of the room, the computer the other.
    const onLeft = ps[0].center.x < 0.5;
    red = new Fighter('left', RED, onLeft ? 'Red' : 'Computer', onLeft ? ps[0].id : null);
    blue = new Fighter('right', BLUE, onLeft ? 'Computer' : 'Blue', onLeft ? null : ps[0].id);
    cpu = new CpuBrain(0.45);
  }
  round = 1;
  winner = null;
  say('Boxing! Duck, weave, and throw those punches!', { interrupt: true });
  go('intro');
}

function roundCall(r: number) {
  return r === ROUNDS ? 'Final round. Fight!' : `Round ${r === 1 ? 'one' : 'two'}. Fight!`;
}

function control(f: Fighter, opp: Fighter, now: number) {
  const p = f.playerId !== null ? game.frame.players.find((q) => q.id === f.playerId) : undefined;
  if (p) {
    f.controls = body.read(p, f.facing, now, punches.get(p.id) ?? null);
  } else if (f.playerId === null) {
    f.controls = (cpu ??= new CpuBrain(0.45)).think(f, opp, now);
  } else {
    // That player stepped out: stand still (auto-pause kicks in if nobody's left).
    f.controls = { duck: 0, weave: 0, guard: false };
  }
}

function react(attacker: Fighter, defender: Fighter, outcome: Outcome, w: number, h: number) {
  const x = defender.side === 'left' ? w * 0.36 : w * 0.64;
  const y = h * 0.42;
  // One callout per boxer at a time, so they don't pile up.
  for (let i = pops.length - 1; i >= 0; i--) if (pops[i].x === x) pops.splice(i, 1);
  if (outcome === 'hit') {
    pops.push({ x, y, text: ['POW!', 'BAM!', 'WHAM!', 'BOOF!'][Math.floor(Math.random() * 4)], color: attacker.color, at: performance.now(), burst: true, spin: Math.random() - 0.5 });
    shake = 0.25 * (attacker.punch?.power ?? 1); // harder punches shake the ring more
    noise(160, 0.35);
    blip(140, 140, 'square', 0.18, 70);
  } else if (outcome === 'blocked') {
    pops.push({ x, y, text: 'BLOCKED', color: '#8ecae6', at: performance.now(), burst: false, spin: 0 });
    blip(300, 80, 'triangle', 0.15, 250);
  } else {
    pops.push({ x, y, text: 'DODGED!', color: '#ffbe0b', at: performance.now(), burst: false, spin: 0 });
    blip(900, 120, 'sine', 0.12, 1400);
  }
}

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { w, h } = fitCanvas(canvas, ctx);
  const floorY = h * 0.86;
  const t = since();

  ctx.save();
  if (shake > 0) {
    shake -= dt;
    ctx.translate((Math.random() - 0.5) * 24 * shake * 4, (Math.random() - 0.5) * 24 * shake * 4);
  }
  drawArena(ctx, w, h, now, floorY);

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
      if (o1) react(red, blue, o1, w, h);
      if (o2) react(blue, red, o2, w, h);
      if (red.ko || blue.ko) {
        winner = red.ko ? blue : red;
        say('Knock out!', { interrupt: true });
        go('ko');
      } else if (roundElapsed >= ROUND_SECONDS) {
        if (round < ROUNDS) {
          say('End of the round. Catch your breath!', { interrupt: true });
          go('break');
        } else finish();
      }
    } else if (stage !== 'ko' && stage !== 'result') {
      // Keep boxers' poses live between rounds so players can see themselves move.
      control(red, blue, now);
      control(blue, red, now);
      red.controls.punch = blue.controls.punch = undefined;
      red.update(now, dt, blue);
      blue.update(now, dt, red);
    }
    punches.clear();

    const size = h * 0.62;
    drawBoxer(ctx, red, w * 0.38, floorY, size, now);
    drawBoxer(ctx, blue, w * 0.62, floorY, size, now);
    drawBars(ctx, w, red, red.name);
    drawBars(ctx, w, blue, blue.name);
    drawPops(h, now);
    hud(w, h, t, now);
  }
  ctx.restore();
  requestAnimationFrame(loop);
}

function lobby(w: number, h: number, now: number, floorY: number) {
  const ps = boxersInView();
  // A soft dark panel behind the title and instructions, so they read over the crowd.
  const scrim = ctx.createLinearGradient(0, h * 0.06, 0, h * 0.6);
  scrim.addColorStop(0, 'rgba(15, 8, 35, 0)');
  scrim.addColorStop(0.2, 'rgba(15, 8, 35, 0.45)');
  scrim.addColorStop(0.8, 'rgba(15, 8, 35, 0.45)');
  scrim.addColorStop(1, 'rgba(15, 8, 35, 0)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, h * 0.06, w, h * 0.54);
  // Preview who'd be in which corner, posed live from the player (duck, weave, guard).
  const preview = (p: Player | undefined, side: 'left' | 'right', name: string) => {
    const f = new Fighter(side, side === 'left' ? RED : BLUE, name, p?.id ?? null);
    const x = side === 'left' ? w * 0.3 : w * 0.7;
    if (p) {
      const c = body.read(p, f.facing, now, null);
      f.duck = c.duck;
      f.weave = c.weave;
      f.guard = !p.pose.handsUp && c.guard;
    }
    drawBoxer(ctx, f, x, floorY, h * 0.5, now);
    drawText(ctx, name, x, h * 0.88, h / 22, side === 'left' ? RED : BLUE);
    const hint = p && standHint(p);
    if (hint) drawText(ctx, hint, x, h * 0.81, h / 26, theme.accent);
  };
  if (ps.length === 2) {
    preview(ps[0], 'left', 'Red');
    preview(ps[1], 'right', 'Blue');
  } else if (ps.length === 1) {
    const onLeft = ps[0].center.x < 0.5;
    preview(onLeft ? ps[0] : undefined, 'left', onLeft ? 'Red (you)' : 'Computer');
    preview(onLeft ? undefined : ps[0], 'right', onLeft ? 'Computer' : 'Blue (you)');
  }
  drawTitle(ctx, w, h, 'Boxing', ps.length ? 'Raise both hands to start!' : 'Step in to box! (1 or 2 players)');
  drawText(ctx, 'Duck  ·  Lean to weave  ·  Gloves up to block  ·  Punch!', w / 2, h * 0.53, h / 26);
  if (game.frame.players.length > 2) drawText(ctx, 'Two boxers at a time — the two on the outside play', w / 2, h * 0.6, h / 30, theme.accent);
  if (ps.length) {
    if (startMenu.update(game.frame.players, now) === 'start') startBout();
    startMenu.draw(ctx, w, h);
  }
}

/** A nudge when the camera can't read this boxer well (from the tracker's facing/distance), or null. */
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
      drawText(ctx, 'Duck or lean to dodge · gloves up to block', w / 2, h * 0.3, h / 26);
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
        blip(880, 300, 'square', 0.15); // the bell
        roundElapsed = 0;
        go('fight');
      }
      break;
    }
    case 'fight':
      if (game.paused) drawPaused(ctx, w, h);
      else if (roundElapsed < 1.2) drawText(ctx, 'FIGHT!', w / 2, h * 0.3, h / 6, theme.accent);
      break;
    case 'break': {
      ctx.fillStyle = 'rgba(10,6,30,0.55)';
      ctx.fillRect(0, 0, w, h);
      drawText(ctx, `End of round ${round}`, w / 2, h * 0.3, h / 10, theme.accent);
      drawText(ctx, `Round ${round + 1} in ${Math.ceil(BREAK_SECONDS - t)}…`, w / 2, h * 0.45, h / 16);
      if (t >= BREAK_SECONDS) {
        round++;
        if (cpu) cpu.skill = Math.min(0.85, cpu.skill + 0.15); // sharper each round
        say(roundCall(round), { interrupt: true });
        go('countdown');
      }
      break;
    }
    case 'ko':
      drawText(ctx, 'K.O.!', w / 2, h * 0.3, (h / 4) * (1 + Math.max(0, 0.3 - t)), '#ff4d6d');
      if (t > 2.5) finish();
      break;
    case 'result': {
      ctx.fillStyle = 'rgba(10,6,30,0.5)';
      ctx.fillRect(0, 0, w, h);
      const title = winner ? `${winner.name} wins!` : "It's a draw!";
      drawText(ctx, title, w / 2, h * 0.25, h / 8, winner?.color ?? theme.accent);
      drawText(ctx, `${Math.ceil(red!.health)}  –  ${Math.ceil(blue!.health)}`, w / 2, h * 0.4, h / 14);
      if (winner) drawBelt(ctx, w / 2, h * 0.58, h * 0.36, now);
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
    if (p.burst) drawBurst(ctx, p.x, p.y - age * 60 - h / 40, (h / 4.4) * (1 - age * 0.3), age, p.spin);
    drawText(ctx, p.text, p.x, p.y - age * 60, (h / 11) * (1 + (1 - age) * 0.2), p.color);
    ctx.globalAlpha = 1;
  }
}

// Read-only peek for automated tests and debugging.
(window as unknown as { boxing: () => object }).boxing = () => ({
  stage,
  round,
  red: red && { name: red.name, health: red.health, duck: red.duck, weave: red.weave, guard: red.guard, cpu: red.playerId === null },
  blue: blue && { name: blue.name, health: blue.health, duck: blue.duck, weave: blue.weave, guard: blue.guard, cpu: blue.playerId === null },
  winner: winner?.name ?? null,
});

requestAnimationFrame(loop);
