/**
 * Freeze Dance — dance while the music plays; when it stops, FREEZE!
 *
 * Everyone scores: points for dancing hard while the music plays, and a big
 * bonus for each perfect statue. Wobble during a freeze and you miss the bonus
 * (nobody is knocked out — little ones keep playing). 8 freezes per game.
 *
 * Movement is measured per player as average keypoint speed in shoulder-widths
 * per second, so near and far players are judged the same.
 */
import {
  KP,
  RoundFlow,
  blip,
  createGame,
  drawText,
  fitCanvas,
  noise,
  playMusic,
  prepareSpeech,
  say,
  screenMapper,
  type MusicHandle,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

const FREEZES = 8;
/** Grace after "Freeze!" before wobbles count (reaction time). */
const GRACE = 0.8;
/** How long statues are judged. */
const HOLD = 2.6;
/** Smoothed movement above this (shoulder-widths/s) is a wobble… */
const WOBBLE_SPEED = 0.75;
/** …if it lasts at least this long in total during the hold. */
const WOBBLE_TIME = 0.25;
const STATUE_POINTS = 50;

const TRACKS = [
  'music/monkeys-spinning-monkeys.mp3',
  'music/fluffing-a-duck.mp3',
  'music/hyperfun.mp3',
  'music/pixel-peeker-polka-faster.mp3',
];
const CREDIT = 'Music: Kevin MacLeod (incompetech.com) · CC BY 4.0';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// Dancing with arms up is normal here, so don't let "hands up 3 s" mean "go home".
const game = await createGame({ exitGesture: false });
const flow = new RoundFlow(game, { title: 'Freeze Dance', seconds: 0, subtitle: 'Raise both hands to start!' });
prepareSpeech(['Dance!', 'Freeze!', 'Great statues!', 'Wobbly!', 'Keep dancing!', 'Amazing dancing!']);

// ---------- music ----------

let tracks: string[] = [];
void Promise.all(
  TRACKS.map(async (t) => {
    try {
      return (await fetch(t, { method: 'HEAD' })).ok ? t : null;
    } catch {
      return null;
    }
  }),
).then((ok) => (tracks = ok.filter((t): t is string => !!t)));

let track: string | null = null;
let musicHandle: MusicHandle | null = null;
let musicFrom = 0;
let musicStartedAt: number | null = null;
let musicOn = false;

function musicPos(): number {
  return musicStartedAt === null ? musicFrom : musicFrom + (performance.now() - musicStartedAt) / 1000;
}
function startMusic() {
  if (musicOn) return;
  musicOn = true;
  if (!track) return; // fallback beat is drawn from the game loop
  const h = playMusic(track, { offset: musicFrom, volume: 0.9 });
  musicHandle = h;
  musicStartedAt = null;
  void h.started.then((t) => {
    if (musicHandle === h) musicStartedAt = t;
  });
}
function stopMusic() {
  if (!musicOn) return;
  musicOn = false;
  musicFrom = musicPos();
  musicStartedAt = null;
  musicHandle?.stop();
  musicHandle = null;
}

/** No music files? A simple built-in boom-tss beat keeps the game playable. */
let nextBeat = 0;
let beatN = 0;
function fallbackBeat(now: number) {
  if (track || !musicOn || now < nextBeat) return;
  nextBeat = now + 250;
  if (beatN % 2 === 0) blip(beatN % 4 === 0 ? 70 : 90, 140, 'sine', 0.5, 40);
  else noise(50, 0.12);
  if (beatN % 8 === 4) blip(523 + 131 * ((beatN / 8) % 3), 120, 'triangle', 0.12);
  beatN++;
}

// ---------- per-player movement ----------

const BODY = [
  KP.nose,
  KP.leftShoulder,
  KP.rightShoulder,
  KP.leftElbow,
  KP.rightElbow,
  KP.leftWrist,
  KP.rightWrist,
  KP.leftHip,
  KP.rightHip,
  KP.leftKnee,
  KP.rightKnee,
];
interface Mover {
  motion: number;
  lastT: number;
  /** Dance points not yet added to the score (fractions). */
  carry: number;
  wobbleTime: number;
  result: 'statue' | 'wobble' | null;
  frozenPose: Vec2[] | null;
}
const movers = new Map<number, Mover>();
const mover = (p: Player): Mover => {
  let m = movers.get(p.id);
  if (!m) movers.set(p.id, (m = { motion: 0, lastT: 0, carry: 0, wobbleTime: 0, result: null, frozenPose: null }));
  return m;
};

game.onFrame((f) => {
  for (const p of f.players) {
    const m = mover(p);
    const dt = m.lastT ? Math.min((f.t - m.lastT) / 1000, 0.1) : 0;
    m.lastT = f.t;
    const sw = Math.max(p.shoulderWidth, 0.03);
    let sum = 0;
    let n = 0;
    for (const i of BODY) {
      const k = p.keypoints[i];
      if (k.score < 0.4) continue;
      sum += Math.hypot(k.vx, k.vy) / sw;
      n++;
    }
    const e = n ? sum / n : 0;
    m.motion += (e - m.motion) * (1 - Math.exp(-dt / 0.12));
  }
});

// ---------- game phases ----------

type Phase = 'dance' | 'freeze' | 'show';
let phase: Phase = 'dance';
let phaseT = 0; // seconds into phase (play time only)
let phaseLen = 6;
let freezesDone = 0;
let banner = { text: '', color: '#fff', t: 0 };

function setPhase(p: Phase, len: number) {
  phase = p;
  phaseT = 0;
  phaseLen = len;
}

flow.on('start', () => {
  freezesDone = 0;
  movers.clear();
  track = tracks.length ? tracks[Math.floor(Math.random() * tracks.length)] : null;
  musicFrom = 0;
  setPhase('dance', 6);
  startMusic();
  showBanner('DANCE!', '#ffbe0b');
  void say('Dance!', { interrupt: true });
});
flow.on('end', () => {
  stopMusic();
  void say('Amazing dancing!', { interrupt: true });
});
game.on('pause', () => stopMusic());
game.on('resume', () => {
  if (flow.state === 'playing' && phase === 'dance') startMusic();
});

function showBanner(text: string, color: string) {
  banner = { text, color, t: performance.now() };
}

function step(dt: number, players: Player[]) {
  phaseT += dt;
  if (phase === 'dance') {
    for (const p of players) {
      const m = mover(p);
      // Up to ~20 points a second for really going for it.
      m.carry += Math.min(m.motion, 3) * 7 * dt;
      if (m.carry >= 1) {
        const whole = Math.floor(m.carry);
        flow.addScore(p.slot, whole);
        m.carry -= whole;
      }
    }
    if (phaseT >= phaseLen) {
      stopMusic();
      setPhase('freeze', GRACE + HOLD);
      for (const p of players) {
        const m = mover(p);
        m.wobbleTime = 0;
        m.result = null;
        m.frozenPose = null;
      }
      showBanner('FREEZE!', '#4cc9f0');
      blip(880, 300, 'square', 0.15, 220);
      void say('Freeze!', { interrupt: true });
    }
  } else if (phase === 'freeze') {
    for (const p of players) {
      const m = mover(p);
      if (phaseT < GRACE) continue;
      m.frozenPose ??= p.keypoints.map((k) => ({ x: k.x, y: k.y }));
      if (m.motion > WOBBLE_SPEED) m.wobbleTime += dt;
      if (!m.result && m.wobbleTime >= WOBBLE_TIME) {
        m.result = 'wobble';
        noise(250, 0.25);
        blip(200, 300, 'sawtooth', 0.1, 90);
      }
    }
    if (phaseT >= phaseLen) {
      let statues = 0;
      for (const p of players) {
        const m = mover(p);
        if (!m.result) {
          m.result = 'statue';
          flow.addScore(p.slot, STATUE_POINTS);
          statues++;
        }
      }
      const wobbles = players.length - statues;
      if (players.length && statues === players.length) void say('Great statues!');
      else if (wobbles && !statues) void say('Wobbly!');
      if (statues) blip(1046, 200, 'triangle', 0.15, 1568);
      freezesDone++;
      setPhase('show', 1.6);
    }
  } else if (phase === 'show') {
    if (phaseT >= phaseLen) {
      if (freezesDone >= FREEZES) {
        flow.end();
        return;
      }
      for (const m of movers.values()) {
        m.result = null;
        m.frozenPose = null;
      }
      // Later rounds: shorter, less predictable dances.
      const len = Math.max(3, 8 - freezesDone * 0.5) * (0.6 + Math.random() * 0.6);
      setPhase('dance', len);
      startMusic();
      showBanner(freezesDone === FREEZES - 1 ? 'LAST ONE!' : 'DANCE!', '#ffbe0b');
      void say(freezesDone === FREEZES - 1 ? 'Keep dancing!' : 'Dance!', { interrupt: true });
    }
  }
}

// ---------- drawing ----------

let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);

function background(t: number) {
  const dancing = flow.state !== 'playing' || phase === 'dance';
  const beat = dancing ? Math.exp(-((t * 2) % 1) * 4) : 0;
  ctx.fillStyle = dancing ? '#14002a' : '#06142e';
  ctx.fillRect(0, 0, W, H);
  // Disco floor: a perspective grid of glowing tiles.
  const horizon = H * 0.45;
  const cols = 10;
  const rows = 7;
  for (let r = 0; r < rows; r++) {
    const z0 = r / rows;
    const z1 = (r + 1) / rows;
    const y0 = horizon + (H - horizon) * z0 * z0;
    const y1 = horizon + (H - horizon) * z1 * z1;
    for (let c = 0; c < cols; c++) {
      const on = dancing && (c + r + Math.floor(t * 2)) % 3 === 0;
      const hue = (c * 36 + r * 50 + t * 40) % 360;
      // Width grows linearly with screen height → straight floor edges.
      const w0 = W * (0.3 + 0.9 * ((y0 - horizon) / (H - horizon)));
      const w1 = W * (0.3 + 0.9 * ((y1 - horizon) / (H - horizon)));
      const x00 = W / 2 - w0 / 2 + (w0 / cols) * c;
      const x01 = x00 + w0 / cols;
      const x10 = W / 2 - w1 / 2 + (w1 / cols) * c;
      const x11 = x10 + w1 / cols;
      ctx.fillStyle = dancing
        ? `hsla(${hue}, 90%, ${on ? 55 + beat * 10 : 22}%, ${on ? 0.85 : 0.5})`
        : `rgba(160, 220, 255, ${0.08 + 0.05 * ((c + r) % 2)})`;
      ctx.beginPath();
      ctx.moveTo(x00 + 2, y0);
      ctx.lineTo(x01 - 2, y0);
      ctx.lineTo(x11 - 2, y1);
      ctx.lineTo(x10 + 2, y1);
      ctx.fill();
    }
  }
  // Spotlights sweep while dancing; frost creeps in while frozen.
  if (dancing) {
    for (let i = 0; i < 3; i++) {
      const a = Math.sin(t * 0.9 + i * 2.1) * 0.5;
      const x = W * (0.2 + 0.3 * i);
      ctx.save();
      ctx.translate(x, -20);
      ctx.rotate(a);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `hsla(${(i * 120 + t * 60) % 360}, 100%, 70%, 0.35)`);
      g.addColorStop(1, 'hsla(0, 0%, 100%, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-20, 0);
      ctx.lineTo(20, 0);
      ctx.lineTo(W * 0.18, H * 1.1);
      ctx.lineTo(-W * 0.18, H * 1.1);
      ctx.fill();
      ctx.restore();
    }
    // Disco ball
    ctx.save();
    ctx.fillStyle = '#ddd';
    ctx.beginPath();
    ctx.arc(W / 2, H * 0.08, H * 0.05 * (1 + beat * 0.08), 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = `hsl(${(i * 30 + t * 120) % 360}, 90%, 75%)`;
      const a = i * 0.52 + t;
      ctx.fillRect(W / 2 + Math.cos(a) * H * 0.03 - 3, H * 0.08 + Math.sin(a * 1.3) * H * 0.03 - 3, 6, 6);
    }
    ctx.restore();
  } else {
    const frost = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H);
    frost.addColorStop(0, 'rgba(180,230,255,0)');
    frost.addColorStop(1, 'rgba(200,240,255,0.45)');
    ctx.fillStyle = frost;
    ctx.fillRect(0, 0, W, H);
  }
}

const LIMBS: [number, number][] = [
  [KP.leftShoulder, KP.rightShoulder],
  [KP.leftShoulder, KP.leftElbow],
  [KP.leftElbow, KP.leftWrist],
  [KP.rightShoulder, KP.rightElbow],
  [KP.rightElbow, KP.rightWrist],
  [KP.leftShoulder, KP.leftHip],
  [KP.rightShoulder, KP.rightHip],
  [KP.leftHip, KP.rightHip],
  [KP.leftHip, KP.leftKnee],
  [KP.leftKnee, KP.leftAnkle],
  [KP.rightHip, KP.rightKnee],
  [KP.rightKnee, KP.rightAnkle],
];

function dancer(p: Player, t: number) {
  const m = mover(p);
  const k = p.keypoints;
  const sw = mapper.len(Math.max(p.shoulderWidth, 0.03));
  const frozen = flow.state === 'playing' && phase !== 'dance';
  const icy = frozen && m.result !== 'wobble' && (phase === 'show' || phaseT > GRACE);
  const wobble = m.result === 'wobble';
  const jiggle = wobble ? Math.sin(t * 40) * sw * 0.06 : 0;
  const pt = (i: number) => {
    const s = mapper.map(k[i]);
    return { x: s.x + jiggle, y: s.y };
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Glow outline then body.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? (icy ? '#bde9ff' : p.color) : icy ? '#ffffff' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = sw * (pass ? 0.22 : 0.32);
    if (!pass) {
      ctx.shadowColor = icy ? '#9be7ff' : p.color;
      ctx.shadowBlur = 25;
    } else ctx.shadowBlur = 0;
    for (const [a, b] of LIMBS) {
      if (k[a].score < 0.3 || k[b].score < 0.3) continue;
      const pa = pt(a);
      const pb = pt(b);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    if (k[KP.nose].score > 0.3) {
      const n = pt(KP.nose);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(n.x, n.y, sw * (pass ? 0.3 : 0.36), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Face
  if (k[KP.nose].score > 0.3) {
    const n = pt(KP.nose);
    ctx.fillStyle = '#1b1030';
    const e = sw * 0.07;
    ctx.beginPath();
    ctx.arc(n.x - sw * 0.1, n.y - sw * 0.05, e, 0, Math.PI * 2);
    ctx.arc(n.x + sw * 0.1, n.y - sw * 0.05, e, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1b1030';
    ctx.lineWidth = Math.max(2, sw * 0.04);
    ctx.beginPath();
    if (wobble) ctx.arc(n.x, n.y + sw * 0.16, sw * 0.08, Math.PI * 1.15, Math.PI * 1.85);
    else ctx.arc(n.x, n.y + sw * 0.05, sw * 0.1, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }
  // Ice sparkles on statues.
  if (icy) {
    for (let i = 0; i < 6; i++) {
      const j = LIMBS[(i * 5 + Math.floor(t * 3)) % LIMBS.length];
      if (k[j[0]].score < 0.3) continue;
      const s = pt(j[0]);
      const r = sw * 0.12 * (0.5 + 0.5 * Math.sin(t * 6 + i));
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y);
      ctx.lineTo(s.x + r, s.y);
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y + r);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Labels above the head.
  if (flow.state === 'playing' && k[KP.nose].score > 0.3) {
    const n = mapper.map(k[KP.nose]);
    const size = Math.min(Math.max(22, sw * 0.4), H / 14);
    const y = Math.max(size + 70, n.y - sw * 1.0); // keep on screen (below the score chips)
    if (m.result === 'wobble') drawText(ctx, 'WOBBLE!', n.x, y, size, '#ff4d6d');
    else if (m.result === 'statue') drawText(ctx, `STATUE! +${STATUE_POINTS}`, n.x, y, size, '#9be7ff');
    else if (phase === 'dance') {
      // Dance meter: how hard you're going.
      const f = Math.min(1, m.motion / 2.5);
      const bw = sw * 1.4;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(n.x - bw / 2, y, bw, 12);
      ctx.fillStyle = f > 0.6 ? '#ffbe0b' : p.color;
      ctx.fillRect(n.x - bw / 2, y, bw * f, 12);
    }
  }
}

let last = performance.now();
function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ({ w: W, h: H } = fitCanvas(canvas, ctx));
  mapper = screenMapper(game.frame.aspect, W, H);
  const players = game.frame.players;
  flow.update(now);
  if (flow.playing) step(dt, players);
  fallbackBeat(now);

  const t = now / 1000;
  background(t);
  for (const p of players) dancer(p, t);

  // Big banner ("DANCE!" / "FREEZE!")
  const age = (now - banner.t) / 1000;
  if (flow.state === 'playing' && age < 1.4 && banner.text) {
    const s = 1 + Math.max(0, 0.3 - age) * 1.5;
    ctx.globalAlpha = Math.min(1, (1.4 - age) * 3);
    drawText(ctx, banner.text, W / 2, H * 0.3, Math.min(H / 5, W / 5) * s, banner.color);
    ctx.globalAlpha = 1;
  }
  if (flow.state === 'playing') {
    drawText(ctx, `Freeze ${Math.min(freezesDone + 1, FREEZES)} of ${FREEZES}`, W - 20, 50, 28, '#fff', { align: 'right' });
  }
  flow.drawOverlay(ctx, W, H);
  if (flow.state === 'lobby') {
    drawText(ctx, 'Dance when the music plays — freeze like a statue when it stops!', W / 2, H * 0.53, Math.min(H / 26, W / 40));
    if (tracks.length) drawText(ctx, CREDIT, W / 2, H * 0.95, Math.min(H / 40, W / 60), '#ccc', { stroke: false, weight: 600 });
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Read-only peek for automated tests.
(window as unknown as { freeze: () => object }).freeze = () => ({
  state: flow.state,
  phase,
  phaseT,
  freezesDone,
  track,
  musicOn,
  scores: flow.scores,
  movers: [...movers.values()].map((m) => ({ motion: +m.motion.toFixed(2), result: m.result })),
});
