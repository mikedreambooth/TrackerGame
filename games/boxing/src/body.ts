/**
 * Reads a real player's body into boxing controls:
 *  - bob   = head drops below its normal standing height, or a squat (pose.crouchDepth)
 *  - weave = head shifts sideways over the hips, or the torso tilts (pose.leanAngle)
 *  - guard = both hands up by the face
 *  - punch = SDK 'punch' events (sideways or straight at the camera via depth)
 *            plus any fast hand swing at head/chest height (hooks); faster = harder
 */
import { KP, type Player, type Side } from '@trackergame/sdk';
import type { Controls, Hand } from './fighter';

interface Baseline {
  noseY: number;
  centerX: number;
  lastSwing: Record<Side, number>;
}

export class BodyReader {
  private base = new Map<number, Baseline>();

  /** Drop a player's calibration (someone new may take over their id). */
  forget(id: number): void {
    this.base.delete(id);
  }

  /** Controls for this frame. `facing` decides which real hand is the lead hand. */
  read(p: Player, facing: 1 | -1, now: number, punchedWith: { hand: Side; speed?: number } | null): Controls {
    const k = p.keypoints;
    const ok = (i: number) => k[i].score > 0.35;
    const S = Math.max(p.shoulderWidth, 0.02);
    const T = S * 1.3;
    const hipsOk = ok(KP.leftHip) && ok(KP.rightHip);
    const hipX = hipsOk ? (k[KP.leftHip].x + k[KP.rightHip].x) / 2 : p.center.x;

    let b = this.base.get(p.id);
    if (!b) {
      b = { noseY: k[KP.nose].y, centerX: hipX, lastSwing: { left: -1e9, right: -1e9 } };
      this.base.set(p.id, b);
    }

    // Bob: how far the head has dropped (torso lengths). Standing height adapts slowly.
    const drop = (k[KP.nose].y - b.noseY) / T;
    if (Math.abs(drop) < 0.15) b.noseY += (k[KP.nose].y - b.noseY) * 0.03;
    else if (drop < 0) b.noseY += (k[KP.nose].y - b.noseY) * 0.2; // stood up taller
    else b.noseY += (k[KP.nose].y - b.noseY) * 0.004; // a mis-set baseline mustn't leave them ducked for good
    // A squat, graded by how bent the legs are (needs the ankles in view); older trackers: crouching or not.
    const ankles = ok(KP.leftAnkle) || ok(KP.rightAnkle);
    const squat = p.pose.crouchDepth !== undefined ? (ankles ? clamp((p.pose.crouchDepth - 0.3) / 0.35, 0, 1) : 0) : p.pose.crouching ? 1 : 0;
    const duck = Math.max(squat, clamp((drop - 0.12) / 0.3, 0, 1));

    // Weave: head over to one side of the hips, or the whole torso tilted.
    if (!hipsOk) b.centerX += (p.center.x - b.centerX) * 0.02;
    const shift = (k[KP.nose].x - (hipsOk ? hipX : b.centerX)) / S;
    const slip = Math.abs(shift) < 0.3 ? 0 : clamp((shift - Math.sign(shift) * 0.3) / 0.5, -1, 1);
    const a = p.pose.leanAngle ?? 0;
    const tilt = Math.sign(a) * clamp((Math.abs(a) - 0.12) / 0.3, 0, 1);
    const weave = Math.abs(tilt) > Math.abs(slip) ? tilt : slip;

    // Guard: both gloves near the face.
    const nearFace = (w: number) =>
      ok(w) && Math.hypot(k[w].x - k[KP.nose].x, k[w].y - k[KP.nose].y) < 1.0 * S && k[w].y > k[KP.nose].y - 0.6 * S;
    const guard = nearFace(KP.leftWrist) && nearFace(KP.rightWrist);

    // Punch: SDK event, or a fast hand swing (hook) at head/chest height.
    let hand: Side | null = punchedWith?.hand ?? null;
    let speed = punchedWith?.speed ?? 0;
    if (!hand) {
      for (const side of ['left', 'right'] as const) {
        const w = side === 'left' ? KP.leftWrist : KP.rightWrist;
        if (!ok(w)) continue;
        const v = Math.hypot(k[w].vx, k[w].vy, k[w].vz) / S;
        const hipY = hipsOk ? (k[KP.leftHip].y + k[KP.rightHip].y) / 2 : k[KP.nose].y + 2 * S;
        const height = k[w].y > k[KP.nose].y - 0.8 * S && k[w].y < hipY;
        if (v > 6 && height && now - b.lastSwing[side] > 380) {
          b.lastSwing[side] = now;
          hand = side;
          speed = v;
          break;
        }
      }
    } else b.lastSwing[hand] = now;

    // The lead hand is the one nearer the opponent on screen.
    const leadSide: Side = facing === 1 ? 'right' : 'left';
    const punch: Hand | undefined = hand ? (hand === leadSide ? 'lead' : 'rear') : undefined;
    // Power: a fast punch hits harder; an ordinary one (or one without a measured speed) hits normally.
    const power = clamp(0.85 + (speed - 5) * 0.06, 0.85, 1.35);
    return { duck, weave, guard, punch, power };
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
