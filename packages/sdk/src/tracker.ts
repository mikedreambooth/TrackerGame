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
  type RawPose,
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
}

interface Track {
  id: number;
  slot: number;
  confirmed: boolean;
  hits: number;
  lastSeen: number;
  joinedAt: number;
  fx: OneEuro[];
  fy: OneEuro[];
  keypoints: Keypoint[];
  center: Vec2;
  centerFilter: OneEuro;
  shoulderWidth: number;
  torso: number;
  bbox: Player['bbox'];
  handsUpArmed: boolean;
  lastJump: number;
}

const avg = (a: number, b: number) => (a + b) / 2;

/**
 * Turns raw per-frame detections into stable, smoothed players with IDs,
 * seats (slots), colours and high-level events (join/leave/jump/handsUp).
 *
 * Models give us an unordered list of people every frame; this is what makes
 * "Player 2" stay Player 2.
 */
export class PlayerTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private opts: Required<TrackerOptions>;

  constructor(opts: TrackerOptions = {}) {
    this.opts = {
      maxPlayers: opts.maxPlayers ?? MAX_PLAYERS,
      confirmFrames: opts.confirmFrames ?? 5,
      leaveAfterMs: opts.leaveAfterMs ?? 700,
      minKeypointScore: opts.minKeypointScore ?? 0.35,
      mirror: opts.mirror ?? true,
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
      const slot = this.freeSlot();
      if (slot === -1) return;
      const tr: Track = {
        id: this.nextId++,
        slot,
        confirmed: false,
        hits: 0,
        lastSeen: t,
        joinedAt: t,
        fx: Array.from({ length: KEYPOINT_COUNT }, () => new OneEuro()),
        fy: Array.from({ length: KEYPOINT_COUNT }, () => new OneEuro()),
        keypoints: Array.from({ length: KEYPOINT_COUNT }, () => ({ x: 0, y: 0, score: 0, vx: 0, vy: 0 })),
        center: c.center,
        centerFilter: new OneEuro(1.0, 0.5),
        shoulderWidth: c.shoulderWidth,
        torso: c.torso,
        bbox: c.bbox,
        handsUpArmed: true,
        lastJump: 0,
      };
      this.tracks.push(tr);
      this.updateTrack(tr, c, t);
    });

    // Confirm, detect gestures, expire.
    for (const tr of this.tracks) {
      if (!tr.confirmed && tr.hits >= this.opts.confirmFrames) {
        tr.confirmed = true;
        tr.joinedAt = t;
        events.push({ type: 'join', playerId: tr.id, slot: tr.slot });
      }
      if (tr.confirmed && tr.lastSeen === t) this.detectGestures(tr, t, events);
    }
    this.tracks = this.tracks.filter((tr) => {
      const alive = t - tr.lastSeen <= this.opts.leaveAfterMs;
      if (!alive && tr.confirmed) events.push({ type: 'leave', playerId: tr.id, slot: tr.slot });
      return alive;
    });

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
        bbox: { ...tr.bbox },
        joinedAt: tr.joinedAt,
      }));

    return { t, aspect, players, events };
  }

  reset(): void {
    this.tracks = [];
  }

  private freeSlot(): number {
    const taken = new Set(this.tracks.map((t) => t.slot));
    for (let s = 0; s < this.opts.maxPlayers; s++) if (!taken.has(s)) return s;
    return -1;
  }

  private prepare(raw: RawPose): Prepared | null {
    const min = this.opts.minKeypointScore;
    const kps = raw.slice(0, KEYPOINT_COUNT).map((k) => ({
      x: this.opts.mirror ? 1 - k.x : k.x,
      y: k.y,
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
        k.vx = tr.fx[i].velocity;
        k.vy = tr.fy[i].velocity;
        k.score = raw.score;
      } else {
        // Hold last position, fade confidence, kill velocity.
        k.score *= 0.8;
        k.vx = 0;
        k.vy = 0;
      }
    }
  }

  private detectGestures(tr: Track, t: number, events: GameEvent[]): void {
    const k = tr.keypoints;
    const ok = (i: number) => k[i].score >= this.opts.minKeypointScore;

    // Hands up: both wrists above the nose. Edge-triggered.
    if (ok(KP.leftWrist) && ok(KP.rightWrist) && ok(KP.nose)) {
      const up = k[KP.leftWrist].y < k[KP.nose].y && k[KP.rightWrist].y < k[KP.nose].y;
      if (up && tr.handsUpArmed) {
        tr.handsUpArmed = false;
        events.push({ type: 'handsUp', playerId: tr.id, slot: tr.slot });
      } else if (!up) {
        tr.handsUpArmed = true;
      }
    }

    // Jump: body centre moving up fast relative to body size.
    const vy = tr.centerFilter.velocity; // negative = up
    if (vy < -2.5 * tr.torso && t - tr.lastJump > 600) {
      tr.lastJump = t;
      events.push({ type: 'jump', playerId: tr.id, slot: tr.slot });
    }
  }
}

interface Prepared {
  kps: { x: number; y: number; score: number }[];
  center: Vec2;
  shoulderWidth: number;
  torso: number;
  bbox: Player['bbox'];
}
