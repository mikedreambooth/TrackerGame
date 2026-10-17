/**
 * Beat Bash — a Beat Saber-style rhythm game simplified for kids.
 *
 * Targets fly in from the distance and land around each player's own body
 * (so short and tall players reach them equally). Touch a target with your
 * hand as it lands: red = left hand, blue = right (Easy: any hand), gold star =
 * both hands up, purple bar = duck. No failing — combos, sparkles and stars.
 *
 * Music: Incompetech audio files (beats detected automatically) or YouTube
 * videos (beat grid set once by a grown-up in the Song Editor).
 */
import {
  DwellMenu,
  KP,
  blip,
  createGame,
  drawPaused,
  drawText,
  fitCanvas,
  handCursor,
  playerName,
  prepareSpeech,
  say,
  screenMapper,
  type DwellButton,
  type Player,
  type Vec2,
} from '@trackergame/sdk';
import { analyzeUrl } from './detect';
import { FileMusic, YouTubeMusic, type Music } from './music';
import { chartNotes, loadSongs, needsSetup, type Difficulty, type Note, type Song } from './songs';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const videoEl = document.getElementById('video')!;
const game = await createGame();

/** Hit window (s) either side of the beat, and the tighter "Perfect" window. */
const GOOD = 0.24;
const PERFECT = 0.1;
const LEFT = '#ff4d6d';
const RIGHT = '#3a86ff';
const STAR = '#ffbe0b';
const DUCK = '#c77dff';
const SONGS_PER_PAGE = 6;

// ---------- settings remembered on this device ----------

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`beats.${k}`);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`beats.${k}`, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};
let difficulty: Difficulty = store.get('difficulty', 'easy');
/** Camera + tracking delay (ms): body positions arrive this late. Adjustable on the song screen. */
let latencyMs: number = store.get('latencyMs', 120);

// ---------- state ----------

type Stage = 'select' | 'loading' | 'play' | 'results' | 'credits';
let stage: Stage = 'select';
let stageAt = performance.now();
let songs: Song[] = [];
let songPage = 0;
let message = '';
let song: Song | null = null;
let music: Music | null = null;
let notes: Note[] = [];
let duration = 0;
let songEnd = 0;
let selectMenu = new DwellMenu([]);
const resultsMenu = new DwellMenu([
  { id: 'again', label: 'Play again', x: 0.3, y: 0.85, w: 0.22, h: 0.12, color: '#7209b7' },
  { id: 'songs', label: 'Songs', x: 0.53, y: 0.85, w: 0.18, h: 0.12, color: '#3a0ca3' },
  { id: 'home', label: 'Home', x: 0.73, y: 0.85, w: 0.16, h: 0.12, color: '#240046' },
]);
const creditsMenu = new DwellMenu([{ id: 'back', label: 'Back', x: 0.5, y: 0.88, w: 0.2, h: 0.11, color: '#3a0ca3' }]);

interface PlayerScore {
  slot: number;
  color: string;
  score: number;
  combo: number;
  maxCombo: number;
  perfect: number;
  good: number;
  miss: number;
  /** Per note: undefined = pending, else the result. */
  done: Map<number, 'perfect' | 'good' | 'miss'>;
  /** Notes touched before the Perfect window opened. */
  early: Set<number>;
  /** Standing nose height, for duck detection. */
  noseBase: number | null;
}
const scores = new Map<number, PlayerScore>();
const bursts: { x: number; y: number; vx: number; vy: number; color: string; life: number }[] = [];
const pops: { x: number; y: number; text: string; color: string; at: number }[] = [];
const handTrails = new Map<string, Vec2[]>();
/** Upcoming targets on screen last frame (for tests / debugging). */
let peekTargets: { x: number; y: number; dt: number; kind: string }[] = [];

const since = () => (performance.now() - stageAt) / 1000;
function go(s: Stage) {
  stage = s;
  stageAt = performance.now();
}

prepareSpeech(['Get ready!', 'Amazing!', 'Great dancing!', 'Nice moves!', 'Pick a song!']);

// ---------- song select ----------

async function refreshSongs() {
  songs = await loadSongs();
  // Hide audio songs whose files aren't there (e.g. a download failed at build time).
  const ok = await Promise.all(
    songs.map(async (s) => {
      if (s.source.type !== 'file') return true;
      try {
        return (await fetch(s.source.url, { method: 'HEAD' })).ok;
      } catch {
        return false;
      }
    }),
  );
  songs = songs.filter((_, i) => ok[i]);
  buildSelectMenu();
}

let portrait = innerHeight > innerWidth;
function buildSelectMenu() {
  portrait = innerHeight > innerWidth;
  // On a portrait phone the simulator's buttons sit along the bottom; keep ours clear of them.
  const rowY = portrait ? 0.71 : 0.82;
  const pages = Math.max(1, Math.ceil(songs.length / SONGS_PER_PAGE));
  songPage = Math.min(songPage, pages - 1);
  const buttons: DwellButton[] = songs.slice(songPage * SONGS_PER_PAGE, (songPage + 1) * SONGS_PER_PAGE).map((s, i) => ({
    id: `song:${s.id}`,
    label: needsSetup(s) ? `${s.title} ⚙` : s.title,
    x: 0.22 + (i % 3) * 0.28,
    y: 0.31 + Math.floor(i / 3) * 0.19,
    w: 0.25,
    h: 0.15,
    color: needsSetup(s) ? '#3c3c50' : s.source.type === 'youtube' ? '#c1121f' : '#7209b7',
  }));
  if (pages > 1) {
    buttons.push({ id: 'prev', label: '◀', x: 0.04, y: 0.44, w: 0.06, h: 0.3, color: '#3a0ca3' });
    buttons.push({ id: 'next', label: '▶', x: 0.96, y: 0.44, w: 0.06, h: 0.3, color: '#3a0ca3' });
  }
  buttons.push(
    { id: 'difficulty', label: difficulty === 'easy' ? 'Easy (any hand)' : 'Normal (red L, blue R)', x: 0.17, y: rowY, w: 0.27, h: 0.1, color: '#2a9d8f' },
    { id: 'timing', label: `Timing ${latencyMs} ms`, x: 0.41, y: rowY, w: 0.18, h: 0.1, color: '#264653' },
    { id: 'editor', label: 'Editor', x: 0.585, y: rowY, w: 0.13, h: 0.1, color: '#264653' },
    { id: 'credits', label: 'Credits', x: 0.725, y: rowY, w: 0.13, h: 0.1, color: '#264653' },
    { id: 'home', label: 'Home', x: 0.87, y: rowY, w: 0.12, h: 0.1, color: '#240046' },
  );
  selectMenu = new DwellMenu(buttons);
}

function onSelect(id: string) {
  if (id === 'prev' || id === 'next') {
    const pages = Math.ceil(songs.length / SONGS_PER_PAGE);
    songPage = (songPage + (id === 'next' ? 1 : -1) + pages) % pages;
    buildSelectMenu();
  } else if (id === 'difficulty') {
    difficulty = difficulty === 'easy' ? 'normal' : 'easy';
    store.set('difficulty', difficulty);
    buildSelectMenu();
  } else if (id === 'timing') {
    // Cycle through common camera delays; pick the one where hits feel on time.
    const options = [60, 90, 120, 150, 180, 210, 240];
    latencyMs = options[(options.indexOf(latencyMs) + 1) % options.length] ?? 120;
    store.set('latencyMs', latencyMs);
    buildSelectMenu();
  } else if (id === 'credits') go('credits');
  else if (id === 'editor') openEditor();
  else if (id === 'home') game.exit();
  else if (id.startsWith('song:')) {
    const s = songs.find((x) => `song:${x.id}` === id);
    if (!s) return;
    if (needsSetup(s)) {
      message = `"${s.title}" needs its beat setting up first — a grown-up can do it in the Song Editor.`;
      blip(200, 200, 'square', 0.1);
      return;
    }
    void startSong(s);
  }
}

/** The editor is a normal touch/mouse page, so open it full-window (not inside the launcher's game frame). */
function openEditor() {
  const url = new URL('editor.html', location.href);
  try {
    const top = window.top ?? window;
    url.searchParams.set('back', top.location.href);
    top.location.href = url.href;
  } catch {
    location.href = url.href;
  }
}

// ---------- loading & playing ----------

async function startSong(s: Song) {
  song = s;
  message = '';
  go('loading');
  music?.destroy();
  if (s.source.type === 'youtube') {
    const m = new YouTubeMusic(s.source.videoId, videoEl);
    music = m;
    await m.load();
    duration = m.duration;
  } else {
    const url = new URL(s.source.url, document.baseURI).href;
    const m = new FileMusic(url);
    music = m;
    await m.load();
    // Tempo + duration from the audio itself (cached per song on this device).
    const cacheKey = `detect.${s.id}`;
    let info = store.get<{ bpm: number; offset: number; duration: number } | null>(cacheKey, null);
    if (!info && m.state !== 'error') {
      try {
        info = await analyzeUrl(url);
        store.set(cacheKey, { bpm: info.bpm, offset: info.offset, duration: info.duration });
      } catch (e) {
        console.warn('[beats] beat detection failed', e);
      }
    }
    if (info) {
      duration = info.duration;
      m.duration = info.duration;
      if (s.bpm === undefined) s = song = { ...s, bpm: info.bpm, offset: info.offset };
    }
  }
  if (!music || music.state === 'error') {
    message = `Couldn't play "${s.title}": ${music?.error ?? 'unknown error'}`;
    music?.destroy();
    music = null;
    go('select');
    return;
  }
  notes = chartNotes(s, duration || 600, difficulty);
  songEnd = Math.min(s.end ?? Infinity, duration || Infinity, (notes.at(-1)?.t ?? 0) + 3);
  scores.clear();
  for (const p of game.frame.players) ensureScore(p);
  say('Get ready!', { interrupt: true });
  music.play(s.start ?? 0);
  go('play');
}

function ensureScore(p: Player): PlayerScore {
  let sc = scores.get(p.slot);
  if (!sc) {
    sc = { slot: p.slot, color: p.color, score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0, done: new Map(), early: new Set(), noseBase: null };
    scores.set(p.slot, sc);
  }
  return sc;
}

game.on('pause', () => {
  if (stage === 'play' && music) music.pause();
});
game.on('resume', () => {
  if (stage === 'play' && music) music.play(music.time());
});

// ---------- target geometry (relative to each player's body) ----------

function anchors(p: Player) {
  const k = p.keypoints;
  const S = Math.max(p.shoulderWidth, 0.03);
  const m = {
    x: (k[KP.leftShoulder].x + k[KP.rightShoulder].x) / 2,
    y: (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2,
  };
  return {
    S,
    LH: { x: m.x - 1.3 * S, y: m.y - 1.0 * S },
    LL: { x: m.x - 1.5 * S, y: m.y + 0.7 * S },
    RH: { x: m.x + 1.3 * S, y: m.y - 1.0 * S },
    RL: { x: m.x + 1.5 * S, y: m.y + 0.7 * S },
    both: { x: m.x, y: m.y - 1.8 * S },
    head: { x: k[KP.nose].x, y: k[KP.nose].y },
  };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function isDucking(p: Player, sc: PlayerScore): boolean {
  const k = p.keypoints;
  const T = p.shoulderWidth * 1.3;
  if (sc.noseBase === null) sc.noseBase = k[KP.nose].y;
  const drop = (k[KP.nose].y - sc.noseBase) / T;
  if (Math.abs(drop) < 0.12) sc.noseBase += (k[KP.nose].y - sc.noseBase) * 0.03;
  else if (drop < 0) sc.noseBase += (k[KP.nose].y - sc.noseBase) * 0.2;
  return p.pose.crouching || drop > 0.3;
}

function judge(sc: PlayerScore, i: number, result: 'perfect' | 'good' | 'miss', at: Vec2 | null, color: string) {
  sc.done.set(i, result);
  if (result === 'miss') {
    sc.combo = 0;
    sc.miss++;
    return;
  }
  sc.combo++;
  sc.maxCombo = Math.max(sc.maxCombo, sc.combo);
  const mult = Math.min(4, 1 + Math.floor(sc.combo / 8));
  sc.score += (result === 'perfect' ? 100 : 60) * mult;
  if (result === 'perfect') sc.perfect++;
  else sc.good++;
  if (at) {
    for (let j = 0; j < 22; j++) {
      const a = Math.random() * Math.PI * 2;
      const v = 150 + Math.random() * 450;
      bursts.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: Math.random() < 0.3 ? '#fff' : color, life: 0 });
    }
    pops.push({ x: at.x, y: at.y - 40, text: result === 'perfect' ? 'PERFECT!' : 'GOOD', color: result === 'perfect' ? STAR : '#fff', at: performance.now() });
  }
  // Pitch climbs with the combo — satisfying!
  blip(520 + Math.min(sc.combo, 24) * 25, 90, 'triangle', 0.12, 900 + Math.min(sc.combo, 24) * 30);
}

// ---------- main loop ----------

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { w, h } = fitCanvas(canvas, ctx);
  // Menus take taps/clicks; while playing, clicks go through to the video (ad Skip button).
  canvas.style.pointerEvents = stage === 'play' ? 'none' : 'auto';
  ctx.clearRect(0, 0, w, h);
  const mapper = screenMapper(game.frame.aspect, w, h);

  switch (stage) {
    case 'select':
      if (portrait !== innerHeight > innerWidth) buildSelectMenu();
      drawBackdrop(w, h, now / 1000, 120, 0);
      drawHands(game.frame.players, mapper.map, w, h);
      drawText(ctx, 'Beat Bash', w / 2, h * 0.1, Math.min(h / 9, w / 6), STAR);
      drawText(ctx, 'Pick a song — hold your hand on it', w / 2, h * 0.19, Math.min(h / 26, w / 19));
      {
        const pick = selectMenu.update(game.frame.players, now);
        if (pick) onSelect(pick);
        selectMenu.draw(ctx, w, h);
      }
      if (message) drawText(ctx, message, w / 2, h * 0.94, Math.min(h / 32, w / (message.length * 0.55)), '#ffd6a5');
      break;
    case 'loading':
      drawBackdrop(w, h, now / 1000, 120, 0);
      drawText(ctx, song?.title ?? '', w / 2, h * 0.4, h / 12, STAR);
      drawText(ctx, song?.source.type === 'file' && song.bpm === undefined ? 'Finding the beat…' : 'Loading…', w / 2, h * 0.52, h / 20);
      break;
    case 'play':
      playFrame(w, h, mapper);
      break;
    case 'results':
      drawBackdrop(w, h, now / 1000, song?.bpm ?? 120, song?.offset ?? 0);
      drawResults(w, h);
      if (since() > 2.5) {
        const pick = resultsMenu.update(game.frame.players, now);
        if (pick === 'again' && song) void startSong(song);
        if (pick === 'songs') endToSelect();
        if (pick === 'home') game.exit();
        resultsMenu.draw(ctx, w, h);
      }
      break;
    case 'credits':
      drawBackdrop(w, h, now / 1000, 100, 0);
      drawCredits(w, h);
      if (creditsMenu.update(game.frame.players, now) === 'back') go('select');
      creditsMenu.draw(ctx, w, h);
      break;
  }
  updateEffects(dt, h);
  requestAnimationFrame(loop);
}

function endToSelect() {
  music?.destroy();
  music = null;
  videoEl.replaceChildren();
  go('select');
}

function playFrame(w: number, h: number, mapper: ReturnType<typeof screenMapper>) {
  if (!song || !music) return;
  const tSong = music.time();
  const state = music.state;
  const isVideo = song.source.type === 'youtube';
  if (isVideo) {
    // Dim the video a little so targets stand out — but never during an ad break.
    if (state === 'playing') {
      ctx.fillStyle = 'rgba(10, 4, 30, 0.35)';
      ctx.fillRect(0, 0, w, h);
    }
  } else drawBackdrop(w, h, tSong, song.bpm ?? 120, song.offset ?? 0);

  // Let a mouse/remote/tap reach the video while it's stuck (ad Skip button, tap-to-play).
  game.setTouchPassthrough(isVideo && (state === 'waiting' || state === 'blocked') && since() > 1);

  const live = state === 'playing' && !game.paused;
  // Body positions arrive ~latency late, so judge against where the song was then.
  const tBody = tSong - latencyMs / 1000;
  const approach = difficulty === 'easy' ? 1.7 : 1.3;
  const players = game.frame.players;
  const vp = { x: w / 2, y: h * 0.32 }; // where targets fly in from
  peekTargets = [];

  for (const p of players) {
    const sc = ensureScore(p);
    const a = anchors(p);
    const ducking = isDucking(p, sc);
    const k = p.keypoints;
    const lw = { x: k[KP.leftWrist].x, y: k[KP.leftWrist].y };
    const rw = { x: k[KP.rightWrist].x, y: k[KP.rightWrist].y };
    const r = 0.8 * a.S;

    notes.forEach((n, i) => {
      const dtNote = n.t - tBody;
      if (dtNote > approach || dtNote < -0.6) return;
      const res = sc.done.get(i);
      const target = n.kind === 'both' ? a.both : n.kind === 'duck' ? a.head : a[n.lane ?? 'LH'];
      const scr = mapper.map(target);
      const color = n.kind === 'both' ? STAR : n.kind === 'duck' ? DUCK : n.lane?.startsWith('L') ? LEFT : RIGHT;

      // ---- judging ----
      if (live && res === undefined) {
        if (Math.abs(dtNote) <= GOOD) {
          let hit = false;
          if (n.kind === 'duck') hit = ducking;
          else if (n.kind === 'both') hit = dist(lw, a.both) < 1.1 * a.S && dist(rw, a.both) < 1.1 * a.S;
          else {
            const left = n.lane!.startsWith('L');
            const near = (wr: Vec2) => dist(wr, target) < r;
            hit = difficulty === 'easy' ? near(lw) || near(rw) : near(left ? lw : rw);
          }
          if (hit && Math.abs(dtNote) <= PERFECT) judge(sc, i, 'perfect', scr, color);
          else if (hit && dtNote < 0) judge(sc, i, 'good', scr, color); // a bit late
          else if (hit) sc.early.add(i); // there early: wait for the beat, it may become Perfect
          else if (sc.early.has(i) && dtNote <= 0) judge(sc, i, 'good', scr, color); // touched, then left
        } else if (dtNote < -GOOD && sc.early.has(i)) {
          judge(sc, i, 'good', scr, color);
        } else if (dtNote < -GOOD) {
          judge(sc, i, 'miss', null, color);
          pops.push({ x: scr.x, y: scr.y, text: 'miss', color: '#9aa', at: performance.now() });
        }
      }
      if (sc.done.has(i)) return;
      peekTargets.push({ x: Math.round(scr.x), y: Math.round(scr.y), dt: Math.round(dtNote * 1000) / 1000, kind: n.kind });

      // ---- drawing ----
      const prog = Math.max(0, Math.min(1, 1 - dtNote / approach));
      const ease = prog * prog;
      const rad = mapper.len(0.55 * a.S);
      if (n.kind === 'duck') {
        // A bar sweeping in at head height.
        const y = vp.y + (scr.y - vp.y) * ease;
        const half = mapper.len(1.8 * a.S) * (0.3 + 0.7 * ease);
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.65 * prog;
        ctx.fillStyle = DUCK;
        ctx.shadowColor = DUCK;
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.roundRect(scr.x - half, y - rad * 0.25, half * 2, rad * 0.5, rad * 0.25);
        ctx.fill();
        ctx.restore();
        if (prog > 0.5) drawText(ctx, 'DUCK!', scr.x, y - rad, rad * 0.8, DUCK);
        return;
      }
      // Landing ring at the target, shrinking onto it as the beat arrives.
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.6 * prog;
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, rad * (1 + 1.6 * (1 - prog)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.18 + 0.2 * prog;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(scr.x, scr.y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // The orb flying in from the distance.
      const ox = vp.x + (scr.x - vp.x) * ease;
      const oy = vp.y + (scr.y - vp.y) * ease;
      const orb = rad * (0.25 + 0.75 * ease);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 25;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (n.kind === 'both') star(ox, oy, orb * 1.2);
      else ctx.arc(ox, oy, orb, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.restore();
      if (n.kind === 'both' && prog > 0.5) drawText(ctx, 'BOTH HANDS!', scr.x, scr.y - rad * 1.6, rad * 0.6, STAR);
    });

    // Combo over the player's head.
    if (sc.combo >= 3) {
      const hd = mapper.map({ x: a.head.x, y: a.head.y - 2.6 * a.S });
      drawText(ctx, `${sc.combo} combo`, hd.x, hd.y, Math.max(20, mapper.len(0.5 * a.S)), p.color);
    }
  }
  drawHands(players, mapper.map, w, h);
  hud(w, tSong);

  if (state === 'waiting' && since() > 1.5 && isVideo) {
    banner(w, h, 'Ad break or loading — the song will start in a moment', 'A grown-up can press Skip on the video when it appears');
  } else if (state === 'blocked') {
    banner(w, h, 'Tap the video to start the song', 'This browser needs a tap before videos can play');
  }
  if (game.paused) drawPaused(ctx, w, h);
  else if (tSong - (song.start ?? 0) < 2.5 && state === 'playing') drawText(ctx, 'Get ready!', w / 2, h * 0.2, h / 10, STAR);

  if (state === 'ended' || (state === 'playing' && tSong >= songEnd)) finishSong();
}

function finishSong() {
  music?.pause();
  game.setTouchPassthrough(false);
  const best = Math.max(0, ...[...scores.values()].map((s) => stars(s)));
  say(best >= 3 ? 'Amazing!' : best >= 2 ? 'Great dancing!' : 'Nice moves!', { interrupt: true });
  game.reportScores(Object.fromEntries([...scores.values()].map((s) => [s.slot, s.score])));
  go('results');
}

/** 1–3 stars from accuracy (perfect counts full, good 70%). */
function stars(sc: PlayerScore): number {
  const total = notes.length || 1;
  const acc = (sc.perfect + 0.7 * sc.good) / total;
  return acc >= 0.85 ? 3 : acc >= 0.6 ? 2 : acc >= 0.25 ? 1 : 0;
}

// ---------- drawing helpers ----------

function star(x: number, y: number, r: number) {
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/** Disco backdrop for audio songs: a perspective grid that pulses on the beat. */
function drawBackdrop(w: number, h: number, t: number, bpm: number, offset: number) {
  const beat = 60 / bpm;
  const phase = (((t - offset) % beat) + beat) % beat / beat;
  const pulse = Math.exp(-phase * 6);
  const g = ctx.createRadialGradient(w / 2, h * 0.32, 10, w / 2, h * 0.4, h);
  g.addColorStop(0, `rgb(${90 + pulse * 60}, 30, ${150 + pulse * 60})`);
  g.addColorStop(1, '#10002b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${0.08 + pulse * 0.12})`;
  ctx.lineWidth = 2;
  for (let i = -8; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.32);
    ctx.lineTo(w / 2 + i * w * 0.12, h);
    ctx.stroke();
  }
  for (let j = 0; j < 8; j++) {
    const z = ((j + (t / beat) % 1) / 8) ** 2;
    const y = h * 0.32 + (h * 0.68) * z;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Glowing red/blue "sabers" on each player's hands, with short trails. */
function drawHands(players: Player[], map: (p: Vec2) => Vec2, _w: number, h: number) {
  for (const p of players) {
    for (const [i, color] of [
      [KP.leftWrist, LEFT],
      [KP.rightWrist, RIGHT],
    ] as const) {
      if (p.keypoints[i].score < 0.35) continue;
      const s = map(p.keypoints[i]);
      const key = `${p.id}:${i}`;
      const trail = handTrails.get(key) ?? [];
      trail.push(s);
      if (trail.length > 8) trail.shift();
      handTrails.set(key, trail);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = h / 40;
      ctx.beginPath();
      trail.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, h / 45, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, h / 110, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function hud(w: number, t: number) {
  if (!song) return;
  const from = song.start ?? 0;
  const frac = Math.max(0, Math.min(1, (t - from) / Math.max(1, songEnd - from)));
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(0, 0, w, 10);
  ctx.fillStyle = STAR;
  ctx.fillRect(0, 0, w * frac, 10);
  drawText(ctx, song.title, w / 2, 36, 24, '#fff');
  [...scores.values()]
    .sort((a, b) => a.slot - b.slot)
    .forEach((sc, i) => {
      const x = 20 + i * 170;
      ctx.fillStyle = sc.color;
      ctx.beginPath();
      ctx.roundRect(x, 56, 150, 54, 16);
      ctx.fill();
      drawText(ctx, String(sc.score), x + 75, 84, 30);
    });
}

function banner(w: number, h: number, title: string, sub: string) {
  ctx.fillStyle = 'rgba(10,4,30,0.75)';
  ctx.fillRect(0, h * 0.82, w, h * 0.18);
  drawText(ctx, title, w / 2, h * 0.88, h / 24, STAR);
  drawText(ctx, sub, w / 2, h * 0.95, h / 36);
}

function drawResults(w: number, h: number) {
  drawText(ctx, song?.title ?? '', w / 2, h * 0.1, h / 14, STAR);
  const list = [...scores.values()].sort((a, b) => a.slot - b.slot);
  list.forEach((sc, i) => {
    const x = (w * (i + 1)) / (list.length + 1);
    const st = stars(sc);
    drawText(ctx, playerName(sc.slot), x, h * 0.24, h / 18, sc.color);
    drawText(ctx, '★'.repeat(st) + '☆'.repeat(3 - st), x, h * 0.36, h / 10, STAR);
    drawText(ctx, String(sc.score), x, h * 0.5, h / 10);
    drawText(ctx, `${sc.perfect} perfect · ${sc.good} good`, x, h * 0.6, h / 30);
    drawText(ctx, `best combo ${sc.maxCombo}`, x, h * 0.66, h / 30);
  });
  if (!list.length) drawText(ctx, 'Nobody played!', w / 2, h * 0.4, h / 12);
  if (song?.credit) drawText(ctx, song.credit, w / 2, h * 0.96, Math.min(h / 40, (w * 0.95) / (song.credit.length * 0.56)), '#ccc', { stroke: false, weight: 600 });
}

function drawCredits(w: number, h: number) {
  drawText(ctx, 'Music credits', w / 2, h * 0.1, h / 12, STAR);
  const lines = songs.filter((s) => s.credit).map((s) => s.credit!);
  lines.push('YouTube songs play from YouTube with their own credits.');
  lines.forEach((l, i) =>
    drawText(ctx, l, w / 2, h * 0.22 + i * h * 0.075, Math.min(h / 34, (w * 0.95) / (l.length * 0.56)), '#fff', { stroke: false, weight: 600 }),
  );
}

function updateEffects(dt: number, h: number) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.life += dt;
    if (b.life > 0.6) {
      bursts.splice(i, 1);
      continue;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vy += 600 * dt;
    ctx.globalAlpha = 1 - b.life / 0.6;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const now = performance.now();
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    const age = (now - p.at) / 700;
    if (age > 1) {
      pops.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = 1 - age;
    drawText(ctx, p.text, p.x, p.y - age * 50, h / 22, p.color);
    ctx.globalAlpha = 1;
  }
}

// Read-only peek for automated tests and debugging.
(window as unknown as { beats: () => object }).beats = () => ({
  stage,
  song: song?.id ?? null,
  bpm: song?.bpm ?? null,
  notes: notes.length,
  musicState: music?.state ?? null,
  time: music?.time() ?? null,
  songs: songs.map((s) => ({ id: s.id, needsSetup: needsSetup(s) })),
  scores: [...scores.values()].map((s) => ({ slot: s.slot, score: s.score, perfect: s.perfect, good: s.good, miss: s.miss })),
  message,
  targets: peekTargets,
  cursors: game.frame.players.map((p) => handCursor(p)),
});

await refreshSongs();
requestAnimationFrame(loop);
