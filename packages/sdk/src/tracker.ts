import { CURSOR, handRaised, measureReach, reachToScreen, strayHand } from './cursor';
import { FEET } from './feet-config';
import { OneEuro } from './filters';
import type { ServerEvent, ServerFrame, ServerPlayer } from './protocol';
import {
  KEYPOINT_COUNT,
  KP,
  MAX_PLAYERS,
  PLAYER_COLORS,
  type Distance,
  type Facing,
  type Frame,
  type GameEvent,
  type InputSource,
  type Keypoint,
  type Player,
  type RawPose,
  type Side,
  type Vec2,
} from './types';

export interface TrackerOptions {
  maxPlayers?: number;
  /** Frames a new person must be seen for before they count as joined. */
  confirmFrames?: number;
  /** ms a player can be missing before they're dropped. */
  leaveAfterMs?: number;
  /** Ignore keypoints below this confidence. */
  minKeypointScore?: number;
  /** Mirror the image so the screen behaves like a mirror. */
  mirror?: boolean;
  /**
   * One Euro smoothing of keypoints, body centre and hand cursor. Default on; `?smooth=0` in
   * the page URL turns it off (raw tracker positions; velocities are still estimated).
   */
  smoothing?: boolean;
}

/** `?smooth=0` in the page URL turns keypoint smoothing off (for comparing by feel). */
export const smoothingFromUrl = () => typeof location === 'undefined' || new URLSearchParams(location.search).get('smooth') !== '0';

/** Arm length as a multiple of the body scale (torso length, or shoulder width if larger). */
const ARM = {
  /** Before an arm has been seen straight: typical for adults and children alike. */
  initial: 1.1,
  /** What a long-unseen arm is slowly forgotten down to. */
  floor: 0.95,
  /** Longer than this is a mis-detection. */
  max: 1.4,
  /** Time constant for forgetting (ms). */
  forgetMs: 30_000,
};

/** Jump detection and the airborne state. */
export const JUMP = {
  /** Take-off: the body centre rising faster than this many torso lengths per second. */
  takeoffSpeed: 2.5,
  /** At least this long between jump events (ms). */
  cooldownMs: 600,
  /** Standing up from a crouch isn't a jump: ignored this long after one (ms). */
  afterCrouchMs: 700,
  /** Landed: back within this many torso lengths of standing height (and not rising)… */
  landRise: 0.1,
  /** …at least this long after take-off (ms). */
  minAirMs: 150,
  /** Landed anyway after this long (ms). */
  maxAirMs: 1500,
  /** How slowly the standing height follows the body (s). */
  standTau: 1.0,
};

/** How slowly a player's "home" spot follows them, for Motion.drift (s). */
const DRIFT_TAU = 4.0;
/** Standing height ≈ this many torso lengths (children and adults alike). */
const HEIGHT_PER_TORSO = 3.2;
/** Standing height ≈ ankle-to-nose × this. */
const NOSE_TO_HEIGHT = 1.12;
/** Side-on when shoulders are narrower than this fraction of their front-on width (per torso length). */
const FACING = { sideRatio: 0.5, minFrontRatio: 0.6, frames: 4 };

const EURO_KEYPOINT = [1.5, 5, 1.0] as const;
const EURO_CENTRE = [1.0, 5, 1.0] as const;
const EURO_CURSOR = [1.0, 2, 1.0] as const;

interface Track {
  /** 0 until confirmed: ids are handed out when someone actually joins. */
  id: number;
  confirmed: boolean;
  hits: number;
  lastSeen: number;
  joinedAt: number;
  /** Index of their detection in this frame's poses (-1: not seen). */
  det: number;
  fx: OneEuro[];
  fy: OneEuro[];
  fz: OneEuro[];
  keypoints: Keypoint[];
  center: Vec2;
  /** Centre y (shown smoothed) and x (for horizontal motion only). */
  cyf: OneEuro;
  cxf: OneEuro;
  /** Smoothed centre x, and its change since the last frame. */
  mx: number | null;
  dx: number;
  shoulderWidth: number;
  torso: number;
  bbox: Player['bbox'];
  confidence: number;
  // Held poses.
  handsUp: boolean;
  crouching: boolean;
  crouchDepth: number;
  lean: -1 | 0 | 1;
  leanAngle: number;
  armsOut: boolean;
  run: number;
  handsTogether: boolean;
  balance: Side | null;
  // Body measures.
  /** Torso length, aspect-corrected (camera-height units), for arm length and cursors. */
  torsoAC: number;
  /** Arm length as a multiple of the body scale (see measureArm). */
  armRatio: number;
  armLength: number;
  armAt: number;
  height: number;
  // Gesture bookkeeping (see detect).
  legBase: number;
  crouchEndedAt: number;
  handsApartAt: number;
  lastClap: number;
  ext: Record<Side, { t: number; v: number }[]>;
  lastPunch: Record<Side, number>;
  lastKick: Record<Side, number>;
  lastJump: number;
  /** Time of the last gesture pass. */
  gt: number;
  // Jump state.
  stand: number | null;
  airborne: boolean;
  airStart: number;
  peak: number;
  rise: number;
  // Home spot and facing.
  home: [number, number] | null;
  frontRatio: number;
  facing: Facing;
  facingNext: Facing;
  facingN: number;
  far: boolean;
  distance: Distance;
  cursor: {
    hand: number | null;
    pos: Vec2 | null;
    fx: OneEuro;
    fy: OneEuro;
    /** When the pointing hand was last usable (brief dropouts keep the cursor). */
    seenAt: number;
  };
}

interface Prepared {
  kps: { x: number; y: number; z: number; score: number }[];
  center: Vec2;
  shoulderWidth: number;
  torso: number;
  bbox: Player['bbox'];
  det: number;
}

const avg = (a: number, b: number) => (a + b) / 2;
const euro = (p: readonly [number, number, number], smooth: boolean) => new OneEuro(p[0], p[1], p[2], smooth);

/**
 * Raw poses per frame → players with stable ids, smoothed keypoints, body measures, held
 * poses, hand cursors and events, as a tracker protocol v2 frame (ServerFrame).
 *
 * The browser twin of the tracker's player tracking (tracker/players.py), used for sources
 * that only give raw poses (the simulator, older trackers). Keep the two in step: the shared
 * fixtures in tracker/tests/ check that they agree. Models give us an unordered list of
 * people every frame; this is what makes "Player 2" stay Player 2.
 */
export class PoseTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  /** Ids of players who left, handed to the next people to join. */
  private reserved: number[] = [];
  private opts: Required<TrackerOptions>;

  constructor(opts: TrackerOptions = {}) {
    this.opts = {
      maxPlayers: opts.maxPlayers ?? MAX_PLAYERS,
      confirmFrames: opts.confirmFrames ?? 5,
      leaveAfterMs: opts.leaveAfterMs ?? 700,
      minKeypointScore: opts.minKeypointScore ?? 0.35,
      mirror: opts.mirror ?? true,
      smoothing: opts.smoothing ?? smoothingFromUrl(),
    };
  }

  update(poses: RawPose[], t: number, aspect: number): ServerFrame {
    const events: ServerEvent[] = [];
    const candidates: Prepared[] = [];
    poses.forEach((p, i) => {
      if (p.length < KEYPOINT_COUNT) return;
      const c = this.prepare(p, i);
      if (c) candidates.push(c);
    });

    // Greedy nearest-centre matching. With ≤4 people this is as good as Hungarian.
    const pairs: { ti: number; ci: number; d: number }[] = [];
    this.tracks.forEach((tr, ti) => {
      const gate = Math.max(0.12, tr.shoulderWidth * 2.5);
      candidates.forEach((c, ci) => {
        const d = Math.hypot(tr.center.x - c.center.x, tr.center.y - c.center.y);
        if (d < gate) pairs.push({ ti, ci, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set<number>();
    const usedC = new Set<number>();
    for (const tr of this.tracks) tr.det = -1;
    for (const { ti, ci } of pairs) {
      if (usedT.has(ti) || usedC.has(ci)) continue;
      usedT.add(ti);
      usedC.add(ci);
      this.updateTrack(this.tracks[ti], candidates[ci], t);
    }

    // New people.
    candidates.forEach((c, ci) => {
      if (usedC.has(ci) || this.tracks.length >= this.opts.maxPlayers) return;
      const tr = this.newTrack(c, t);
      this.tracks.push(tr);
      this.updateTrack(tr, c, t);
    });

    // Confirm, measure, detect gestures.
    for (const tr of this.tracks) {
      if (!tr.confirmed && tr.hits >= this.opts.confirmFrames) {
        tr.confirmed = true;
        tr.joinedAt = t;
        tr.id = this.reserved.length ? this.reserved.sort((a, b) => a - b).shift()! : this.nextId++;
        events.push({ type: 'join', id: tr.id });
      }
      if (tr.confirmed && tr.lastSeen === t) {
        this.measureArm(tr, t, aspect);
        this.detect(tr, t, aspect, events);
      }
    }

    // Leave.
    this.tracks = this.tracks.filter((tr) => {
      const alive = t - tr.lastSeen <= this.opts.leaveAfterMs;
      if (!alive && tr.confirmed) {
        events.push({ type: 'leave', id: tr.id });
        this.reserved.push(tr.id);
      }
      return alive;
    });

    const live = this.tracks.filter((tr) => tr.confirmed);
    for (const tr of live) this.updateCursor(tr, t, aspect, live);
    live.sort((a, b) => a.id - b.id);
    return { v: 2, t, aspect, players: live.map((tr) => this.packet(tr, t, aspect)), events, detections: poses.length };
  }

  /** Player id for each detection index of the last update (-1: nobody / not joined yet). */
  idsByDetection(count: number): number[] {
    const ids = new Array<number>(count).fill(-1);
    for (const tr of this.tracks) if (tr.confirmed && tr.det >= 0 && tr.det < count) ids[tr.det] = tr.id;
    return ids;
  }

  /** Forget everyone, including the ids kept for people who left. */
  reset(): void {
    this.tracks = [];
    this.reserved = [];
    this.nextId = 1;
  }

  private newTrack(c: Prepared, t: number): Track {
    const s = this.opts.smoothing;
    return {
      id: 0,
      confirmed: false,
      hits: 0,
      lastSeen: t,
      joinedAt: t,
      det: -1,
      fx: Array.from({ length: KEYPOINT_COUNT }, () => euro(EURO_KEYPOINT, s)),
      fy: Array.from({ length: KEYPOINT_COUNT }, () => euro(EURO_KEYPOINT, s)),
      // Depth is noisy: smooth it harder.
      fz: Array.from({ length: KEYPOINT_COUNT }, () => new OneEuro(1.0, 0.2, 1.0, s)),
      keypoints: Array.from({ length: KEYPOINT_COUNT }, () => ({ x: 0, y: 0, z: 0, score: 0, vx: 0, vy: 0, vz: 0 })),
      center: c.center,
      cyf: euro(EURO_CENTRE, s),
      cxf: euro(EURO_CENTRE, s),
      mx: null,
      dx: 0,
      shoulderWidth: c.shoulderWidth,
      torso: c.torso,
      bbox: c.bbox,
      confidence: 0,
      handsUp: false,
      crouching: false,
      crouchDepth: 0,
      lean: 0,
      leanAngle: 0,
      armsOut: false,
      run: 0,
      handsTogether: false,
      balance: null,
      torsoAC: 0,
      armRatio: ARM.initial,
      armLength: 0,
      armAt: 0,
      height: 0,
      legBase: 0,
      crouchEndedAt: -1e9,
      handsApartAt: -1e9,
      lastClap: -1e9,
      ext: { left: [], right: [] },
      lastPunch: { left: -1e9, right: -1e9 },
      lastKick: { left: -1e9, right: -1e9 },
      lastJump: 0,
      gt: 0,
      stand: null,
      airborne: false,
      airStart: 0,
      peak: 0,
      rise: 0,
      home: null,
      frontRatio: 0,
      facing: 'front',
      facingNext: 'front',
      facingN: 0,
      far: false,
      distance: 'ok',
      cursor: { hand: null, pos: null, fx: euro(EURO_CURSOR, s), fy: euro(EURO_CURSOR, s), seenAt: -1e9 },
    };
  }

  private prepare(raw: RawPose, det: number): Prepared | null {
    const min = this.opts.minKeypointScore;
    const kps = raw.slice(0, KEYPOINT_COUNT).map((k) => ({
      x: this.opts.mirror ? 1 - k.x : k.x,
      y: k.y,
      z: k.z ?? 0,
      score: k.score,
    }));
    const ls = kps[KP.leftShoulder];
    const rs = kps[KP.rightShoulder];
    if (ls.score < min || rs.score < min) return null; // need shoulders to be useful
    const lh = kps[KP.leftHip];
    const rh = kps[KP.rightHip];
    const shoulderMid = { x: avg(ls.x, rs.x), y: avg(ls.y, rs.y) };
    const hipsOk = lh.score >= min && rh.score >= min;
    const hipMid = hipsOk ? { x: avg(lh.x, rh.x), y: avg(lh.y, rh.y) } : null;
    const shoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    if (shoulderWidth < 0.02) return null;
    const torso = hipMid ? Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y) : shoulderWidth * 1.3;
    const center = hipMid ? { x: avg(shoulderMid.x, hipMid.x), y: avg(shoulderMid.y, hipMid.y) } : shoulderMid;
    const vis = kps.filter((k) => k.score >= min);
    const xs = vis.map((k) => k.x);
    const ys = vis.map((k) => k.y);
    const bbox = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    return { kps, center, shoulderWidth, torso, bbox, det };
  }

  private updateTrack(tr: Track, c: Prepared, t: number): void {
    tr.hits++;
    tr.lastSeen = t;
    tr.det = c.det;
    tr.shoulderWidth = tr.shoulderWidth * 0.8 + c.shoulderWidth * 0.2;
    tr.torso = tr.torso * 0.8 + c.torso * 0.2;
    tr.bbox = c.bbox;
    const cy = tr.cyf.filter(c.center.y, t);
    tr.center = { x: c.center.x, y: cy };
    const mx = tr.cxf.filter(c.center.x, t);
    tr.dx = tr.mx === null ? 0 : mx - tr.mx;
    tr.mx = mx;
    let total = 0;
    for (let i = 0; i < KEYPOINT_COUNT; i++) {
      const raw = c.kps[i];
      const k = tr.keypoints[i];
      if (raw.score >= this.opts.minKeypointScore) {
        k.x = tr.fx[i].filter(raw.x, t);
        k.y = tr.fy[i].filter(raw.y, t);
        k.z = tr.fz[i].filter(raw.z, t);
        k.vx = tr.fx[i].velocity;
        k.vy = tr.fy[i].velocity;
        k.vz = tr.fz[i].velocity;
        k.score = raw.score;
      } else {
        // Hold last position, fade confidence, kill velocity.
        k.score *= 0.8;
        k.vx = 0;
        k.vy = 0;
        k.vz = 0;
      }
      total += raw.score;
    }
    tr.confidence = total / KEYPOINT_COUNT;
  }

  /**
   * Arm length: the longest shoulder→elbow→wrist seen recently, as a multiple of the body
   * scale (torso, or shoulders when turned side-on) so it stays right as people move nearer
   * or further. Slowly forgotten, and clamped to human proportions.
   */
  private measureArm(tr: Track, t: number, aspect: number): void {
    const k = tr.keypoints;
    const good = (...ids: number[]) => ids.every((i) => k[i].score >= 0.5);
    const d = (a: number, b: number) => Math.hypot((k[a].x - k[b].x) * aspect, k[a].y - k[b].y);
    if (!good(KP.leftShoulder, KP.rightShoulder)) return;
    const S = d(KP.leftShoulder, KP.rightShoulder);
    if (good(KP.leftHip, KP.rightHip)) {
      const tx = (k[KP.leftShoulder].x + k[KP.rightShoulder].x - k[KP.leftHip].x - k[KP.rightHip].x) / 2;
      const ty = (k[KP.leftShoulder].y + k[KP.rightShoulder].y - k[KP.leftHip].y - k[KP.rightHip].y) / 2;
      const T = Math.hypot(tx * aspect, ty);
      tr.torsoAC = tr.torsoAC ? tr.torsoAC * 0.8 + T * 0.2 : T;
    } else if (!tr.torsoAC) tr.torsoAC = 1.4 * S;
    const B = Math.max(tr.torsoAC, S, 0.02);
    const dt = tr.armAt ? Math.min(t - tr.armAt, 250) : 0;
    tr.armAt = t;
    let ratio = ARM.floor + (tr.armRatio - ARM.floor) * Math.exp(-dt / ARM.forgetMs);
    for (const [sh, el, wr] of [
      [KP.leftShoulder, KP.leftElbow, KP.leftWrist],
      [KP.rightShoulder, KP.rightElbow, KP.rightWrist],
    ]) {
      if (good(sh, el, wr)) ratio = Math.max(ratio, Math.min(ARM.max, (d(sh, el) + d(el, wr)) / B));
    }
    tr.armRatio = ratio;
    tr.armLength = ratio * B;
  }

  /**
   * Turns smoothed keypoints into poses (held) and events (moments). All thresholds are
   * relative to the player's own size — shoulder width S and torso length T — so they work
   * for small kids and adults, near or far.
   */
  private detect(tr: Track, t: number, aspect: number, events: ServerEvent[]): void {
    const k = tr.keypoints;
    const min = this.opts.minKeypointScore;
    const ok = (...ids: number[]) => ids.every((i) => k[i].score >= min);
    const id = tr.id;
    const S = Math.max(tr.shoulderWidth, 0.02);
    const T = Math.max(tr.torso, 0.03);
    const TA = tr.torsoAC || T;
    const dt = tr.gt ? Math.min(Math.max((t - tr.gt) / 1000, 0), 0.5) : 0;
    tr.gt = t;
    const ease = (tau: number) => 1 - Math.exp(-dt / tau);

    // Hands up: both wrists above the nose.
    if (ok(KP.leftWrist, KP.rightWrist, KP.nose)) {
      const up = k[KP.leftWrist].y < k[KP.nose].y && k[KP.rightWrist].y < k[KP.nose].y;
      if (up && !tr.handsUp) events.push({ type: 'handsUp', id });
      tr.handsUp = up;
    }

    // Crouch: legs (hip→standing foot height) much shorter than this player's standing legs.
    // The lower foot, so a kick or standing on one leg isn't a crouch.
    let ankles = [KP.leftAnkle, KP.rightAnkle].filter((i) => ok(i));
    if (ok(KP.leftHip, KP.rightHip) && ankles.length) {
      const hipY = (k[KP.leftHip].y + k[KP.rightHip].y) / 2;
      const ankleY = Math.max(...ankles.map((i) => k[i].y));
      const ratio = (ankleY - hipY) / T;
      if (!tr.crouching) tr.legBase = Math.max(tr.legBase * 0.998, ratio); // slowly forget
      if (!tr.crouching && tr.legBase > 0 && ratio < tr.legBase * 0.7) {
        tr.crouching = true;
        events.push({ type: 'crouch', id });
      } else if (tr.crouching && ratio > tr.legBase * 0.85) {
        tr.crouching = false;
        tr.crouchEndedAt = t;
      }
      tr.crouchDepth = tr.legBase > 0 ? Math.min(1, Math.max(0, (1 - ratio / tr.legBase) / 0.6)) : 0;
    }

    // Lean: torso tilted more than ~15° from upright (with hysteresis).
    if (ok(KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip)) {
      const dx = (k[KP.leftShoulder].x + k[KP.rightShoulder].x - k[KP.leftHip].x - k[KP.rightHip].x) / 2;
      const dy = (k[KP.leftHip].y + k[KP.rightHip].y - k[KP.leftShoulder].y - k[KP.rightShoulder].y) / 2;
      const angle = Math.atan2(dx, Math.max(dy, 1e-3));
      let lean: -1 | 0 | 1 = tr.lean;
      if (angle < -0.26) lean = -1;
      else if (angle > 0.26) lean = 1;
      else if (Math.abs(angle) < 0.17) lean = 0;
      if (lean !== 0 && lean !== tr.lean) events.push({ type: 'lean', id, direction: lean < 0 ? 'left' : 'right' });
      tr.lean = lean;
      tr.leanAngle = angle;
    }

    // Arms out: both wrists well out to the sides, roughly at shoulder height.
    if (ok(KP.leftShoulder, KP.rightShoulder, KP.leftWrist, KP.rightWrist)) {
      const lw = k[KP.leftWrist];
      const rw = k[KP.rightWrist];
      const ls = k[KP.leftShoulder];
      const rs = k[KP.rightShoulder];
      const out =
        lw.x < ls.x - 1.1 * S && rw.x > rs.x + 1.1 * S && Math.abs(lw.y - ls.y) < 0.7 * S && Math.abs(rw.y - rs.y) < 0.7 * S;
      if (out && !tr.armsOut) events.push({ type: 'armsOut', id });
      tr.armsOut = out;
    }

    // Hands together (held), and clap: wrists apart moments ago, now together in front.
    if (ok(KP.leftWrist, KP.rightWrist)) {
      const d = Math.hypot(k[KP.leftWrist].x - k[KP.rightWrist].x, k[KP.leftWrist].y - k[KP.rightWrist].y);
      tr.handsTogether = d < (tr.handsTogether ? 0.7 : 0.5) * S;
      if (ok(KP.leftHip, KP.rightHip)) {
        const aboveHips = Math.max(k[KP.leftWrist].y, k[KP.rightWrist].y) < Math.min(k[KP.leftHip].y, k[KP.rightHip].y);
        // Claps happen at chest height; hands meeting up by the face is a boxing guard.
        const handsY = (k[KP.leftWrist].y + k[KP.rightWrist].y) / 2;
        const belowFace = !ok(KP.nose) || handsY > k[KP.nose].y + 0.6 * S;
        if (d > 1.0 * S) tr.handsApartAt = t;
        else if (d < 0.4 * S && aboveHips && belowFace && t - tr.handsApartAt < 500 && t - tr.lastClap > 400) {
          tr.lastClap = t;
          events.push({ type: 'clap', id });
        }
      }
    } else tr.handsTogether = false;

    // Punch: an arm goes from bent to extended fast.
    const arms: [Side, number, number, number][] = [
      ['left', KP.leftShoulder, KP.leftWrist, KP.rightWrist],
      ['right', KP.rightShoulder, KP.rightWrist, KP.leftWrist],
    ];
    for (const [side, sh, wr, otherWr] of arms) {
      if (!ok(sh, wr)) continue;
      const hist = tr.ext[side];
      // 3D when the source gives depth (the simulator's jab), so punches straight at the camera count too.
      const ext = Math.hypot(k[sh].x - k[wr].x, k[sh].y - k[wr].y, k[sh].z - k[wr].z) / S;
      hist.push({ t, v: ext });
      while (hist.length && t - hist[0].t > 300) hist.shift();
      const bent = Math.min(...hist.map((h) => h.v));
      const speed = Math.hypot(k[wr].vx, k[wr].vy, k[wr].vz);
      // A punch lands around shoulder height (not hands going overhead or swinging down)…
      const shoulderHeight = Math.abs(k[wr].y - k[sh].y) < 0.8 * S;
      // …and is one arm: both arms flying out together is a clap release / arms out.
      const otherSpeed = Math.hypot(k[otherWr].vx, k[otherWr].vy, k[otherWr].vz);
      const oneArm = otherSpeed < 0.5 * speed;
      if (ext > 1.2 && bent < 0.75 && speed > 3 * S && shoulderHeight && oneArm && t - tr.lastPunch[side] > 350) {
        tr.lastPunch[side] = t;
        hist.length = 0;
        events.push({ type: 'punch', id, hand: side, speed: round(speed / S, 2) });
      }
    }

    // Kick: one ankle raised well above the other, moving up fast.
    const legs: [Side, number, number][] = [
      ['left', KP.leftAnkle, KP.rightAnkle],
      ['right', KP.rightAnkle, KP.leftAnkle],
    ];
    for (const [side, ankle, other] of legs) {
      if (!ok(ankle, other) || tr.crouching) continue;
      const lift = k[other].y - k[ankle].y;
      if (lift > 0.5 * T && k[ankle].vy < -2 * T && t - tr.lastKick[side] > 500) {
        tr.lastKick[side] = t;
        events.push({ type: 'kick', id, foot: side });
      }
    }

    // Run effort: how fast the knees (or, failing that, wrists) pump up and down.
    let effort = 0;
    if (ok(KP.leftKnee, KP.rightKnee)) effort = (Math.abs(k[KP.leftKnee].vy) + Math.abs(k[KP.rightKnee].vy)) / T;
    else if (ok(KP.leftWrist, KP.rightWrist)) effort = (0.7 * (Math.abs(k[KP.leftWrist].vy) + Math.abs(k[KP.rightWrist].vy))) / T;
    tr.run += (effort - tr.run) * 0.08;

    // Jump: the body centre moving up fast (not just after standing up from a crouch); then
    // airborne until it's back down near standing height.
    const vy = tr.cyf.velocity; // negative = up
    const cy = tr.center.y;
    if (tr.stand === null) tr.stand = cy;
    else if (!tr.airborne && !tr.crouching) tr.stand += (cy - tr.stand) * ease(JUMP.standTau);
    const rise = tr.stand - cy; // camera-height fraction, up = positive
    if (
      vy < -JUMP.takeoffSpeed * T &&
      t - tr.lastJump > JUMP.cooldownMs &&
      !tr.crouching &&
      t - tr.crouchEndedAt > JUMP.afterCrouchMs
    ) {
      tr.lastJump = t;
      events.push({ type: 'jump', id });
      if (!tr.airborne) {
        tr.airborne = true;
        tr.airStart = t;
        tr.peak = 0;
      }
    }
    if (tr.airborne) {
      tr.peak = Math.max(tr.peak, rise / T);
      const air = t - tr.airStart;
      if ((air > JUMP.minAirMs && rise < JUMP.landRise * T && vy >= 0) || air > JUMP.maxAirMs) {
        tr.airborne = false;
        events.push({ type: 'land', id, airTime: round(air / 1000, 3), height: round(tr.peak, 3) });
      }
    }
    tr.rise = tr.airborne ? Math.max(0, rise) : 0;

    // Balance: standing on one foot (the other ankle raised), with hysteresis.
    let bal: Side | null = null;
    if (ok(KP.leftAnkle, KP.rightAnkle) && !tr.crouching && !tr.airborne) {
      const lifts: Record<Side, number> = {
        left: k[KP.rightAnkle].y - k[KP.leftAnkle].y,
        right: k[KP.leftAnkle].y - k[KP.rightAnkle].y,
      };
      if (tr.balance && lifts[tr.balance] > 0.2 * T) bal = tr.balance;
      else bal = (['left', 'right'] as const).find((s) => lifts[s] > 0.35 * T) ?? null;
    }
    tr.balance = bal;

    // Standing height (camera-height fraction): ankle-to-nose when both are seen standing up,
    // else drifting towards an estimate from the torso.
    ankles = [KP.leftAnkle, KP.rightAnkle].filter((i) => k[i].score >= FEET.minScore);
    if (ankles.length && ok(KP.nose) && !tr.crouching && !tr.airborne) {
      const h = (Math.max(...ankles.map((i) => k[i].y)) - k[KP.nose].y) * NOSE_TO_HEIGHT;
      tr.height = tr.height ? tr.height * 0.9 + h * 0.1 : h;
    } else {
      const est = TA * HEIGHT_PER_TORSO;
      tr.height = tr.height ? tr.height + (est - tr.height) * 0.02 : est;
    }

    // Home spot (slowly follows them) for drift.
    const mx = tr.mx ?? tr.center.x;
    if (tr.home === null) tr.home = [mx, cy];
    else if (!tr.airborne) {
      const e = ease(DRIFT_TAU);
      tr.home[0] += (mx - tr.home[0]) * e;
      if (!tr.crouching) tr.home[1] += (cy - tr.home[1]) * e;
    }

    // Facing: front, side-on (shoulders narrow for the torso) or back (no face, shoulders
    // swapped or ears seen). Changes only after a few frames in a row.
    if (ok(KP.leftShoulder, KP.rightShoulder)) {
      const ls = k[KP.leftShoulder];
      const rs = k[KP.rightShoulder];
      const sw = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
      const ratio = sw / Math.max(TA, 0.02);
      if (ok(KP.leftHip, KP.rightHip)) tr.frontRatio = Math.max(tr.frontRatio * 0.999, ratio);
      const face = ok(KP.nose) || ok(KP.leftEye, KP.rightEye);
      const swapped = ls.x - rs.x > 0.2 * S;
      let cand: Facing = 'front';
      if (!face && (swapped || ok(KP.leftEar) || ok(KP.rightEar))) cand = 'back';
      else if (ratio < FACING.sideRatio * Math.max(tr.frontRatio, FACING.minFrontRatio)) cand = 'side';
      if (cand === tr.facing) tr.facingN = 0;
      else if (cand === tr.facingNext) {
        if (++tr.facingN >= FACING.frames) {
          tr.facing = cand;
          tr.facingN = 0;
        }
      } else {
        tr.facingNext = cand;
        tr.facingN = 1;
      }
    }

    // Distance from the camera: feet high in the picture = too far back; feet out of the
    // bottom (hips seen) = too close. Held while airborne (feet go up in a jump).
    if (tr.airborne) return;
    const lowest = ankles.length ? Math.max(...ankles.map((i) => k[i].y)) : null;
    tr.far = lowest !== null && (tr.far ? lowest < FEET.highClearY : lowest < FEET.highY);
    const hips = k[KP.leftHip].score >= FEET.minScore && k[KP.rightHip].score >= FEET.minScore;
    const close = hips && (lowest === null || lowest > FEET.edgeY);
    tr.distance = tr.far ? 'far' : close ? 'close' : 'ok';
  }

  /**
   * The body-relative hand cursor (see cursor.ts): only a hand raised above the hips points;
   * the pointing hand sticks until it drops or the other one is clearly higher; wrists that
   * look like someone else's are ignored; brief dropouts keep the cursor where it was.
   */
  private updateCursor(tr: Track, t: number, aspect: number, live: Track[]): void {
    const c = tr.cursor;
    const k = tr.keypoints;
    const r = measureReach(k, tr.armLength, aspect, tr.torsoAC || undefined);
    const others = live
      .filter((o) => o !== tr)
      .map((o) => ({
        x: (o.keypoints[KP.leftShoulder].x + o.keypoints[KP.rightShoulder].x) / 2,
        y: (o.keypoints[KP.leftShoulder].y + o.keypoints[KP.rightShoulder].y) / 2,
      }));
    const usable = (i: number) =>
      r !== null && k[i].score >= CURSOR.minScore && handRaised(r, k[i], i === c.hand) && !strayHand(r, k[i], others);
    const hands = [KP.leftWrist, KP.rightWrist].filter(usable);
    let hand: number | null = null;
    if (hands.length) {
      hand = hands.some((h) => h === c.hand) ? c.hand : hands.reduce((a, b) => (k[a].y < k[b].y ? a : b));
      // The other hand takes over only when it's clearly higher.
      for (const h of hands) if (h !== hand && r && k[h].y < k[hand!].y - CURSOR.switchMargin * r.T) hand = h;
    }
    if (hand === null || !r) {
      // A blink of lost tracking keeps the cursor; a lowered hand drops it.
      const dropped = c.hand !== null && k[c.hand].score >= CURSOR.minScore && r !== null && !handRaised(r, k[c.hand], true);
      if (dropped || t - c.seenAt > 250) {
        c.hand = null;
        c.pos = null;
      }
      return;
    }
    if (c.pos === null) {
      c.fx.reset();
      c.fy.reset();
    }
    c.hand = hand;
    c.seenAt = t;
    const p = reachToScreen(r, k[hand]);
    c.pos = { x: c.fx.filter(p.x, t), y: c.fy.filter(p.y, t) };
  }

  private packet(tr: Track, t: number, aspect: number): ServerPlayer {
    const seen = tr.lastSeen === t;
    const TA = Math.max(tr.torsoAC || tr.torso, 0.02);
    const vx = seen ? tr.cxf.velocity : 0;
    const vy = seen ? tr.cyf.velocity : 0;
    const mx = tr.mx ?? tr.center.x;
    const home = tr.home ?? [mx, tr.center.y];
    const c = tr.cursor;
    return {
      id: tr.id,
      since: tr.joinedAt,
      det: tr.det,
      kp: tr.keypoints.map((k) => [k.x, k.y, k.score, k.vx, k.vy, k.z, k.vz]),
      center: [tr.center.x, tr.center.y],
      bbox: [tr.bbox.x, tr.bbox.y, tr.bbox.w, tr.bbox.h],
      confidence: tr.confidence,
      body: { shoulder: tr.shoulderWidth, torso: TA, arm: tr.armLength, height: tr.height },
      motion: {
        vx,
        vy,
        dx: seen ? tr.dx : 0,
        speed: Math.hypot(vx * aspect, vy) / TA,
        drift: [((mx - home[0]) * aspect) / TA, (tr.center.y - home[1]) / TA],
      },
      facing: tr.facing,
      distance: tr.distance,
      pose: {
        handsUp: tr.handsUp,
        crouching: tr.crouching,
        crouchDepth: tr.crouchDepth,
        lean: tr.lean,
        leanAngle: tr.leanAngle,
        armsOut: tr.armsOut,
        run: tr.run,
        handsTogether: tr.handsTogether,
        balance: tr.balance,
      },
      jump: {
        airborne: tr.airborne,
        height: tr.rise / Math.max(tr.torso, 0.03),
        rise: tr.rise,
        airTime: tr.airborne ? (t - tr.airStart) / 1000 : 0,
        peak: tr.peak,
      },
      cursor: c.pos && c.hand !== null ? { x: c.pos.x, y: c.pos.y, hand: c.hand === KP.leftWrist ? 'left' : 'right' } : null,
    };
  }
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Players for games: tracked people (from the tracker, or tracked here from raw poses by a
 * PoseTracker) given seats (slots) and colours, as a Frame.
 *
 * Slots are a per-screen choice, so they live here, in the browser: a new player gets the
 * slot of the player who left last (the tracker hands the next joiner the leaver's id, so
 * they carry on with the same colour and score), else the lowest free one. On the
 * launcher's home screen (slotsByPosition) they're numbered left to right instead.
 */
export class PlayerTracker {
  /**
   * Number players left to right as they stand (P1 leftmost on screen), renumbering as they
   * move. Slots, and so colours, then follow positions: the launcher turns this on for its
   * home screen and off while a game runs, since games keep scores by slot.
   */
  slotsByPosition = false;
  /** Tracks raw poses for sources that don't track players themselves (the simulator). */
  readonly core: PoseTracker;
  /** Slot of each player present, by id. */
  private slots = new Map<number, number>();
  /** Places of players who left, for the next people to join. */
  private reserved: { id: number; slot: number }[] = [];
  /** When this page first had each player present (joinedAt is never earlier). */
  private seatedAt = new Map<number, number>();

  constructor(opts: TrackerOptions = {}) {
    this.core = new PoseTracker(opts);
  }

  /** Track raw poses here (the simulator, or an older tracker that sends only poses). */
  update(poses: RawPose[], t: number, aspect: number): Frame {
    return this.fromServer(this.core.update(poses, t, aspect), t);
  }

  /** Players tracked by the tracker (protocol v2) → a Frame. `t`: when it arrived (performance.now()). */
  fromServer(sf: ServerFrame, t: number): Frame {
    const events: GameEvent[] = [];
    const present = new Set(sf.players.map((p) => p.id));
    // Leave/join follow who's in the list, so they stay right across reconnects.
    for (const [id, slot] of this.slots) {
      if (present.has(id)) continue;
      this.slots.delete(id);
      this.seatedAt.delete(id);
      this.reserved.push({ id, slot });
      events.push({ type: 'leave', playerId: id, slot });
    }
    for (const p of sf.players) {
      if (this.slots.has(p.id)) continue;
      const slot = this.seat(p.id);
      this.slots.set(p.id, slot);
      this.seatedAt.set(p.id, t);
      events.push({ type: 'join', playerId: p.id, slot });
    }
    if (this.slotsByPosition) this.orderSlots(sf.players);
    for (const e of events) if (e.type === 'join') e.slot = this.slots.get(e.playerId) ?? e.slot;
    for (const e of sf.events) {
      if (e.type === 'join' || e.type === 'leave') continue;
      const slot = this.slots.get(e.id);
      if (slot === undefined) continue;
      const { id, ...rest } = e;
      events.push({ ...rest, playerId: id, slot } as GameEvent);
    }
    const players = sf.players
      .map((p) => toPlayer(p, this.slots.get(p.id)!, Math.max(t - (sf.t - p.since), this.seatedAt.get(p.id) ?? t)))
      .sort((a, b) => a.slot - b.slot);
    return { t, aspect: sf.aspect, players, events };
  }

  /** Forget everyone, including the places kept for people who left. */
  reset(): void {
    this.core.reset();
    this.slots.clear();
    this.seatedAt.clear();
    this.reserved = [];
  }

  /**
   * A newly joined player's slot: the one their id had when it left (the tracker gives a
   * leaver's id to the next person to join), else the lowest reserved slot that's free, else
   * the lowest free slot.
   */
  private seat(id: number): number {
    const taken = new Set(this.slots.values());
    let lowestFree = 0;
    while (taken.has(lowestFree)) lowestFree++;
    this.reserved.sort((a, b) => a.slot - b.slot);
    let i = this.reserved.findIndex((r) => r.id === id && !taken.has(r.slot));
    if (i < 0) i = this.reserved.findIndex((r) => !taken.has(r.slot));
    const slot = i >= 0 ? this.reserved.splice(i, 1)[0].slot : lowestFree;
    this.reserved = this.reserved.filter((r) => r.id !== id).slice(-2 * MAX_PLAYERS);
    return slot;
  }

  /** Players get slots 0..n-1 left to right. */
  private orderSlots(players: ServerPlayer[]): void {
    const order = [...players].sort((a, b) => this.slots.get(a.id)! - this.slots.get(b.id)!);
    // Swap neighbours only when clearly out of order, so two people standing one behind the
    // other don't flicker between numbers.
    for (let swapped = true; swapped; ) {
      swapped = false;
      for (let i = 0; i + 1 < order.length; i++) {
        if (order[i].center[0] > order[i + 1].center[0] + 0.05) {
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
          swapped = true;
        }
      }
    }
    order.forEach((p, i) => this.slots.set(p.id, i));
  }
}

/** A tracker player (protocol v2) as a game Player. */
function toPlayer(p: ServerPlayer, slot: number, joinedAt: number): Player {
  return {
    id: p.id,
    slot,
    color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
    keypoints: p.kp.map((a) => ({ x: a[0], y: a[1], score: a[2], vx: a[3], vy: a[4], z: a[5] ?? 0, vz: a[6] ?? 0 })),
    center: { x: p.center[0], y: p.center[1] },
    shoulderWidth: p.body.shoulder,
    armLength: p.body.arm,
    cursor: p.cursor && { x: p.cursor.x, y: p.cursor.y },
    cursorHand: p.cursor?.hand ?? null,
    bbox: { x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3] },
    joinedAt,
    pose: { ...p.pose },
    torso: p.body.torso,
    height: p.body.height,
    motion: { vx: p.motion.vx, vy: p.motion.vy, dx: p.motion.dx, speed: p.motion.speed, drift: { x: p.motion.drift[0], y: p.motion.drift[1] } },
    jump: { ...p.jump },
    facing: p.facing,
    distance: p.distance,
    confidence: p.confidence,
  };
}

/**
 * Feed a PlayerTracker from an input source and get Frames: players tracked by the tracker
 * itself (protocol v2) when the source sends them, else raw poses tracked here.
 */
export function trackSource(source: InputSource, tracker: PlayerTracker, cb: (frame: Frame) => void): void {
  source.onPoses((poses, t) => cb(tracker.update(poses, t, source.aspect)));
  source.onFrame?.((sf, t) => cb(tracker.fromServer(sf, t)));
}
