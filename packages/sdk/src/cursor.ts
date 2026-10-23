import { KP, type Keypoint, type Vec2 } from './types';

/**
 * Body-relative hand cursors: how a raised hand becomes a point on the screen.
 *
 * The PlayerTracker runs this every frame (with smoothing and hysteresis) and puts the
 * result on `player.cursor`; `handCursor()` reads it. Everything is measured in units of
 * the camera HEIGHT, with x distances multiplied by the camera aspect first, so a reach
 * is the same length in every direction.
 */
export const CURSOR = {
  /** Wrists below this confidence don't point. */
  minScore: 0.4,
  /** A hand starts pointing once the wrist is this far above the hips (torso lengths)… */
  raiseOn: 0.15,
  /** …and keeps pointing until it drops this far above them (hysteresis). */
  raiseOff: 0,
  /** Top of the screen: shoulders minus this much of the arm length (1 = hand straight up). */
  topReach: 0.9,
  /** Screen edges: this much of the arm's sideways reach at that height, plus half the shoulders. */
  sideReach: 0.9,
  /** Sideways reach never counts as less than this many arm lengths (near the waist and overhead). */
  minSideReach: 0.55,
  /** The other hand takes over only when it's higher by this many torso lengths. */
  switchMargin: 0.3,
  /** Ignore a wrist that's closer to someone else's shoulders than this fraction of its distance to its own. */
  otherBodyRatio: 0.6,
  /** Ignore a wrist further than this many arm lengths from its own shoulder (it belongs to somebody else). */
  maxReach: 1.5,
};

/** A player's body measurements for cursor mapping (camera-height units). */
export interface Reach {
  aspect: number;
  /** Shoulder midpoint (normalised camera coordinates). */
  shoulder: Vec2;
  /** Hip midpoint height (normalised); estimated from the torso when hips aren't seen. */
  waistY: number;
  /** Shoulder width, torso length and arm length, aspect-corrected. */
  S: number;
  T: number;
  A: number;
}

const ok = (k: Keypoint, min = 0.35) => k.score >= min;

/**
 * Measures a player (their keypoints) for cursor mapping. `armLength` and `torso` fall back to
 * estimates from the body when not given (e.g. a Player built by hand, not by the tracker).
 */
export function measureReach(k: Keypoint[], armLength: number | undefined, aspect: number, torso?: number): Reach | null {
  const ls = k[KP.leftShoulder];
  const rs = k[KP.rightShoulder];
  if (!ok(ls, 0.2) || !ok(rs, 0.2)) return null;
  const shoulder = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const S = Math.max(Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y), 0.02);
  const lh = k[KP.leftHip];
  const rh = k[KP.rightHip];
  let T = torso ?? 1.4 * S;
  let waistY = shoulder.y + T;
  if (ok(lh) && ok(rh)) {
    const hip = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    waistY = hip.y;
    if (torso === undefined) T = Math.max(Math.hypot((hip.x - shoulder.x) * aspect, hip.y - shoulder.y), 0.5 * S);
  }
  T = Math.max(T, 0.02);
  const A = armLength && armLength > 0 ? armLength : 1.25 * Math.max(T, S);
  return { aspect, shoulder, waistY, S, T, A };
}

/** Is this wrist raised high enough to point? `active`: it already is (uses the lower release height). */
export function handRaised(r: Reach, wrist: Vec2, active = false): boolean {
  return wrist.y < r.waistY - (active ? CURSOR.raiseOff : CURSOR.raiseOn) * r.T;
}

/**
 * Maps a wrist to screen fractions (0..1, clamped).
 * Vertical: from just above the hips (bottom of the screen) to the top of the player's
 * reach (top of the screen). Horizontal: centred on their shoulders, spanning how far
 * their arm reaches sideways at that height, so short and tall players both reach every
 * corner without walking.
 */
export function reachToScreen(r: Reach, wrist: Vec2): Vec2 {
  const bottom = r.waistY - CURSOR.raiseOn * r.T;
  const top = r.shoulder.y - CURSOR.topReach * r.A;
  const y = (wrist.y - top) / Math.max(bottom - top, 1e-3);
  // Sideways reach at this height: the arm swings in a circle round the shoulder.
  const dy = Math.min(Math.abs(wrist.y - r.shoulder.y) / r.A, 1);
  const side = Math.max(CURSOR.minSideReach, CURSOR.sideReach * Math.sqrt(1 - dy * dy));
  const half = side * r.A + r.S / 2;
  const x = 0.5 + ((wrist.x - r.shoulder.x) * r.aspect) / (2 * half);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { x: clamp(x), y: clamp(y) };
}

/**
 * Should this wrist be ignored? True when it's implausibly far from its own shoulders or
 * clearly closer to another player's shoulders (`others`: their shoulder midpoints) than to
 * its own — usually a hand the model gave to the wrong person when people stand close.
 */
export function strayHand(r: Reach, wrist: Vec2, others: Vec2[]): boolean {
  const d = (a: Vec2, b: Vec2) => Math.hypot((a.x - b.x) * r.aspect, a.y - b.y);
  const own = d(wrist, r.shoulder);
  if (own > CURSOR.maxReach * r.A) return true;
  return others.some((c) => d(wrist, c) < CURSOR.otherBodyRatio * own);
}
