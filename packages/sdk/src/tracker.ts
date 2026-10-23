import { CURSOR, handRaised, measureReach, reachToScreen, strayHand } from './cursor';
import { OneEuro } from './filters';
import {
  KEYPOINT_COUNT,
  KP,
  MAX_PLAYERS,
  PLAYER_COLORS,
  type Frame,
  type GameEvent,
  type Keypoint,
  type Player,
  type PoseState,
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
const smoothingFromUrl = () => typeof location === 'undefined' || new URLSearchParams(location.search).get('smooth') !== '0';

interface Track {
  /** 0 and -1 until confirmed: ids and slots are handed out when someone actually joins. */
  id: number;
  slot: number;
  confirmed: boolean;
  hits: number;
  lastSeen: number;
  joinedAt: number;
  fx: OneEuro[];
  fy: OneEuro[];
  fz: OneEuro[];
  keypoints: Keypoint[];
  center: Vec2;
  centerFilter: OneEuro;
  shoulderWidth: number;
  torso: number;
  bbox: Player['bbox'];
  lastJump: number;
  pose: PoseState;
  /** Torso length, aspect-corrected (camera-height units), for arm length and cursors. */
  torsoAC: number;
  /** Arm length as a multiple of the body scale (see measureArm). */
  armRatio: number;
  armLength: number;
  armAt: number;
  cursor: {
    hand: number | null;
    pos: Vec2 | null;
    fx: OneEuro;
    fy: OneEuro;
    /** When the pointing hand was last usable (brief dropouts keep the cursor). */
    seenAt: number;
  };
  /** Gesture bookkeeping (see detectGestures). */
  g: {
    legBase: number;
    crouchEndedAt: number;
    handsApartAt: number;
    lastClap: number;
    ext: Record<Side, { t: number; v: number }[]>;
    lastPunch: Record<Side, number>;
    lastKick: Record<Side, number>;
  };
}

const avg = (a: number, b: number) => (a + b) / 2;

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

/**
 * Turns raw per-frame detections into stable, smoothed players with IDs,
 * seats (slots), colours and high-level events (join/leave/jump/handsUp).
 *
 * Models give us an unordered list of people every frame; this is what makes
 * "Player 2" stay Player 2.
 */
export class PlayerTracker {
  /**
   * Number players left to right as they stand (P1 leftmost on screen), renumbering as they
   * move. Slots, and so colours, then follow positions: the launcher turns this on for its
   * home screen and off while a game runs, since games keep scores by slot.
   */
  slotsByPosition = false;
  private tracks: Track[] = [];
  private nextId = 1;
  /** Ids and slots of players who left, handed to the next people to join. */
  private reserved: { id: number; slot: number }[] = [];
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

  update(poses: RawPose[], t: number, aspect: number): Frame {
    const events: GameEvent[] = [];
    const candidates = poses
      .filter((p) => p.length >= KEYPOINT_COUNT)
      .map((p) => this.prepare(p))
      .filter((c): c is Prepared => c !== null);

    // Greedy nearest-centre matching. With ≤4 people this is as good as Hungarian.
    const pairs: { ti: number; ci: number; d: number }[] = [];
    this.tracks.forEach((tr, ti) =>
      candidates.forEach((c, ci) => {
        const d = Math.hypot(tr.center.x - c.center.x, tr.center.y - c.center.y);
        const gate = Math.max(0.12, tr.shoulderWidth * 2.5);
        if (d < gate) pairs.push({ ti, ci, d });
      }),
    );
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set<number>();
    const usedC = new Set<number>();
    for (const { ti, ci } of pairs) {
      if (usedT.has(ti) || usedC.has(ci)) continue;
      usedT.add(ti);
      usedC.add(ci);
      this.updateTrack(this.tracks[ti], candidates[ci], t);
    }

    // New people.
    candidates.forEach((c, ci) => {
      if (usedC.has(ci)) return;
      if (this.tracks.length >= this.opts.maxPlayers) return;
      const tr: Track = {
        id: 0,
        slot: -1,
        confirmed: false,
        hits: 0,
        lastSeen: t,
        joinedAt: t,
        fx: Array.from({ length: KEYPOINT_COUNT }, () => new OneEuro(1.5, 5, 1.0, this.opts.smoothing)),
        fy: Array.from({ length: KEYPOINT_COUNT }, () => new OneEuro(1.5, 5, 1.0, this.opts.smoothing)),
        // Depth is noisy: smooth it harder.
        fz: Array.from({ length: KEYPOINT_COUNT }, () => new OneEuro(1.0, 0.2, 1.0, this.opts.smoothing)),
        keypoints: Array.from({ length: KEYPOINT_COUNT }, () => ({ x: 0, y: 0, z: 0, score: 0, vx: 0, vy: 0, vz: 0 })),
        center: c.center,
        centerFilter: new OneEuro(1.0, 5, 1.0, this.opts.smoothing),
        shoulderWidth: c.shoulderWidth,
        torso: c.torso,
        bbox: c.bbox,
        lastJump: 0,
        pose: { handsUp: false, crouching: false, lean: 0, armsOut: false, run: 0 },
        torsoAC: 0,
        armRatio: ARM.initial,
        armLength: 0,
        armAt: 0,
        cursor: { hand: null, pos: null, fx: new OneEuro(1.0, 2, 1.0, this.opts.smoothing), fy: new OneEuro(1.0, 2, 1.0, this.opts.smoothing), seenAt: -1e9 },
        g: {
          legBase: 0,
          crouchEndedAt: -1e9,
          handsApartAt: -1e9,
          lastClap: -1e9,
          ext: { left: [], right: [] },
          lastPunch: { left: -1e9, right: -1e9 },
          lastKick: { left: -1e9, right: -1e9 },
        },
      };
      this.tracks.push(tr);
      this.updateTrack(tr, c, t);
    });

    // Confirm, detect gestures, expire.
    for (const tr of this.tracks) {
      if (!tr.confirmed && tr.hits >= this.opts.confirmFrames) {
        tr.confirmed = true;
        tr.joinedAt = t;
        this.seat(tr);
        events.push({ type: 'join', playerId: tr.id, slot: tr.slot });
      }
      if (tr.confirmed && tr.lastSeen === t) this.detectGestures(tr, t, events);
    }
    this.tracks = this.tracks.filter((tr) => {
      const alive = t - tr.lastSeen <= this.opts.leaveAfterMs;
      if (!alive && tr.confirmed) {
        events.push({ type: 'leave', playerId: tr.id, slot: tr.slot });
        this.reserved.push({ id: tr.id, slot: tr.slot });
      }
      return alive;
    });
    if (this.slotsByPosition) {
      this.orderSlots();
      const slotOf = new Map(this.tracks.map((tr) => [tr.id, tr.slot]));
      for (const e of events) if ('slot' in e) e.slot = slotOf.get(e.playerId) ?? e.slot;
    }
    const live = this.tracks.filter((tr) => tr.confirmed);
    for (const tr of live) {
      if (tr.lastSeen === t) this.measureArm(tr, t, aspect);
      this.updateCursor(tr, t, aspect, live);
    }

    const players: Player[] = this.tracks
      .filter((tr) => tr.confirmed)
      .sort((a, b) => a.slot - b.slot)
      .map((tr) => ({
        id: tr.id,
        slot: tr.slot,
        color: PLAYER_COLORS[tr.slot % PLAYER_COLORS.length],
        keypoints: tr.keypoints.map((k) => ({ ...k })),
        center: { ...tr.center },
        shoulderWidth: tr.shoulderWidth,
        armLength: tr.armLength,
        cursor: tr.cursor.pos && { ...tr.cursor.pos },
        bbox: { ...tr.bbox },
        joinedAt: tr.joinedAt,
        pose: { ...tr.pose },
      }));

    return { t, aspect, players, events };
  }

  /** Forget everyone, including the ids kept for people who left. */
  reset(): void {
    this.tracks = [];
    this.reserved = [];
    this.nextId = 1;
  }

  /**
   * Give a newly confirmed player an id and slot. Someone who left keeps their place: the
   * next person to join takes over their slot and id (lowest free reserved slot first), so
   * games keyed by id or slot carry on with the same colour and score. A brand-new id is
   * made only when nobody's place is waiting.
   */
  private seat(tr: Track): void {
    const taken = new Set(this.tracks.filter((o) => o !== tr && o.confirmed).map((o) => o.slot));
    let lowestFree = 0;
    while (taken.has(lowestFree)) lowestFree++;
    this.reserved.sort((a, b) => a.slot - b.slot);
    // Prefer a reserved place whose slot is still free; otherwise (slots were renumbered on the
    // home screen) still reuse the id, in the lowest free slot.
    const i = this.reserved.findIndex((r) => !taken.has(r.slot));
    const r = i >= 0 ? this.reserved.splice(i, 1)[0] : this.reserved.shift();
    tr.id = r ? r.id : this.nextId++;
    tr.slot = r && !taken.has(r.slot) ? r.slot : lowestFree;
  }

  /** Confirmed players get slots 0..n-1 left to right; people still joining get the rest. */
  private orderSlots(): void {
    const order = this.tracks.filter((tr) => tr.confirmed).sort((a, b) => a.slot - b.slot);
    // Swap neighbours only when clearly out of order, so two people standing one behind the
    // other don't flicker between numbers.
    for (let swapped = true; swapped; ) {
      swapped = false;
      for (let i = 0; i + 1 < order.length; i++) {
        if (order[i].center.x > order[i + 1].center.x + 0.05) {
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
          swapped = true;
        }
      }
    }
    order.forEach((tr, i) => (tr.slot = i));
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

  private prepare(raw: RawPose): Prepared | null {
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
    return { kps, center, shoulderWidth, torso, bbox };
  }

  private updateTrack(tr: Track, c: Prepared, t: number): void {
    tr.hits++;
    tr.lastSeen = t;
    tr.shoulderWidth = tr.shoulderWidth * 0.8 + c.shoulderWidth * 0.2;
    tr.torso = tr.torso * 0.8 + c.torso * 0.2;
    tr.bbox = c.bbox;
    const cy = tr.centerFilter.filter(c.center.y, t);
    tr.center = { x: c.center.x, y: cy };
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
    }
  }

  /**
   * Turns smoothed keypoints into poses (held) and events (moments). All
   * thresholds are relative to the player's own size — shoulder width S and
   * torso length T — so they work for small kids and adults, near or far.
   */
  private detectGestures(tr: Track, t: number, events: GameEvent[]): void {
    const k = tr.keypoints;
    const min = this.opts.minKeypointScore;
    const ok = (...ids: number[]) => ids.every((i) => k[i].score >= min);
    const who = { playerId: tr.id, slot: tr.slot };
    const S = Math.max(tr.shoulderWidth, 0.02);
    const T = Math.max(tr.torso, 0.03);
    const dist = (a: number, b: number) => Math.hypot(k[a].x - k[b].x, k[a].y - k[b].y);
    const pose = tr.pose;
    const g = tr.g;

    // Hands up: both wrists above the nose.
    if (ok(KP.leftWrist, KP.rightWrist, KP.nose)) {
      const up = k[KP.leftWrist].y < k[KP.nose].y && k[KP.rightWrist].y < k[KP.nose].y;
      if (up && !pose.handsUp) events.push({ type: 'handsUp', ...who });
      pose.handsUp = up;
    }

    // Crouch: legs (hip→ankle height) much shorter than this player's standing height.
    const ankles = [KP.leftAnkle, KP.rightAnkle].filter((i) => ok(i));
    if (ok(KP.leftHip, KP.rightHip) && ankles.length) {
      const hipY = (k[KP.leftHip].y + k[KP.rightHip].y) / 2;
      const ankleY = ankles.reduce((s, i) => s + k[i].y, 0) / ankles.length;
      const ratio = (ankleY - hipY) / T;
      if (!pose.crouching) g.legBase = Math.max(g.legBase * 0.998, ratio); // slowly forget
      if (!pose.crouching && g.legBase > 0 && ratio < g.legBase * 0.7) {
        pose.crouching = true;
        events.push({ type: 'crouch', ...who });
      } else if (pose.crouching && ratio > g.legBase * 0.85) {
        pose.crouching = false;
        g.crouchEndedAt = t;
      }
    }

    // Lean: torso tilted more than ~15° from upright (with hysteresis).
    if (ok(KP.leftShoulder, KP.rightShoulder, KP.leftHip, KP.rightHip)) {
      const dx = (k[KP.leftShoulder].x + k[KP.rightShoulder].x - k[KP.leftHip].x - k[KP.rightHip].x) / 2;
      const dy = (k[KP.leftHip].y + k[KP.rightHip].y - k[KP.leftShoulder].y - k[KP.rightShoulder].y) / 2;
      const angle = Math.atan2(dx, Math.max(dy, 1e-3));
      let lean: -1 | 0 | 1 = pose.lean;
      if (angle < -0.26) lean = -1;
      else if (angle > 0.26) lean = 1;
      else if (Math.abs(angle) < 0.17) lean = 0;
      if (lean !== 0 && lean !== pose.lean) events.push({ type: 'lean', direction: lean < 0 ? 'left' : 'right', ...who });
      pose.lean = lean;
    }

    // Arms out: both wrists well out to the sides, roughly at shoulder height.
    if (ok(KP.leftShoulder, KP.rightShoulder, KP.leftWrist, KP.rightWrist)) {
      const lw = k[KP.leftWrist];
      const rw = k[KP.rightWrist];
      const ls = k[KP.leftShoulder];
      const rs = k[KP.rightShoulder];
      const out =
        lw.x < ls.x - 1.1 * S && rw.x > rs.x + 1.1 * S && Math.abs(lw.y - ls.y) < 0.7 * S && Math.abs(rw.y - rs.y) < 0.7 * S;
      if (out && !pose.armsOut) events.push({ type: 'armsOut', ...who });
      pose.armsOut = out;
    }

    // Clap: wrists were apart moments ago and are now together, in front of the body.
    if (ok(KP.leftWrist, KP.rightWrist, KP.leftHip, KP.rightHip)) {
      const d = dist(KP.leftWrist, KP.rightWrist);
      const aboveHips = Math.max(k[KP.leftWrist].y, k[KP.rightWrist].y) < Math.min(k[KP.leftHip].y, k[KP.rightHip].y);
      // Claps happen at chest height; hands meeting up by the face is a boxing guard.
      const handsY = (k[KP.leftWrist].y + k[KP.rightWrist].y) / 2;
      const belowFace = !ok(KP.nose) || handsY > k[KP.nose].y + 0.6 * S;
      if (d > 1.0 * S) g.handsApartAt = t;
      else if (d < 0.4 * S && aboveHips && belowFace && t - g.handsApartAt < 500 && t - g.lastClap > 400) {
        g.lastClap = t;
        events.push({ type: 'clap', ...who });
      }
    }

    // Punch: an arm goes from bent to extended fast.
    const arms: [Side, number, number, number][] = [
      ['left', KP.leftShoulder, KP.leftWrist, KP.rightWrist],
      ['right', KP.rightShoulder, KP.rightWrist, KP.leftWrist],
    ];
    for (const [side, sh, wr, otherWr] of arms) {
      if (!ok(sh, wr)) continue;
      const hist = g.ext[side];
      // 3D when the model gives depth, so punches straight at the camera count too.
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
      if (ext > 1.2 && bent < 0.75 && speed > 3 * S && shoulderHeight && oneArm && t - g.lastPunch[side] > 350) {
        g.lastPunch[side] = t;
        hist.length = 0;
        events.push({ type: 'punch', hand: side, ...who });
      }
    }

    // Kick: one ankle raised well above the other, moving up fast.
    const legs: [Side, number, number][] = [
      ['left', KP.leftAnkle, KP.rightAnkle],
      ['right', KP.rightAnkle, KP.leftAnkle],
    ];
    for (const [side, ankle, other] of legs) {
      if (!ok(ankle, other) || pose.crouching) continue;
      const lift = k[other].y - k[ankle].y;
      if (lift > 0.5 * T && k[ankle].vy < -2 * T && t - g.lastKick[side] > 500) {
        g.lastKick[side] = t;
        events.push({ type: 'kick', foot: side, ...who });
      }
    }

    // Run effort: how fast the knees (or, failing that, wrists) pump up and down.
    let effort = 0;
    if (ok(KP.leftKnee, KP.rightKnee)) effort = (Math.abs(k[KP.leftKnee].vy) + Math.abs(k[KP.rightKnee].vy)) / T;
    else if (ok(KP.leftWrist, KP.rightWrist)) effort = (0.7 * (Math.abs(k[KP.leftWrist].vy) + Math.abs(k[KP.rightWrist].vy))) / T;
    pose.run += (effort - pose.run) * 0.08;

    // Jump: body centre moving up fast. Ignored just after standing up from a crouch.
    const vy = tr.centerFilter.velocity; // negative = up
    if (vy < -2.5 * T && t - tr.lastJump > 600 && !pose.crouching && t - g.crouchEndedAt > 700) {
      tr.lastJump = t;
      events.push({ type: 'jump', ...who });
    }
  }
}

interface Prepared {
  kps: { x: number; y: number; z: number; score: number }[];
  center: Vec2;
  shoulderWidth: number;
  torso: number;
  bbox: Player['bbox'];
}
