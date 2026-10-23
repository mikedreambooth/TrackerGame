/**
 * Piano — two octaves of piano keys across the top of the screen. Raise a hand into
 * a key to play it; the note rings while your hand stays there and stops when you
 * pull it out. Sweep along the keys for a glissando. Everyone can play at once.
 *
 * Hands use their real positions (stretched across the whole screen), so players
 * stand where the notes they want are: low notes on the left, high on the right.
 *
 * "Play songs" plays three tunes back to back: only the next note's keys (in every
 * octave) can be played, glowing with an arrow; the rest are greyed out. Each song
 * waits for its next note, so nobody can fall behind.
 *
 * Artwork: art/generate.py (Gemini) -> public/art.
 */
import {
  DwellMenu,
  KP,
  createGame,
  drawSkeleton,
  drawText,
  fitCanvas,
  loadAssets,
  pianoNote,
  prepareSpeech,
  say,
  theme,
  type Frame,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

const LOWEST = 60; // middle C
const OCTAVES = 2;
/** Keyboard area, in screen fractions. */
const KB = { x0: 0.03, x1: 0.97, top: 0.12, bottom: 0.5 };
const BLACK_H = 0.6; // of the white key height
const BLACK_W = 0.6; // of the white key width
const WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];
/** Black keys sit after these white keys (C#, D#, F#, G#, A#). */
const HAS_BLACK = [true, true, false, true, true, true, false];

interface Key {
  midi: number;
  black: boolean;
  name: string;
  /** Screen fractions. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Colours of the hands holding it down right now. */
  down: string[];
}

/** One tracked hand: which key it's in and how to lift it. */
interface Hand {
  key: Key | null;
  release: (() => void) | null;
}

interface Song {
  title: string;
  /** MIDI notes, from middle C up. */
  notes: number[];
}

// Traditional tunes (public domain), in C.
const [C, D, E, F, G, A] = [60, 62, 64, 65, 67, 69];
const SONGS: Song[] = [
  {
    title: 'Twinkle Twinkle Little Star',
    notes: [C, C, G, G, A, A, G, F, F, E, E, D, D, C, G, G, F, F, E, E, D, G, G, F, F, E, E, D, C, C, G, G, A, A, G, F, F, E, E, D, D, C],
  },
  {
    title: 'Mary Had a Little Lamb',
    notes: [E, D, C, D, E, E, E, D, D, D, E, G, G, E, D, C, D, E, E, E, E, D, D, E, D, C],
  },
  {
    title: 'Ode to Joy',
    notes: [E, E, F, G, G, F, E, D, C, C, D, E, E, D, D, E, E, F, G, G, F, E, D, C, C, D, E, D, C, C],
  },
];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

interface FloatingNote {
  x: number;
  y: number;
  color: string;
  sprite: 'note1' | 'note2';
  at: number;
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// Reaching up for the black keys looks just like the hands-up "go home" gesture, so that's
// off here (Home button or Esc instead). Free play, so no auto-pause either.
const game = await createGame({ exitGesture: false, autoPause: false, people: false }); // hands use their own mapping: cut-outs would not line up
const assets = await loadAssets({
  images: {
    background: 'art/background.jpg',
    wood: 'art/wood.jpg',
    note1: 'art/note1.png',
    note2: 'art/note2.png',
    sparkle: 'art/sparkle.png',
  },
});
const img = assets.images;

/** Draws an image to cover a w x h area at (x, y) (centred, cropped), like CSS background-size: cover. */
function cover(im: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const k = Math.max(w / im.width, h / im.height);
  ctx.drawImage(im, x + (w - im.width * k) / 2, y + (h - im.height * k) / 2, im.width * k, im.height * k);
}

const keys = buildKeys();
const whites = keys.filter((k) => !k.black);
const blacks = keys.filter((k) => k.black);
const whiteW = (KB.x1 - KB.x0) / whites.length;
const hands = new Map<string, Hand>();
const floating: FloatingNote[] = [];

/** Songs mode: which song and note we're on; `cheerAt` is set between songs. */
let song: { index: number; note: number; cheerAt: number } | null = null;

// Buttons are pressed by a crouch-and-reach, low down out of the way of the keys, and slowly.
const lowestTip = (p: Player) => {
  const tips = [fingertip(p, 'left'), fingertip(p, 'right')].filter((t): t is Vec2 => !!t);
  return tips.sort((a, b) => b.y - a.y)[0] ?? null;
};
const HOME = { id: 'home', label: 'Home', x: 0.92, y: 0.9, w: 0.12, h: 0.1, color: '#3a2a80' };
const freeMenu = new DwellMenu([{ id: 'songs', label: 'Play songs', x: 0.76, y: 0.9, w: 0.17, h: 0.1, color: '#2a9d8f' }, HOME], 1500, lowestTip);
const songMenu = new DwellMenu([{ id: 'stop', label: 'Stop', x: 0.79, y: 0.9, w: 0.11, h: 0.1, color: '#9d0208' }, HOME], 1500, lowestTip);

const LINES = {
  hello: 'Piano! Raise your hands into the keys to play.',
  start: (t: string) => `Let's play ${t}! Play the glowing keys.`,
  next: (t: string) => `Well played! Next song: ${t}.`,
  done: 'Well played! You played all three songs!',
};
prepareSpeech([LINES.hello, LINES.done, ...SONGS.map((s) => LINES.start(s.title)), ...SONGS.map((s) => LINES.next(s.title))]);
say(LINES.hello);

/** The note the song is waiting for, or null when any key may be played. */
function wanted(): number | null {
  if (!song || song.cheerAt) return null;
  return SONGS[song.index].notes[song.note];
}

/** In a song only the wanted note can be played, in any octave. */
const playable = (k: Key) => {
  const want = wanted();
  return want === null || k.midi % 12 === want % 12;
};

function startSongs() {
  song = { index: 0, note: 0, cheerAt: 0 };
  say(LINES.start(SONGS[0].title), { interrupt: true });
}

/** A correct note: move on, and celebrate at the end of each song. */
function advance(now: number) {
  if (!song) return;
  song.note++;
  if (song.note < SONGS[song.index].notes.length) return;
  song.cheerAt = now;
  const last = song.index === SONGS.length - 1;
  say(last ? LINES.done : LINES.next(SONGS[song.index + 1].title), { interrupt: true });
  [72, 76, 79, 84].forEach((m, i) => setTimeout(() => setTimeout(pianoNote(m, 0.35), 500), 300 + i * 160));
}

function buildKeys(): Key[] {
  const list: Key[] = [];
  const count = OCTAVES * 7 + 1; // finish on a top C
  const w = (KB.x1 - KB.x0) / count;
  const h = KB.bottom - KB.top;
  for (let i = 0; i < count; i++) {
    const octave = Math.floor(i / 7);
    const step = i % 7;
    const midi = LOWEST + octave * 12 + WHITE_STEPS[step];
    list.push({ midi, black: false, name: WHITE_NAMES[step], x: KB.x0 + i * w, y: KB.top, w, h, down: [] });
    if (HAS_BLACK[step] && i < count - 1) {
      list.push({
        midi: midi + 1,
        black: true,
        name: `${WHITE_NAMES[step]}#`,
        x: KB.x0 + (i + 1) * w - (w * BLACK_W) / 2,
        y: KB.top,
        w: w * BLACK_W,
        h: h * BLACK_H,
        down: [],
      });
    }
  }
  return list;
}

/** Keypoints are 0..1 of the camera; the piano uses the whole screen, so just stretch. */
const toScreen = (p: Vec2): Vec2 => ({ x: p.x, y: p.y });

/** A point a little beyond the wrist, where the fingers are. Null if that arm isn't seen. */
function fingertip(p: Player, side: 'left' | 'right'): Vec2 | null {
  const k = p.keypoints;
  const wrist = k[side === 'left' ? KP.leftWrist : KP.rightWrist];
  const elbow = k[side === 'left' ? KP.leftElbow : KP.rightElbow];
  if (wrist.score < 0.35) return null;
  const tip = elbow.score >= 0.35 ? { x: wrist.x + (wrist.x - elbow.x) * 0.35, y: wrist.y + (wrist.y - elbow.y) * 0.35 } : wrist;
  return toScreen(tip);
}

const inside = (k: Key, p: Vec2) => p.x >= k.x && p.x < k.x + k.w && p.y >= k.y && p.y < k.y + k.h;
/** Black keys are on top, so they win where they overlap a white key. Greyed-out keys don't play. */
function keyAt(p: Vec2): Key | null {
  const k = blacks.find((k) => inside(k, p)) ?? whites.find((k) => inside(k, p)) ?? null;
  return k && playable(k) ? k : null;
}

/**
 * Which key a hand is in, with some stickiness: to move to a neighbouring key the hand must
 * be a little way into it, so a hand resting on a boundary doesn't flutter between notes.
 */
function keyFor(p: Vec2, current: Key | null): Key | null {
  const k = keyAt(p);
  // A key you're holding keeps ringing after the song moves on (lift and re-press for repeats).
  if (current && !k && inside(current, p) && !blacks.some((b) => b !== current && inside(b, p))) return current;
  if (!current || k === current) return k;
  const cx = current.x + current.w / 2;
  const cy = current.y + current.h / 2;
  const d = Math.hypot(cx - p.x, cy - p.y) || 1;
  const m = whiteW * 0.15;
  return keyAt({ x: p.x + ((cx - p.x) / d) * m, y: p.y + ((cy - p.y) / d) * m }) === current ? current : k;
}

function onFrame(f: Frame) {
  const seen = new Set<string>();
  for (const p of f.players) {
    for (const side of ['left', 'right'] as const) {
      const id = `${p.id}:${side}`;
      seen.add(id);
      const hand = hands.get(id) ?? { key: null, release: null };
      hands.set(id, hand);
      const tip = fingertip(p, side);
      const next = tip ? keyFor(tip, hand.key) : null;
      if (next === hand.key) continue;
      lift(hand, p.color);
      if (next) press(hand, next, p, side);
    }
  }
  // Hands that left the camera let go of their keys.
  for (const [id, hand] of hands) {
    if (seen.has(id)) continue;
    lift(hand);
    hands.delete(id);
  }
}

function press(hand: Hand, key: Key, p: Player, side: 'left' | 'right') {
  // Faster hands play louder.
  const k = p.keypoints[side === 'left' ? KP.leftWrist : KP.rightWrist];
  const speed = Math.hypot(k.vx, k.vy) / Math.max(p.shoulderWidth, 0.03);
  const volume = Math.min(0.6, 0.3 + speed * 0.03);
  const correct = wanted() !== null;
  hand.key = key;
  hand.release = pianoNote(key.midi, volume);
  if (correct) advance(performance.now());
  key.down.push(p.color);
  floating.push({
    x: key.x + key.w / 2,
    y: key.y,
    color: p.color,
    sprite: Math.random() < 0.5 ? 'note1' : 'note2',
    at: performance.now(),
  });
}

function lift(hand: Hand, color?: string) {
  hand.release?.();
  if (hand.key) {
    const i = color ? hand.key.down.indexOf(color) : 0;
    hand.key.down.splice(i < 0 ? 0 : i, 1);
  }
  hand.key = null;
  hand.release = null;
}

game.onFrame(onFrame);

// ---------- drawing ----------

function loop(now: number) {
  const { w, h } = fitCanvas(canvas, ctx);
  // A little concert-hall stage, dimmed so the keys, players and words stand out.
  cover(img.background, 0, 0, w, h);
  ctx.fillStyle = 'rgba(20, 10, 30, 0.35)';
  ctx.fillRect(0, 0, w, h);

  // Only what plays: each player's head (where they stand: low notes left, high right) and
  // arms, faint, leading up to the bright fingertip dots drawn over the keys below.
  const map = (p: Vec2) => ({ x: p.x * w, y: p.y * h });
  for (const p of game.frame.players) drawSkeleton(ctx, p, map, { alpha: 0.25, lineWidth: 12, parts: ['head', 'arms'] });

  drawPiano(w, h, now);
  drawFloating(w, h, now);

  // Where each hand is.
  for (const p of game.frame.players) {
    for (const side of ['left', 'right'] as const) {
      const tip = fingertip(p, side);
      if (!tip) continue;
      const playing = !!hands.get(`${p.id}:${side}`)?.key;
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = playing ? 6 : 4;
      ctx.globalAlpha = playing ? 1 : 0.8;
      ctx.beginPath();
      ctx.arc(tip.x * w, tip.y * h, playing ? 20 : 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  const anyPlaying = [...hands.values()].some((hd) => hd.key);
  if (song) drawSong(w, h, now);
  else if (!game.frame.players.length) drawText(ctx, 'Step in front of the camera to play!', w / 2, h * 0.68, h / 16, theme.accent);
  else if (!anyPlaying) drawText(ctx, 'Raise your hands into the keys!', w / 2, h * 0.68, h / 16, theme.accent);
  if (song?.cheerAt && now - song.cheerAt > 4000) {
    if (song.index < SONGS.length - 1) song = { index: song.index + 1, note: 0, cheerAt: 0 };
    else song = null;
  }
  if (!song) {
    // (In a song the arrows over the glowing keys use this space.)
    drawText(ctx, 'Low notes', w * 0.05, h * 0.05, h / 32, '#a8dadc', { align: 'left' });
    drawText(ctx, 'High notes', w * 0.95, h * 0.05, h / 32, '#a8dadc', { align: 'right' });
  }

  const menu = song ? songMenu : freeMenu;
  const pick = menu.update(game.frame.players, now);
  if (pick === 'home') game.exit();
  if (pick === 'songs') startSongs();
  if (pick === 'stop') song = null;
  menu.draw(ctx, w, h);
  requestAnimationFrame(loop);
}

function drawPiano(w: number, h: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  const pad = h * 0.025;
  const x0 = KB.x0 * w;
  const x1 = KB.x1 * w;
  const top = KB.top * h;
  const bottom = KB.bottom * h;
  // Polished wooden case with a red felt strip.
  const cx = x0 - pad;
  const cy = top - pad * 2;
  const cw = x1 - x0 + pad * 2;
  const ch = bottom - top + pad * 3;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = pad * 1.5;
  ctx.shadowOffsetY = pad * 0.4;
  ctx.fillStyle = '#14141f';
  ctx.beginPath();
  ctx.roundRect(cx, cy, cw, ch, pad);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cx, cy, cw, ch, pad);
  ctx.clip();
  cover(img.wood, cx, cy, cw, ch);
  const gloss = ctx.createLinearGradient(0, cy, 0, cy + pad * 2);
  gloss.addColorStop(0, 'rgba(255, 230, 200, 0.35)');
  gloss.addColorStop(1, 'rgba(255, 230, 200, 0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(cx, cy, cw, pad * 2);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255, 220, 170, 0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cx + 1, cy + 1, cw - 2, ch - 2, pad);
  ctx.stroke();
  // Dark well behind the keys.
  ctx.fillStyle = '#14141f';
  ctx.fillRect(x0, top - pad * 0.6, x1 - x0, bottom - top + pad * 0.6);
  ctx.fillStyle = '#9d0208';
  ctx.fillRect(x0, top - pad * 0.6, x1 - x0, pad * 0.6);

  for (const k of whites) {
    const pressed = k.down.length > 0;
    const x = k.x * w;
    const y = k.y * h;
    const kw = k.w * w;
    const kh = k.h * h - (pressed ? 0 : h * 0.008);
    const off = !pressed && !playable(k);
    const glow = !pressed && wanted() !== null && playable(k);
    ctx.fillStyle = pressed ? k.down[k.down.length - 1] : off ? '#5c6370' : glow ? `rgba(255, 190, 11, ${0.55 + 0.45 * pulse})` : '#fffaf0';
    ctx.strokeStyle = '#14141f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 1, y, kw - 2, kh, [0, 0, kw * 0.12, kw * 0.12]);
    ctx.fill();
    ctx.stroke();
    if (!pressed && !off) {
      // Rounded front edge.
      ctx.fillStyle = glow ? '#e09f00' : '#e6dccb';
      ctx.fillRect(x + 2, y + kh - h * 0.012, kw - 4, h * 0.012);
    }
    drawText(ctx, k.name, x + kw / 2, y + kh - h * 0.04, Math.min(kw * 0.4, h / 28), pressed ? '#fff' : off ? '#7d8590' : glow ? '#1b1030' : '#6c757d', {
      stroke: pressed ? undefined : false,
    });
  }
  for (const k of blacks) {
    const pressed = k.down.length > 0;
    const x = k.x * w;
    const y = k.y * h;
    const kw = k.w * w;
    const kh = k.h * h;
    const off = !pressed && !playable(k);
    const glow = !pressed && wanted() !== null && playable(k);
    ctx.fillStyle = pressed ? k.down[k.down.length - 1] : off ? '#3b3f47' : glow ? `rgba(255, 190, 11, ${0.6 + 0.4 * pulse})` : '#1b1b28';
    ctx.beginPath();
    ctx.roundRect(x, y, kw, kh, [0, 0, kw * 0.15, kw * 0.15]);
    ctx.fill();
    if (!pressed && !off && !glow) {
      ctx.fillStyle = '#3a3a4f';
      ctx.beginPath();
      ctx.roundRect(x + kw * 0.15, y, kw * 0.7, kh * 0.9, [0, 0, kw * 0.1, kw * 0.1]);
      ctx.fill();
    }
  }
}

/** Arrows over the glowing keys, the song title, progress and the next few notes. */
function drawSong(w: number, h: number, now: number) {
  const s = SONGS[song!.index];
  const want = wanted();
  if (want !== null) {
    const bounce = Math.abs(Math.sin(now / 200)) * h * 0.02;
    for (const k of keys) {
      if (k.midi % 12 !== want % 12 || k.down.length) continue;
      const x = (k.x + k.w / 2) * w;
      const y = KB.top * h - h * 0.035 - bounce;
      ctx.fillStyle = theme.accent;
      ctx.beginPath();
      ctx.moveTo(x - h * 0.025, y - h * 0.03);
      ctx.lineTo(x + h * 0.025, y - h * 0.03);
      ctx.lineTo(x, y);
      ctx.fill();
    }
  }
  // A soft dark panel so the words read over the stage.
  ctx.fillStyle = 'rgba(15, 8, 25, 0.55)';
  ctx.beginPath();
  ctx.roundRect(w * 0.2, h * 0.555, w * 0.6, h * 0.29, h * 0.03);
  ctx.fill();
  drawText(ctx, s.title, w / 2, h * 0.6, h / 18, '#fff');
  drawText(ctx, `Song ${song!.index + 1} of ${SONGS.length}`, w / 2, h * 0.66, h / 34, '#a8dadc');
  if (song!.cheerAt) {
    // Golden stars twinkling around the cheer.
    const t = (now - song!.cheerAt) / 1000;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + t * 0.8;
      const size = h * (0.05 + 0.015 * Math.sin(t * 6 + i * 1.7));
      const x = w / 2 + Math.cos(ang) * w * 0.26;
      const y = h * 0.77 + Math.sin(ang) * h * 0.07;
      ctx.drawImage(img.sparkle, x - size / 2, y - size / 2, size, size);
    }
    drawText(ctx, 'Well played! ★', w / 2, h * 0.77, (h / 10) * (1 + Math.sin(now / 120) * 0.04), theme.accent);
    return;
  }
  // Progress bar.
  const bw = w * 0.5;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.roundRect(w / 2 - bw / 2, h * 0.695, bw, h * 0.018, h * 0.009);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.roundRect(w / 2 - bw / 2, h * 0.695, Math.max(h * 0.018, (bw * song!.note) / s.notes.length), h * 0.018, h * 0.009);
  ctx.fill();
  // Next notes: the one to play big, then what's coming.
  const upcoming = s.notes.slice(song!.note, song!.note + 7);
  const step = h * 0.1;
  const x0 = w / 2 - ((upcoming.length - 1) * step) / 2;
  upcoming.forEach((m, i) => {
    const size = i === 0 ? h / 11 : h / 22;
    drawText(ctx, NOTE_NAMES[m % 12], x0 + i * step, h * 0.79, size, i === 0 ? theme.accent : `rgba(255,255,255,${0.8 - i * 0.1})`);
  });
}

function drawFloating(w: number, h: number, now: number) {
  for (let i = floating.length - 1; i >= 0; i--) {
    const n = floating[i];
    const age = (now - n.at) / 1200;
    if (age > 1) {
      floating.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = 1 - age;
    // A golden note with a glow in the player's colour.
    const size = h * 0.075;
    ctx.shadowColor = n.color;
    ctx.shadowBlur = size * 0.4;
    ctx.drawImage(img[n.sprite], n.x * w + Math.sin(age * 9) * 12 - size / 2, n.y * h - age * h * 0.1 - size * 0.8, size, size);
    ctx.restore();
  }
}

// Read-only peek for automated tests and debugging.
(window as unknown as { piano: () => object }).piano = () => ({
  song: song && { title: SONGS[song.index].title, note: song.note, of: SONGS[song.index].notes.length, cheering: !!song.cheerAt },
  wanted: wanted(),
  down: keys.filter((k) => k.down.length).map((k) => k.name + Math.floor(k.midi / 12 - 1)),
  hands: [...hands.entries()].map(([id, hd]) => `${id}=${hd.key ? hd.key.name : '-'}`),
});

requestAnimationFrame(loop);
