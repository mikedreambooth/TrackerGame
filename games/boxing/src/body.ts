/**
 * Reads a real player's body into boxing controls:
 *  - bob   = head drops below its normal standing height (or crouch)
 *  - weave = head shifts sideways over the hips (slip left/right)
 *  - guard = both hands up by the face
 *  - punch = SDK 'punch' events (sideways or straight at the camera via depth)
 *            plus any fast hand swing at head/chest height (hooks)
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

  /** Controls for this frame. `facing` decides which real hand is the lead hand. */
  read(p: Player, facing: 1 | -1, now: number, punchedWith: Side | null): Controls {
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
    const duck = p.pose.crouching ? 1 : clamp((drop - 0.12) / 0.3, 0, 1);

    // Weave: head over to one side of the hips.
    if (!hipsOk) b.centerX += (p.center.x - b.centerX) * 0.02;
    const shift = (k[KP.nose].x - (hipsOk ? hipX : b.centerX)) / S;
    const weave = Math.abs(shift) < 0.3 ? 0 : clamp((shift - Math.sign(shift) * 0.3) / 0.5, -1, 1);

    // Guard: both gloves near the face.
    const nearFace = (w: number) =>
      ok(w) && Math.hypot(k[w].x - k[KP.nose].x, k[w].y - k[KP.nose].y) < 1.0 * S && k[w].y > k[KP.nose].y - 0.6 * S;
    const guard = nearFace(KP.leftWrist) && nearFace(KP.rightWrist);

    // Punch: SDK event, or a fast hand swing (hook) at head/chest height.
    let hand: Side | null = punchedWith;
    if (!hand) {
      for (const side of ['left', 'right'] as const) {
        const w = side === 'left' ? KP.leftWrist : KP.rightWrist;
        if (!ok(w)) continue;
        const speed = Math.hypot(k[w].vx, k[w].vy, k[w].vz) / S;
        const hipY = hipsOk ? (k[KP.leftHip].y + k[KP.rightHip].y) / 2 : k[KP.nose].y + 2 * S;
        const height = k[w].y > k[KP.nose].y - 0.8 * S && k[w].y < hipY;
        if (speed > 6 && height && now - b.lastSwing[side] > 380) {
          b.lastSwing[side] = now;
          hand = side;
          break;
        }
      }
    } else b.lastSwing[hand] = now;

    // The lead hand is the one nearer the opponent on screen.
    const leadSide: Side = facing === 1 ? 'right' : 'left';
    const punch: Hand | undefined = hand ? (hand === leadSide ? 'lead' : 'rear') : undefined;
    return { duck, weave, guard, punch };
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
