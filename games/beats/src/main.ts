/**
 * Beat Bash — a Beat Saber-style rhythm game simplified for kids.
 *
 * Targets launch from the top of the screen and sweep down to land around each
 * player's own body, in that player's colour: inside their own part of the screen
 * (so they never land on a neighbour) and within reach of their own arms (so short
 * and tall players reach them equally). Touch a target with your hand as it lands
 * (Normal: L = left hand, R = right; Easy: any hand), star = both hands up,
 * bar = duck. No failing — combos, sparkles and stars.
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
  drawSkeleton,
  fitCanvas,
  handCursor,
  loadAssets,
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
// Gemini-painted art (see art/generate.py): a disco stage, the disco ball notes launch from, speakers, stars.
const assets = await loadAssets({
  images: {
    background: 'art/background.jpg',
    discoball: 'art/discoball.png',
    speaker: 'art/speaker.png',
    star: 'art/star.png',
  },
});

/** Hit window (s) either side of the beat, and the tighter "Perfect" window. */
const GOOD = 0.24;
const PERFECT = 0.1;
const STAR = '#ffbe0b';
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
    { id: 'difficulty', label: difficulty === 'easy' ? 'Easy (any hand)' : 'Normal (L and R hands)', x: 0.17, y: rowY, w: 0.27, h: 0.1, color: '#2a9d8f' },
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
    if (top !== window) {
      // In the launcher: "back" reopens Beat Bash (its song list); "home" is the launcher menu.
      const home = new URL(top.location.href);
      home.searchParams.delete('game');
      const songs = new URL(home);
      songs.searchParams.set('game', 'beats');
      url.searchParams.set('back', songs.href);
      url.searchParams.set('home', home.href);
    }
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

/** Each player's own strip of the screen (camera x), split halfway between neighbours. */
function zones(players: Player[]): Map<number, [number, number]> {
  const mid = (p: Player) => (p.keypoints[KP.leftShoulder].x + p.keypoints[KP.rightShoulder].x) / 2;
  const sorted = [...players].sort((a, b) => mid(a) - mid(b));
  const out = new Map<number, [number, number]>();
  sorted.forEach((p, i) => {
    const left = i ? (mid(sorted[i - 1]) + mid(p)) / 2 : 0;
    const right = i < sorted.length - 1 ? (mid(p) + mid(sorted[i + 1])) / 2 : 1;
    out.set(p.id, [left, right]);
  });
  return out;
}

/**
 * Where this player's targets land. Laid out around their shoulders, then kept inside their
 * zone (so they don't land on a neighbour) and within comfortable reach of the matching
 * shoulder (so every target can actually be touched). Distances are measured with x
 * scaled by the camera aspect, so "reach" is the same in every direction.
 */
function anchors(p: Player, zone: [number, number], aspect: number) {
  const k = p.keypoints;
  const S = Math.max(p.shoulderWidth, 0.03);
  const ls = k[KP.leftShoulder];
  const rs = k[KP.rightShoulder];
  const d = (a: Vec2, b: Vec2) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const Sc = Math.max(d(ls, rs), 0.03);
  const m = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };

  // Arm length from the tracker (longest seen, kept relative to the torso so it stays right
  // as they step nearer or further; same units as d()), kept sensible for their shoulders.
  const arm = Math.min(2.4 * Sc, Math.max(1.2 * Sc, p.armLength || 1.6 * Sc));

  // Offsets in units of Sc (x converted back to camera fractions).
  const at = (ox: number, oy: number): Vec2 => ({ x: m.x + (ox * Sc) / aspect, y: m.y + oy * Sc });
  const margin = (0.6 * Sc) / aspect;
  const inZone = (q: Vec2): Vec2 => {
    const lo = zone[0] + margin;
    const hi = zone[1] - margin;
    return { x: lo < hi ? Math.min(hi, Math.max(lo, q.x)) : (zone[0] + zone[1]) / 2, y: q.y };
  };
  /** Pull q to within `r` of `from`. */
  const within = (q: Vec2, from: Vec2, r: number): Vec2 => {
    const dist = d(q, from);
    if (dist <= r) return q;
    const f = r / dist;
    return { x: from.x + (q.x - from.x) * f, y: from.y + (q.y - from.y) * f };
  };
  // Left-hand targets are on the screen's left (the picture is mirrored).
  const reach = 0.85 * arm;
  const hand = (ox: number, oy: number, sh: Vec2) => within(inZone(at(ox, oy)), sh, reach);
  // Both hands at once: each hand must reach it from its own shoulder.
  const bothReach = Math.sqrt(Math.max(0, (0.9 * arm) ** 2 - (Sc / 2) ** 2));
  return {
    S,
    LH: hand(-1.3, -1.0, ls),
    LL: hand(-1.5, 0.7, ls),
    RH: hand(1.3, -1.0, rs),
    RL: hand(1.5, 0.7, rs),
    both: within(inZone(at(0, -1.8)), m, bothReach),
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
  // A half squat is enough to get under the bar (or bobbing the head down, measured above).
  return p.pose.crouching || (p.pose.crouchDepth ?? 0) >= 0.35 || drop > 0.3;
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
      game.drawPeople(ctx, w, h); // the players themselves, behind the song list
      if (!game.peopleVisible) for (const p of game.frame.players) drawBody(p, mapper, 0.6);
      drawHands(game.frame.players, mapper.map, w, h);
      drawTitleStars(w, h, now / 1000, Math.min(h / 9, w / 6));
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
      drawSpeakers(w, h, now / 1000, song?.bpm ?? 120, song?.offset ?? 0);
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
      ctx.fillStyle = 'rgba(10, 2, 30, 0.55)'; // scrim so the small credit lines read over the stage
      ctx.fillRect(0, 0, w, h);
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
  drawDiscoBall(w, h, tSong, song.bpm ?? 120, song.offset ?? 0);

  // Let a mouse/remote/tap reach the video while it's stuck (ad Skip button, tap-to-play).
  game.setTouchPassthrough(isVideo && (state === 'waiting' || state === 'blocked') && since() > 1);

  const live = state === 'playing' && !game.paused;
  // Body positions arrive ~latency late, so judge against where the song was then.
  const tBody = tSong - latencyMs / 1000;
  const approach = difficulty === 'easy' ? 1.7 : 1.3;
  const players = game.frame.players;
  const launch = { x: w / 2, y: h * 0.07 }; // targets launch from the top middle and sweep to each player
  const zoneOf = zones(players);
  peekTargets = [];

  // The players themselves behind the targets (their hands are the sabers, drawn on top).
  // Without the camera cut-outs (G off, simulator), see-through body outlines instead.
  game.drawPeople(ctx, w, h);
  if (!game.peopleVisible) for (const p of players) drawBody(p, mapper);

  for (const p of players) {
    const sc = ensureScore(p);
    const a = anchors(p, zoneOf.get(p.id) ?? [0, 1], game.frame.aspect);
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
      const color = p.color;

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
      const ease = prog * (2 - prog); // quick out of the launch, settling onto the target
      const rad = mapper.len(0.55 * a.S);
      // The path: out sideways from the top middle first, then down onto the target.
      const ctrl = { x: scr.x, y: launch.y + (scr.y - launch.y) * 0.15 };
      const along = (t: number) => ({
        x: (1 - t) ** 2 * launch.x + 2 * (1 - t) * t * ctrl.x + t * t * scr.x,
        y: (1 - t) ** 2 * launch.y + 2 * (1 - t) * t * ctrl.y + t * t * scr.y,
      });
      if (n.kind === 'duck') {
        // A bar sweeping down to head height.
        const pos = along(ease);
        const half = mapper.len(1.8 * a.S) * (0.3 + 0.7 * ease);
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.65 * prog;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.roundRect(pos.x - half, pos.y - rad * 0.25, half * 2, rad * 0.5, rad * 0.25);
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha *= 0.45;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.roundRect(pos.x - half + rad * 0.2, pos.y - rad * 0.17, half * 2 - rad * 0.4, rad * 0.12, rad * 0.06);
        ctx.fill();
        ctx.restore();
        if (prog > 0.5) drawText(ctx, 'DUCK!', pos.x, pos.y - rad, rad * 0.8, color);
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
      // The orb sweeping in, with a short comet tail along its path.
      const { x: ox, y: oy } = along(ease);
      const orb = rad * (0.3 + 0.7 * ease);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      for (let j = 1; j <= 4; j++) {
        const q = along(Math.max(0, ease - j * 0.035));
        ctx.globalAlpha = 0.25 * (1 - j / 5) * prog;
        ctx.lineWidth = orb * (1.2 - j * 0.2);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      ctx.restore();
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
      if (n.kind === 'both') gloss(ox + orb * 0.2, oy + orb * 0.25, orb * 0.6);
      else gloss(ox, oy, orb);
      // Which hand, when it matters.
      if (n.kind === 'hit' && difficulty !== 'easy') drawText(ctx, n.lane!.startsWith('L') ? 'L' : 'R', ox, oy, orb * 1.1, '#fff', { stroke: color });
      if (n.kind === 'both' && prog > 0.5) drawText(ctx, 'BOTH HANDS!', scr.x, scr.y - rad * 1.6, rad * 0.6, color);
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

/** 0..1, peaking on each beat and fading before the next. */
function beatPulse(t: number, bpm: number, offset: number) {
  const beat = 60 / bpm;
  const phase = (((t - offset) % beat) + beat) % beat / beat;
  return Math.exp(-phase * 6);
}

/**
 * Backdrop for audio songs (and the menus): the painted disco stage, darkened so the
 * coloured notes and outlines stand out, with a glow and a dance-floor grid that pulse on the beat.
 */
function drawBackdrop(w: number, h: number, t: number, bpm: number, offset: number) {
  const beat = 60 / bpm;
  const pulse = beatPulse(t, bpm, offset);
  const img = assets.images.background;
  const k = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, (w - img.width * k) / 2, (h - img.height * k) / 2, img.width * k, img.height * k);
  ctx.fillStyle = 'rgba(12, 2, 32, 0.5)';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  // The beat: a purple glow from the top middle, brightest on the beat.
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(w / 2, h * 0.32, 10, w / 2, h * 0.4, h);
  g.addColorStop(0, `rgba(150, 50, 210, ${0.08 + pulse * 0.32})`);
  g.addColorStop(1, 'rgba(150, 50, 210, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  // The moving grid, on the dance floor only.
  ctx.beginPath();
  ctx.rect(0, h * 0.62, w, h * 0.38);
  ctx.clip();
  ctx.strokeStyle = `rgba(255,255,255,${0.06 + pulse * 0.14})`;
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

/** The disco ball at the top middle that the notes launch from, twinkling on the beat. */
function drawDiscoBall(w: number, h: number, t: number, bpm: number, offset: number) {
  const pulse = beatPulse(t, bpm, offset);
  const s = h * 0.14;
  const cx = w / 2;
  const cy = h * 0.07;
  ctx.save();
  ctx.strokeStyle = 'rgba(220,220,240,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, cy - s / 2);
  ctx.stroke();
  ctx.shadowColor = `rgba(255, 220, 255, ${0.4 + 0.6 * pulse})`;
  ctx.shadowBlur = 10 + 30 * pulse;
  ctx.translate(cx, cy);
  ctx.rotate(Math.sin(t * 0.8) * 0.08);
  ctx.drawImage(assets.images.discoball, -s / 2, -s / 2, s, s);
  ctx.restore();
}

/** Speakers either side of the results, bouncing to the beat. */
function drawSpeakers(w: number, h: number, t: number, bpm: number, offset: number) {
  const pulse = beatPulse(t, bpm, offset);
  const s = Math.min(h * 0.34, w * 0.14) * (1 + 0.05 * pulse);
  for (const x of [w * 0.075, w * 0.925]) {
    ctx.drawImage(assets.images.speaker, x - s / 2, h * 0.5 - s / 2, s, s);
  }
}

/** Two gold stars bobbing either side of the title. */
function drawTitleStars(w: number, h: number, t: number, size: number) {
  const half = size * 3.3;
  for (const [i, x] of [w / 2 - half, w / 2 + half].entries()) {
    const s = size * 1.1;
    ctx.save();
    ctx.translate(x, h * 0.1 + Math.sin(t * 3 + i * Math.PI) * size * 0.08);
    ctx.rotate((i ? 1 : -1) * 0.15 + Math.sin(t * 2 + i) * 0.08);
    ctx.drawImage(assets.images.star, -s / 2, -s / 2, s, s);
    ctx.restore();
  }
}

/** A glossy highlight on a note, over its exact player colour. */
function gloss(x: number, y: number, r: number) {
  ctx.save();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x - r * 0.35, y - r * 0.4, r * 0.55);
  g.addColorStop(0, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A see-through outline of a player's body (white edge for contrast on busy videos). */
function drawBody(p: Player, mapper: ReturnType<typeof screenMapper>, alpha = 1) {
  const lw = Math.max(8, mapper.len(Math.max(p.shoulderWidth, 0.03)) * 0.2);
  drawSkeleton(ctx, { ...p, color: '#ffffff' }, mapper.map, { lineWidth: lw + 8, alpha: 0.22 * alpha, minScore: 0.35 });
  drawSkeleton(ctx, p, mapper.map, { lineWidth: lw, alpha: 0.5 * alpha, minScore: 0.35 });
}

/** Glowing "sabers" on each player's hands in their colour, with short trails (L / R in Normal). */
function drawHands(players: Player[], map: (p: Vec2) => Vec2, _w: number, h: number) {
  for (const p of players) {
    const color = p.color;
    for (const [i, label] of [
      [KP.leftWrist, 'L'],
      [KP.rightWrist, 'R'],
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
      if (difficulty !== 'easy' && stage === 'play') drawText(ctx, label, s.x, s.y - h / 30, h / 36, '#fff', { stroke: color });
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
    const sz = h / 9;
    for (let j = 0; j < 3; j++) {
      ctx.save();
      if (j >= st) {
        ctx.globalAlpha = 0.3;
        ctx.filter = 'grayscale(1)';
      }
      ctx.drawImage(assets.images.star, x + (j - 1) * sz * 1.05 - sz / 2, h * 0.36 - sz / 2, sz, sz);
      ctx.restore();
    }
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
