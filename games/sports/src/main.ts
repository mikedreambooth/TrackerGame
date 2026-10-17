/**
 * Sports Day — three events with medals, a breather between each, and a
 * commentator. Event logic lives in race.ts / highjump.ts / hurdles.ts; this
 * file runs the day:
 *
 *   lobby → [intro → 3-2-1 → event → medals → rest]×3 → podium
 */
import {
  DwellMenu,
  createGame,
  drawCountdown,
  drawPaused,
  drawText,
  drawTitle,
  fitCanvas,
  playerColor,
  playerName,
  prepareSpeech,
  say,
  stopSpeaking,
  theme,
} from '@trackergame/sdk';
import { drawAthlete, drawMedal, drawStadium, medals, type Lane, type SportEvent } from './common';
import { HighJump } from './highjump';
import { Hurdles } from './hurdles';
import { Race } from './race';

const INTRO_MIN = 5; // seconds
const COUNTDOWN = 3;
const MEDALS = 6;
const REST = 15;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const game = await createGame();

const events: SportEvent[] = [new Race(), new HighJump(), new Hurdles()];
type Stage = 'lobby' | 'intro' | 'countdown' | 'event' | 'medals' | 'rest' | 'podium';
let stage: Stage = 'lobby';
let stageAt = performance.now();
let eventIndex = 0;
let lanes: Lane[] = [];
let totals: Record<number, number> = {};
let lastMedals: ReturnType<typeof medals> = [];
let introSpoken = false;
let eventElapsed = 0;
let lastCount = -1;

const startMenu = new DwellMenu([{ id: 'start', label: 'Start', x: 0.5, y: 0.66, w: 0.26, h: 0.14, color: '#e76f51' }]);
const endMenu = new DwellMenu([
  { id: 'again', label: 'Play again', x: 0.35, y: 0.9, w: 0.26, h: 0.11, color: '#e76f51' },
  { id: 'home', label: 'Home', x: 0.65, y: 0.9, w: 0.2, h: 0.11, color: '#3a2a80' },
]);

const current = () => events[eventIndex];
prepareSpeech([`Event 1. ${events[0].title}! ${events[0].howTo}`]);
const since = () => (performance.now() - stageAt) / 1000;

function go(s: Stage) {
  stage = s;
  stageAt = performance.now();
  lastCount = -1;
  if (s === 'intro') {
    introSpoken = false;
    const ev = current();
    say(`Event ${eventIndex + 1}. ${ev.title}! ${ev.howTo}`, { interrupt: true }).then(() => (introSpoken = true));
  }
  if (s === 'countdown') {
    // Start (reset) the event now so the countdown shows its starting line-up.
    eventElapsed = 0;
    current().start(lanes);
  }
  if (s === 'medals') {
    lastMedals = medals(current().results());
    for (const m of lastMedals) totals[m.slot] = (totals[m.slot] ?? 0) + m.points;
    const gold = lastMedals.filter((m) => m.place === 1).map((m) => playerName(m.slot));
    if (gold.length) say(`Gold medal for ${gold.join(' and ')}!`, { interrupt: true });
  }
  if (s === 'rest') {
    say(`Great work! Catch your breath. Next up, ${events[eventIndex + 1].title}.`, { interrupt: true });
  }
  if (s === 'podium') {
    const best = Math.max(...Object.values(totals));
    const champs = Object.keys(totals)
      .map(Number)
      .filter((s) => totals[s] === best)
      .map(playerName);
    game.reportScores(totals);
    say(`Sports day champion: ${champs.join(' and ')}! Well done everyone!`, { interrupt: true });
  }
}

function startDay() {
  lanes = [...game.frame.players]
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({ slot: p.slot, color: playerColor(p.slot), name: playerName(p.slot) }));
  if (!lanes.length) return;
  totals = Object.fromEntries(lanes.map((l) => [l.slot, 0]));
  eventIndex = 0;
  go('intro');
  // Synthesize the commentary ahead of time (natural voice), in the order it's needed.
  const names = lanes.map((l) => l.name);
  prepareSpeech([
    'On your marks',
    'Get set',
    'Go!',
    ...names.map((n) => `${n} wins the race!`),
    ...names.map((n) => `Gold medal for ${n}!`),
    ...events.slice(1).map((e) => `Great work! Catch your breath. Next up, ${e.title}.`),
    ...events.slice(1).map((e, i) => `Event ${i + 2}. ${e.title}! ${e.howTo}`),
    'Stand still. Get ready!',
    'Jump!',
    'Jump 2. Get ready!',
    'Jump 3. Get ready!',
    'Halfway! Keep jumping!',
    'Paused. Come back!',
    ...names.map((n) => `Sports day champion: ${n}! Well done everyone!`),
  ]);
}

game.on('handsUp', () => {
  if (stage === 'lobby') startDay();
  else if (stage === 'rest' && since() > 3) next();
  else if (stage === 'podium' && since() > 4) startDay();
});
game.on('pause', () => say('Paused. Come back!', { interrupt: true }));

/** After medals: rest, or the podium after the last event. */
function next() {
  if (stage === 'medals' && eventIndex < events.length - 1) return go('rest');
  if (stage === 'medals') return go('podium');
  if (stage === 'rest') {
    eventIndex++;
    go('intro');
  }
}

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { w, h } = fitCanvas(canvas, ctx);
  const t = since();
  const players = game.frame.players;

  switch (stage) {
    case 'lobby': {
      drawStadium(ctx, w, h, h * 0.55);
      lanes = [];
      players.forEach((p, i) =>
        drawAthlete(ctx, (w * (i + 1)) / (players.length + 1), h * 0.95, h * 0.28, p.color, { cheer: p.pose.handsUp }),
      );
      drawTitle(ctx, w, h, 'Sports Day', players.length ? 'Raise both hands to start!' : 'Step in to play!');
      drawText(ctx, 'Running Race  ·  High Jump  ·  Hurdles', w / 2, h * 0.53, h / 24);
      if (players.length) {
        if (startMenu.update(players, now) === 'start') startDay();
        startMenu.draw(ctx, w, h);
      }
      break;
    }
    case 'intro': {
      const ev = current();
      drawStadium(ctx, w, h, h * 0.6);
      drawText(ctx, `Event ${eventIndex + 1} of ${events.length}`, w / 2, h * 0.14, h / 18, theme.accent);
      drawText(ctx, ev.title, w / 2, h * 0.3, h / 7);
      drawText(ctx, ev.howTo, w / 2, h * 0.46, Math.min(h / 18, w / (ev.howTo.length * 0.5)));
      lanes.forEach((l, i) =>
        drawAthlete(ctx, (w * (i + 1)) / (lanes.length + 1), h * 0.95, h * 0.26, l.color, {
          phase: t * 8,
          stride: 0.4,
        }),
      );
      if (t > INTRO_MIN && (introSpoken || t > 14)) go('countdown');
      break;
    }
    case 'countdown': {
      current().draw(ctx, w, h, 0);
      const left = COUNTDOWN - t;
      const n = Math.ceil(left);
      if (n !== lastCount && n > 0) {
        lastCount = n;
        if (n >= 2) say(n === 3 ? 'On your marks' : 'Get set', { interrupt: true });
      }
      drawCountdown(ctx, w, h, left);
      if (left <= 0) {
        say('Go!', { interrupt: true });
        go('event');
      }
      break;
    }
    case 'event': {
      const ev = current();
      if (!game.paused) {
        eventElapsed += dt;
        ev.update(game.frame, eventElapsed, dt);
        for (const line of ev.callouts.splice(0)) say(line, { interrupt: true });
      }
      ev.draw(ctx, w, h, eventElapsed);
      if (game.paused) drawPaused(ctx, w, h);
      if (ev.done) go('medals');
      break;
    }
    case 'medals':
      drawMedalTable(w, h, current().title);
      if (t > MEDALS) next();
      break;
    case 'rest':
      drawRest(w, h, t);
      if (t > REST) next();
      break;
    case 'podium':
      drawPodium(w, h, t);
      if (t > 4) {
        const pick = endMenu.update(players, now);
        if (pick === 'again') startDay();
        if (pick === 'home') {
          stopSpeaking();
          game.exit();
        }
        endMenu.draw(ctx, w, h);
      }
      break;
  }
  requestAnimationFrame(loop);
}

function drawMedalTable(w: number, h: number, title: string) {
  drawStadium(ctx, w, h, h * 0.75);
  drawText(ctx, title, w / 2, h * 0.12, h / 12, theme.accent);
  const rowH = Math.min(h * 0.14, (h * 0.6) / Math.max(1, lastMedals.length));
  lastMedals.forEach((m, i) => {
    const y = h * 0.28 + i * rowH;
    if (m.place <= 3) drawMedal(ctx, w * 0.3, y + rowH * 0.15, rowH * 0.3, m.place);
    else drawText(ctx, `${m.place}th`, w * 0.3, y, rowH * 0.4);
    drawText(ctx, playerName(m.slot), w * 0.38, y, rowH * 0.5, playerColor(m.slot), { align: 'left' });
    drawText(ctx, m.label, w * 0.72, y, rowH * 0.45, '#fff', { align: 'right' });
  });
}

function drawRest(w: number, h: number, t: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#264653');
  g.addColorStop(1, '#2a9d8f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  drawText(ctx, 'Catch your breath!', w / 2, h * 0.12, h / 11, theme.accent);
  // Breathing circle: 4 s in, 4 s out.
  const cycle = (t % 8) / 8;
  const breathe = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
  const eased = 0.5 - Math.cos(breathe * Math.PI) / 2;
  const r = h * (0.1 + eased * 0.12);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.47, r * 1.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.47, r, 0, Math.PI * 2);
  ctx.fill();
  drawText(ctx, cycle < 0.5 ? 'Breathe in…' : 'Breathe out…', w / 2, h * 0.47, h / 18);
  const left = Math.max(0, Math.ceil(REST - t));
  drawText(ctx, `Next: ${events[eventIndex + 1].title} in ${left}`, w / 2, h * 0.78, h / 16);
  if (t > 3) drawText(ctx, 'Ready early? Raise both hands', w / 2, h * 0.88, h / 26);
  drawScores(w, h * 0.96);
}

function drawPodium(w: number, h: number, t: number) {
  drawStadium(ctx, w, h, h * 0.55);
  drawText(ctx, 'Sports Day Champions!', w / 2, h * 0.1, h / 12, theme.accent);
  const ranked = medals(Object.entries(totals).map(([s, v]) => ({ slot: Number(s), score: v, label: `${v} pts` })));
  const blockW = w * 0.16;
  const heights: Record<number, number> = { 1: 0.26, 2: 0.18, 3: 0.12 };
  const order = [2, 1, 3, 4];
  const ground = h * 0.72;
  ranked.forEach((m) => {
    const col = order.indexOf(Math.min(m.place, 4));
    const x = w / 2 + (col - 1.5) * blockW * 1.1;
    const bh = (heights[m.place] ?? 0.06) * h;
    ctx.fillStyle = m.place === 1 ? '#ffd166' : m.place === 2 ? '#d9d9d9' : m.place === 3 ? '#cd7f32' : '#6c757d';
    ctx.fillRect(x - blockW / 2, ground - bh, blockW, bh);
    drawText(ctx, String(m.place), x, ground - bh / 2, Math.min(bh * 0.6, h / 10), '#1b1030', { stroke: false });
    drawAthlete(ctx, x, ground - bh, h * 0.22, playerColor(m.slot), {
      cheer: m.place === 1 || Math.floor(t * 2) % 2 === 0,
      lift: m.place === 1 ? Math.abs(Math.sin(t * 5)) * 20 : 0,
    });
    drawText(ctx, `${playerName(m.slot)} · ${m.label}`, x, ground + h * 0.045, h / 28, playerColor(m.slot));
  });
}

function drawScores(w: number, y: number) {
  const slots = Object.keys(totals).map(Number);
  slots.forEach((s, i) => {
    const x = (w * (i + 1)) / (slots.length + 1);
    drawText(ctx, `${playerName(s)} ${totals[s]} pts`, x, y, 22, playerColor(s));
  });
}

requestAnimationFrame(loop);

// Read-only peek for automated tests and debugging in the console.
(window as unknown as { sportsDay: () => object }).sportsDay = () => ({ stage, eventIndex, eventElapsed, totals });
