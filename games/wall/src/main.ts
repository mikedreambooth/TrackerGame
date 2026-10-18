/**
 * Wall Squeeze — a wall rushes towards you with a body-shaped hole in it. Make
 * the same shape before it arrives to squeeze through!
 *
 * Each player gets their own hole, cut where they stand and sized to their
 * body. A pose is a set of limb directions (angles on screen), so matching is
 * independent of height and distance. Kid-friendly tolerances.
 */
import {
  KP,
  RoundFlow,
  blip,
  createGame,
  drawText,
  fitCanvas,
  noise,
  prepareSpeech,
  say,
  screenMapper,
  type Player,
  type Vec2,
} from '@trackergame/sdk';

const WALLS = 10;
/** Degrees: how far each limb may be from the target. */
const TOL_UPPER = 40;
const TOL_FORE = 50;
const TOL_LEG = 30;

/**
 * Limb directions in degrees on screen: 0 = right, 90 = down, 180 = left,
 * -90 = up. "L" is the arm on the left of the screen (the player's left — the
 * view is mirrored). Forearms default to the upper arm's direction; legs are
 * only checked when given.
 */
interface PoseDef {
  name: string;
  say: string;
  LU: number;
  LF?: number;
  RU: number;
  RF?: number;
  LT?: number;
  RT?: number;
  crouch?: boolean;
}
const POSES: PoseDef[] = [
  { name: 'Star', say: 'Make a star!', LU: -140, RU: -40, LT: 112, RT: 68 },
  { name: 'Aeroplane', say: 'Aeroplane!', LU: 180, RU: 0 },
  { name: 'Hooray', say: 'Hooray!', LU: -118, RU: -62 },
  { name: 'Muscles', say: 'Show your muscles!', LU: 180, LF: -90, RU: 0, RF: -90 },
  { name: 'Hello', say: 'Wave hello!', LU: 100, RU: 0, RF: -90 },
  { name: 'Disco', say: 'Disco!', LU: 125, RU: -55 },
  { name: 'Disco', say: 'Disco the other way!', LU: -125, RU: 55 },
  { name: 'Hands on head', say: 'Hands on your head!', LU: -150, LF: -30, RU: -30, RF: -150 },
  { name: 'Teapot', say: 'Hands on hips!', LU: 135, LF: 45, RU: 45, RF: 135 },
  { name: 'Frog', say: 'Squat like a frog!', LU: -118, RU: -62, crouch: true },
  { name: 'Robot', say: 'Robot arms!', LU: 180, LF: 90, RU: 0, RF: 90 },
];

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// "Hooray" means holding both hands up — that mustn't count as "go home".
const game = await createGame({ exitGesture: false });
const flow = new RoundFlow(game, { title: 'Wall Squeeze', seconds: 0 });
prepareSpeech([...new Set(POSES.map((p) => p.say)), 'Squeezed through!', 'Bonk!', 'Wall Squeeze champions!']);

// ---------- geometry ----------

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
function angleDiff(a: number, b: number) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}
function dir(p: Player, a: number, b: number): number | null {
  const k = p.keypoints;
  if (k[a].score < 0.35 || k[b].score < 0.35) return null;
  return deg(Math.atan2(k[b].y - k[a].y, k[b].x - k[a].x));
}

/** 0..1 how well the player matches, and whether it's a pass. */
function judgePose(p: Player, pose: PoseDef): { fit: number; pass: boolean; perfect: boolean } {
  const checks: [number | null, number, number][] = [
    [dir(p, KP.leftShoulder, KP.leftElbow), pose.LU, TOL_UPPER],
    [dir(p, KP.leftElbow, KP.leftWrist), pose.LF ?? pose.LU, TOL_FORE],
    [dir(p, KP.rightShoulder, KP.rightElbow), pose.RU, TOL_UPPER],
    [dir(p, KP.rightElbow, KP.rightWrist), pose.RF ?? pose.RU, TOL_FORE],
  ];
  if (pose.LT !== undefined) checks.push([dir(p, KP.leftHip, KP.leftKnee), pose.LT, TOL_LEG]);
  if (pose.RT !== undefined) checks.push([dir(p, KP.rightHip, KP.rightKnee), pose.RT, TOL_LEG]);
  let ok = 0;
  let close = 0;
  let total = 0;
  let pass = true;
  let perfect = true;
  for (const [a, target, tol] of checks) {
    if (a === null) continue; // limb out of view: don't punish (legs often are)
    total++;
    const d = angleDiff(a, target);
    if (d <= tol) ok++;
    else pass = false;
    if (d > tol / 2) perfect = false;
    close += Math.max(0, 1 - d / 120);
  }
  if (total < 3) return { fit: 0, pass: false, perfect: false };
  const crouchOk = pose.crouch ? p.pose.crouching : true;
  if (!crouchOk) {
    pass = false;
    perfect = false;
  }
  const fit = (close / total) * 0.5 + (ok / total) * 0.5 - (crouchOk ? 0 : 0.3);
  return { fit: Math.max(0, fit), pass, perfect };
}

/** Where to cut a player's hole: follows them sideways, but stays at standing height (so squats matter). */
interface Holder {
  standY: number | null;
  best: { pass: boolean; perfect: boolean };
  result: 'pass' | 'perfect' | 'bonk' | null;
  fit: number;
}
const holders = new Map<number, Holder>();
const holder = (p: Player) => {
  let h = holders.get(p.id);
  if (!h) holders.set(p.id, (h = { standY: null, best: { pass: false, perfect: false }, result: null, fit: 0 }));
  return h;
};

function bodyFrame(p: Player) {
  const k = p.keypoints;
  const mid = mapper.map({ x: (k[KP.leftShoulder].x + k[KP.rightShoulder].x) / 2, y: (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2 });
  const S = Math.max(mapper.len(p.shoulderWidth), 30);
  const h = holder(p);
  if (!p.pose.crouching) h.standY = h.standY === null ? mid.y : h.standY + (mid.y - h.standY) * 0.1;
  return { x: mid.x, y: h.standY ?? mid.y, S };
}

/** Stick-figure points for a pose, around a standing shoulder midpoint. */
function poseFigure(pose: PoseDef, at: { x: number; y: number; S: number }) {
  const { S } = at;
  const drop = pose.crouch ? S * 0.9 : 0;
  const sh = { x: at.x, y: at.y + drop };
  const ls = { x: sh.x - S / 2, y: sh.y };
  const rs = { x: sh.x + S / 2, y: sh.y };
  const go = (from: Vec2, a: number, len: number) => ({ x: from.x + Math.cos(rad(a)) * len, y: from.y + Math.sin(rad(a)) * len });
  const le = go(ls, pose.LU, S * 0.8);
  const lw = go(le, pose.LF ?? pose.LU, S * 0.75);
  const re = go(rs, pose.RU, S * 0.8);
  const rw = go(re, pose.RF ?? pose.RU, S * 0.75);
  const hipY = sh.y + S * 1.45;
  const lh = { x: sh.x - S * 0.32, y: hipY };
  const rh = { x: sh.x + S * 0.32, y: hipY };
  let lk: Vec2, la: Vec2, rk: Vec2, ra: Vec2;
  if (pose.crouch) {
    // Knees out like a frog, feet back under the hips at standing-feet height.
    const feetY = at.y + S * 3.3;
    lk = { x: lh.x - S * 0.55, y: hipY + S * 0.45 };
    rk = { x: rh.x + S * 0.55, y: hipY + S * 0.45 };
    la = { x: lh.x - S * 0.2, y: feetY };
    ra = { x: rh.x + S * 0.2, y: feetY };
  } else {
    lk = go(lh, pose.LT ?? 95, S * 0.95);
    la = go(lk, pose.LT ?? 95, S * 0.95);
    rk = go(rh, pose.RT ?? 85, S * 0.95);
    ra = go(rk, pose.RT ?? 85, S * 0.95);
  }
  const head = { x: sh.x, y: sh.y - S * 0.75 };
  return {
    lines: [
      [ls, rs],
      [ls, le],
      [le, lw],
      [rs, re],
      [re, rw],
      [ls, lh],
      [rs, rh],
      [lh, rh],
      [lh, lk],
      [lk, la],
      [rh, rk],
      [rk, ra],
      [ls, rh],
      [rs, lh],
    ] as [Vec2, Vec2][],
    head,
    S,
  };
}

// ---------- walls ----------

type WallPhase = 'gap' | 'coming' | 'result';
let wallPhase: WallPhase = 'gap';
let phaseT = 0;
let approach = 6;
let wallNo = 0;
let pose: PoseDef = POSES[0];
let lastPoseIdx = -1;

function nextWall() {
  wallNo++;
  let i: number;
  do i = Math.floor(Math.random() * (wallNo <= 3 ? 4 : POSES.length));
  while (i === lastPoseIdx);
  lastPoseIdx = i;
  pose = POSES[i];
  approach = Math.max(3.6, 6.2 - (wallNo - 1) * 0.28);
  wallPhase = 'coming';
  phaseT = 0;
  for (const h of holders.values()) {
    h.best = { pass: false, perfect: false };
    h.result = null;
  }
  void say(pose.say, { interrupt: true });
  noise(400, 0.05);
}

flow.on('start', () => {
  wallNo = 0;
  holders.clear();
  wallPhase = 'gap';
  phaseT = 0.6;
});

function step(dt: number, players: Player[]) {
  phaseT += dt;
  if (wallPhase === 'gap') {
    if (phaseT >= 1) {
      if (wallNo >= WALLS) {
        flow.end();
        void say('Wall Squeeze champions!');
        return;
      }
      nextWall();
    }
  } else if (wallPhase === 'coming') {
    const prog = phaseT / approach;
    for (const p of players) {
      const h = holder(p);
      const j = judgePose(p, pose);
      h.fit = j.fit;
      // Judged over the last moments before impact, keeping the best.
      if (prog > 0.9) {
        h.best.pass ||= j.pass;
        h.best.perfect ||= j.perfect && j.pass;
      }
    }
    if (prog >= 1) {
      let passes = 0;
      for (const p of players) {
        const h = holder(p);
        h.result = h.best.perfect ? 'perfect' : h.best.pass ? 'pass' : 'bonk';
        if (h.result !== 'bonk') {
          flow.addScore(p.slot, h.result === 'perfect' ? 15 : 10);
          passes++;
        }
      }
      if (passes) {
        blip(784, 120, 'triangle', 0.15, 1568);
        if (passes === players.length) void say('Squeezed through!');
      }
      if (passes < players.length) {
        noise(300, 0.35);
        blip(120, 300, 'square', 0.15, 60);
        if (!passes) void say('Bonk!');
      }
      wallPhase = 'result';
      phaseT = 0;
    }
  } else if (wallPhase === 'result') {
    if (phaseT >= 1.6) {
      wallPhase = 'gap';
      phaseT = 0;
    }
  }
}

// ---------- drawing ----------

let W = 0;
let H = 0;
let mapper = screenMapper(4 / 3, 1, 1);
const wallCanvas = document.createElement('canvas');
const wctx = wallCanvas.getContext('2d')!;
let bricks: HTMLCanvasElement | null = null;

function brickTexture(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const b = c.getContext('2d')!;
  b.fillStyle = '#d9480f';
  b.fillRect(0, 0, w, h);
  const bh = Math.max(24, h / 18);
  const bw = bh * 2.2;
  for (let r = 0; r * bh < h; r++) {
    for (let x = (r % 2) * -bw * 0.5; x < w; x += bw) {
      const shade = 40 + ((r * 7 + Math.floor(x / bw) * 13) % 5) * 4;
      b.fillStyle = `hsl(18, 75%, ${shade}%)`;
      b.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
    }
  }
  // Frame
  b.strokeStyle = '#7f2704';
  b.lineWidth = bh * 0.6;
  b.strokeRect(0, 0, w, h);
  return c;
}

function background() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#4cc9f0');
  g.addColorStop(0.45, '#a9def9');
  g.addColorStop(0.46, '#57cc99');
  g.addColorStop(1, '#38a3a5');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // A track running into the distance.
  const vp = { x: W / 2, y: H * 0.45 };
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(vp.x - 10, vp.y);
  ctx.lineTo(vp.x + 10, vp.y);
  ctx.lineTo(W * 0.95, H);
  ctx.lineTo(W * 0.05, H);
  ctx.fill();
}

function drawHoleOutline(target: CanvasRenderingContext2D, fig: ReturnType<typeof poseFigure>, width: number) {
  target.lineCap = 'round';
  target.lineJoin = 'round';
  target.lineWidth = width;
  for (const [a, b] of fig.lines) {
    target.beginPath();
    target.moveTo(a.x, a.y);
    target.lineTo(b.x, b.y);
    target.stroke();
  }
  target.beginPath();
  target.arc(fig.head.x, fig.head.y, fig.S * 0.5 + width / 4, 0, Math.PI * 2);
  target.fill();
}

function drawWall(prog: number, players: Player[], bonked: boolean) {
  if (wallCanvas.width !== Math.round(W) || wallCanvas.height !== Math.round(H)) {
    wallCanvas.width = Math.round(W);
    wallCanvas.height = Math.round(H);
    bricks = brickTexture(wallCanvas.width, wallCanvas.height);
  }
  wctx.globalCompositeOperation = 'source-over';
  wctx.clearRect(0, 0, W, H);
  wctx.drawImage(bricks!, 0, 0);
  // Cut a hole for every player, where they stand (as seen when the wall
  // arrives), with a dark rim so it reads as a cut-out.
  const figs = players.map((p) => poseFigure(pose, bodyFrame(p)));
  wctx.strokeStyle = wctx.fillStyle = 'rgba(50, 12, 0, 0.85)';
  for (const fig of figs) drawHoleOutline(wctx, fig, fig.S * 0.62 + 16);
  wctx.globalCompositeOperation = 'destination-out';
  wctx.strokeStyle = wctx.fillStyle = '#000';
  for (const fig of figs) drawHoleOutline(wctx, fig, fig.S * 0.62);
  wctx.globalCompositeOperation = 'source-over';

  // Perspective: the wall grows from the vanishing point to fill the screen.
  const e = prog * prog;
  const s = 0.12 + 0.88 * e;
  const vp = { x: W / 2, y: H * 0.45 };
  const cx = vp.x + (W / 2 - vp.x) * e;
  const cy = vp.y + (H / 2 - vp.y) * e;
  ctx.save();
  if (!bonked) ctx.globalAlpha *= Math.min(1, 0.4 + prog);
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.drawImage(wallCanvas, -W / 2, -H / 2);
  ctx.restore();
}

function drawPlayer(p: Player, glow: string | null) {
  const k = p.keypoints;
  const S = Math.max(mapper.len(p.shoulderWidth), 30);
  const pts = k.map((kp) => mapper.map(kp));
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
  ctx.save();
  ctx.lineCap = 'round';
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 30;
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = S * 0.34;
  for (const pass of [0, 1]) {
    if (pass) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = S * 0.24;
      ctx.shadowBlur = 0;
    }
    for (const [a, b] of LIMBS) {
      if (k[a].score < 0.3 || k[b].score < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    }
    if (k[KP.nose].score > 0.3) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(pts[KP.nose].x, pts[KP.nose].y, S * (pass ? 0.32 : 0.38), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
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
  for (const p of players) bodyFrame(p); // keep standing heights fresh

  background();
  const inPlay = flow.state === 'playing';
  const prog = wallPhase === 'coming' ? Math.min(1, phaseT / approach) : wallPhase === 'result' ? 1 : 0;
  const anyBonk = [...holders.values()].some((h) => h.result === 'bonk');

  // The wall is drawn behind the players while it approaches; a wall that bonks
  // someone flashes in front of them for a moment.
  if (inPlay && wallPhase === 'coming') drawWall(prog, players, false);
  // Players
  for (const p of players) {
    const h = holder(p);
    const glow = inPlay && wallPhase === 'result' ? (h.result === 'bonk' ? null : '#ffd60a') : inPlay && wallPhase === 'coming' && h.fit > 0.75 ? '#80ffdb' : null;
    drawPlayer(p, glow);
  }
  if (inPlay && wallPhase === 'result' && anyBonk && phaseT < 0.6) {
    ctx.globalAlpha = 1 - phaseT / 0.6;
    drawWall(1, players, true);
    ctx.globalAlpha = 1;
  }

  // Per-player feedback above heads.
  if (inPlay) {
    for (const p of players) {
      const h = holder(p);
      const k = p.keypoints;
      if (k[KP.nose].score < 0.3) continue;
      const n = mapper.map(k[KP.nose]);
      const S = Math.max(mapper.len(p.shoulderWidth), 30);
      const y = Math.max(110, n.y - S * 1.2); // keep on screen
      if (wallPhase === 'result' && h.result) {
        const txt = h.result === 'perfect' ? 'PERFECT! +15' : h.result === 'pass' ? 'SQUEEZED! +10' : 'BONK!';
        drawText(ctx, txt, n.x, y, Math.max(26, S * 0.45), h.result === 'bonk' ? '#ff4d6d' : '#ffd60a');
      } else if (wallPhase === 'coming') {
        // Fit meter
        const bw = S * 1.6;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(n.x - bw / 2, y, bw, 14);
        ctx.fillStyle = h.fit > 0.75 ? '#80ffdb' : h.fit > 0.5 ? '#ffd60a' : '#ff4d6d';
        ctx.fillRect(n.x - bw / 2, y, bw * Math.min(1, h.fit), 14);
      }
    }
    if (wallPhase === 'coming') {
      drawText(ctx, pose.name, W / 2, H * 0.12, Math.min(H / 9, W / 8), '#fff');
      // Mini picture of the pose for non-readers.
      const fig = poseFigure(pose, { x: W - H * 0.12, y: H * 0.1, S: H * 0.05 });
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#fff';
      drawHoleOutline(ctx, fig, H * 0.018);
      ctx.restore();
    }
    drawText(ctx, `Wall ${Math.max(1, Math.min(wallNo, WALLS))} of ${WALLS}`, W - 20, H - 30, 26, '#fff', { align: 'right' });
  }
  flow.drawOverlay(ctx, W, H);
  if (flow.state === 'lobby') {
    drawText(ctx, 'Make the same shape as the hole in the wall!', W / 2, H * 0.53, Math.min(H / 24, W / 34));
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Read-only peek for automated tests.
(window as unknown as { wall: () => object }).wall = () => ({
  state: flow.state,
  wallPhase,
  wallNo,
  pose: pose.name,
  prog: wallPhase === 'coming' ? phaseT / approach : null,
  scores: flow.scores,
  holders: [...holders.values()].map((h) => ({ fit: +h.fit.toFixed(2), result: h.result })),
});
