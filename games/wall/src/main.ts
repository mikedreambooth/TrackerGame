/**
 * Wall Squeeze — a wall rushes towards you with a body-shaped hole in it. Make
 * the same shape before it arrives to squeeze through!
 *
 * Each player gets their own hole, cut where they stand and sized to their
 * body. A pose is a set of limb directions (angles on screen), so matching is
 * independent of height and distance. Kid-friendly tolerances.
 *
 * Artwork: art/generate.py (Gemini) -> public/art.
 */
import {
  KP,
  RoundFlow,
  blip,
  createGame,
  drawText,
  fitCanvas,
  loadAssets,
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
const assets = await loadAssets({
  images: { background: 'art/background.jpg', bricks: 'art/bricks.jpg', star: 'art/star.png', sign: 'art/sign.png' },
});
const img = assets.images;
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
  // The fit meter climbs as they squat down (crouchDepth), so kids can see it's working.
  const squat = Math.min(1, (p.pose.crouchDepth ?? 0) / 0.5);
  const fit = (close / total) * 0.5 + (ok / total) * 0.5 - (crouchOk ? 0 : 0.3 * (1 - squat));
  return { fit: Math.max(0, fit), pass, perfect };
}

/** Where to cut a player's hole: follows them sideways, but stays at standing height (so squats matter). */
interface Holder {
  standY: number | null;
  /** Standing shoulders-to-hips length on screen (px), so the hole's body matches theirs. */
  torso: number | null;
  best: { pass: boolean; perfect: boolean };
  result: 'pass' | 'perfect' | 'bonk' | null;
  fit: number;
}
const holders = new Map<number, Holder>();
const holder = (p: Player) => {
  let h = holders.get(p.id);
  if (!h) holders.set(p.id, (h = { standY: null, torso: null, best: { pass: false, perfect: false }, result: null, fit: 0 }));
  return h;
};

/** Where a player's hole goes and how big its body is, from their standing shape. */
function bodyFrame(p: Player): BodyFrame {
  const k = p.keypoints;
  const mid = mapper.map({ x: (k[KP.leftShoulder].x + k[KP.rightShoulder].x) / 2, y: (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2 });
  const S = Math.max(mapper.len(p.shoulderWidth), 30);
  const h = holder(p);
  // Only learn the standing shape while they stand up straight (a half squat mustn't move the hole).
  const standing = (p.pose.crouchDepth ?? (p.pose.crouching ? 1 : 0)) < 0.25;
  if (standing) {
    h.standY = h.standY === null ? mid.y : h.standY + (mid.y - h.standY) * 0.1;
    if (k[KP.leftHip].score > 0.35 && k[KP.rightHip].score > 0.35) {
      const hipY = mapper.map({ x: 0, y: (k[KP.leftHip].y + k[KP.rightHip].y) / 2 }).y;
      const t = Math.min(S * 2.2, Math.max(S * 1.1, hipY - mid.y));
      h.torso = h.torso === null ? t : h.torso + (t - h.torso) * 0.1;
    }
  }
  return {
    x: mid.x,
    y: h.standY ?? mid.y,
    S,
    torso: h.torso ?? undefined,
    arm: mapper.len(p.armLength),
    // Players' feet stand on the baseline, so the hole's feet go there too.
    feetY: game.frame.baseline !== undefined ? game.frame.baseline * H : undefined,
  };
}

/**
 * A standing shoulder midpoint and shoulder width (px), plus, for a player's hole, their own
 * torso and arm lengths and where their feet stand (otherwise a stock figure scaled by S).
 */
interface BodyFrame {
  x: number;
  y: number;
  S: number;
  torso?: number;
  arm?: number;
  feetY?: number;
}

/** Stick-figure points for a pose, around a standing shoulder midpoint. */
function poseFigure(pose: PoseDef, at: BodyFrame) {
  const { S } = at;
  const torso = at.torso ?? S * 1.45;
  const arm = Math.min(S * 2.6, Math.max(S * 1.3, at.arm ?? S * 1.55));
  const drop = pose.crouch ? torso * 0.62 : 0;
  const sh = { x: at.x, y: at.y + drop };
  const ls = { x: sh.x - S / 2, y: sh.y };
  const rs = { x: sh.x + S / 2, y: sh.y };
  const go = (from: Vec2, a: number, len: number) => ({ x: from.x + Math.cos(rad(a)) * len, y: from.y + Math.sin(rad(a)) * len });
  const le = go(ls, pose.LU, arm * 0.52);
  const lw = go(le, pose.LF ?? pose.LU, arm * 0.48);
  const re = go(rs, pose.RU, arm * 0.52);
  const rw = go(re, pose.RF ?? pose.RU, arm * 0.48);
  const hipY = sh.y + torso;
  const lh = { x: sh.x - S * 0.32, y: hipY };
  const rh = { x: sh.x + S * 0.32, y: hipY };
  // Standing feet: on the ground the player stands on, else stock proportions.
  const standHipY = at.y + torso;
  const feetY = Math.min(standHipY + torso * 2, Math.max(standHipY + torso * 0.9, at.feetY ?? standHipY + S * 1.9));
  let lk: Vec2, la: Vec2, rk: Vec2, ra: Vec2;
  if (pose.crouch) {
    // Knees out like a frog, feet back under the hips at standing-feet height.
    lk = { x: lh.x - S * 0.55, y: hipY + S * 0.45 };
    rk = { x: rh.x + S * 0.55, y: hipY + S * 0.45 };
    la = { x: lh.x - S * 0.2, y: feetY };
    ra = { x: rh.x + S * 0.2, y: feetY };
  } else {
    // Each leg's two halves long enough for the foot to reach the ground at that angle.
    const leg = (a: number) => (feetY - hipY) / 2 / Math.max(0.5, Math.sin(rad(a)));
    const lt = pose.LT ?? 95;
    const rt = pose.RT ?? 85;
    lk = go(lh, lt, leg(lt));
    la = go(lk, lt, leg(lt));
    rk = go(rh, rt, leg(rt));
    ra = go(rk, rt, leg(rt));
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

/** Draws an image to cover a w x h area (centred, cropped), like CSS background-size: cover. */
function cover(target: CanvasRenderingContext2D, im: HTMLImageElement, w: number, h: number) {
  const k = Math.max(w / im.width, h / im.height);
  target.drawImage(im, (w - im.width * k) / 2, (h - im.height * k) / 2, im.width * k, im.height * k);
}

function brickTexture(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const b = c.getContext('2d')!;
  cover(b, img.bricks, w, h);
  // Frame
  const bh = Math.max(24, h / 18);
  b.strokeStyle = '#7f2704';
  b.lineWidth = bh * 0.6;
  b.strokeRect(0, 0, w, h);
  return c;
}

function background() {
  // A castle at the end of a path; the wall rushes up the path from the castle.
  cover(ctx, img.background, W, H);
}

/** Happy stars bursting out around a player who squeezed through. */
function drawStars(at: Vec2, S: number, count: number, t: number) {
  const a = Math.min(1, 2.2 - t * 1.6);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + t * 1.5;
    const r = S * (0.6 + t * 1.6);
    const size = S * (0.55 + 0.15 * Math.sin(t * 8 + i));
    ctx.drawImage(img.star, at.x + Math.cos(ang) * r - size / 2, at.y + Math.sin(ang) * r * 0.8 - size / 2, size, size);
  }
  ctx.restore();
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

/**
 * The player's body shape, since matching it to the hole is the game. Over their camera
 * cut-out it's a thin outline (the picture shows the rest); without one, a bold stick figure.
 */
function drawPlayer(p: Player, glow: string | null, thin: boolean) {
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
  const [edge, line] = thin ? [S * 0.14, S * 0.07] : [S * 0.34, S * 0.24];
  if (thin) ctx.globalAlpha = 0.85;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = edge;
  for (const pass of [0, 1]) {
    if (pass) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = line;
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
      // A ring round their face over the cut-out, a solid head otherwise.
      ctx.arc(pts[KP.nose].x, pts[KP.nose].y, thin ? S * 0.4 : S * (pass ? 0.32 : 0.38), 0, Math.PI * 2);
      if (thin) ctx.stroke();
      else ctx.fill();
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
  game.drawPeople(ctx, W, H); // the players themselves, under their stick figures
  const cutouts = game.peopleVisible; // cut-outs showing (G on, tracker segmenting; not in the simulator)
  // Players
  for (const p of players) {
    const h = holder(p);
    const glow = inPlay && wallPhase === 'result' ? (h.result === 'bonk' ? null : '#ffd60a') : inPlay && wallPhase === 'coming' && h.fit > 0.75 ? '#80ffdb' : null;
    drawPlayer(p, glow, cutouts);
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
        if (h.result !== 'bonk') drawStars(n, S, h.result === 'perfect' ? 6 : 4, phaseT);
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
      // Mini picture of the pose for non-readers, chalked on a little board.
      const sx = W - H * 0.17;
      const ss = H * 0.34;
      ctx.drawImage(img.sign, sx - ss / 2, H * 0.145 - ss / 2, ss, ss);
      const fig = poseFigure(pose, { x: sx, y: H * 0.1, S: H * 0.05 });
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
