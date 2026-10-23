/**
 * Reads a real player's body into duel controls. Everything is measured in
 * shoulder widths, so it works for any size of person at any distance.
 *
 *  - arms   = each wrist relative to its shoulder, turned side-on: how far the
 *             hand is out from the body becomes "forward", its height stays height.
 *  - shield = LEFT wrist height between shoulders and hips:
 *             chest-height or above → high; belly/waist → low; hanging by the hip → none.
 *  - duck   = head drops below its normal standing height, or a squat (pose.crouchDepth).
 *  - attack = a fast RIGHT-hand movement (wrist speed in shoulder widths per second),
 *             classified by where the hand is when the swing starts:
 *             above the chest → high slash; down by the waist → low slash;
 *             chest height moving sideways (or straight at the camera) → thrust,
 *             chest height chopping downwards → low. Lifting the sword up is a
 *             wind-up, not a swing.
 */
import { KP, type Player } from '@trackergame/sdk';
import { REST_SHIELD, REST_SWORD, type Arm, type Attack, type Controls, type ShieldLevel } from './fighter';

/** Wrist speed (shoulder widths per second) that counts as a swing. */
const SWING_SPEED = 5.5;
const SWING_GAP_MS = 450;

interface Baseline {
  noseY: number;
  lastSwing: number;
}

export interface Reading extends Controls {
  /** Debug: right-hand speed in shoulder widths per second. */
  speed: number;
}

export class BodyReader {
  private base = new Map<number, Baseline>();

  /** Drop a player's calibration (someone new may take over their id). */
  forget(id: number): void {
    this.base.delete(id);
  }

  read(p: Player, now: number): Reading {
    const k = p.keypoints;
    const ok = (i: number) => k[i].score > 0.35;
    const S = Math.max(p.shoulderWidth, 0.02);
    const shY = (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2;
    const hipsOk = ok(KP.leftHip) && ok(KP.rightHip);
    const hipY = hipsOk ? (k[KP.leftHip].y + k[KP.rightHip].y) / 2 : shY + 1.4 * S;
    const torso = Math.max(hipY - shY, 0.6 * S);

    let b = this.base.get(p.id);
    if (!b) {
      b = { noseY: k[KP.nose].y, lastSwing: -1e9 };
      this.base.set(p.id, b);
    }

    // Duck: how far the head has dropped (torso lengths). Standing height adapts slowly.
    const drop = (k[KP.nose].y - b.noseY) / torso;
    if (Math.abs(drop) < 0.15) b.noseY += (k[KP.nose].y - b.noseY) * 0.03;
    else if (drop < 0) b.noseY += (k[KP.nose].y - b.noseY) * 0.2; // stood up taller
    else b.noseY += (k[KP.nose].y - b.noseY) * 0.004; // a mis-set baseline mustn't leave them ducked for good
    // A squat, graded by how bent the legs are (needs the ankles in view); older trackers: crouching or not.
    const ankles = ok(KP.leftAnkle) || ok(KP.rightAnkle);
    const squat = p.pose.crouchDepth !== undefined ? (ankles ? clamp((p.pose.crouchDepth - 0.3) / 0.35, 0, 1) : 0) : p.pose.crouching ? 1 : 0;
    const duck = Math.max(squat, clamp((drop - 0.12) / 0.3, 0, 1));

    // Arms, side-on. The player's left hand is on screen-left (the view is mirrored).
    const arm = (wrist: number, shoulder: number, outSign: 1 | -1, rest: Arm): Arm => {
      if (!ok(wrist) || !ok(shoulder)) return { ...rest };
      const out = ((k[wrist].x - k[shoulder].x) * outSign) / S;
      const down = (k[wrist].y - k[shoulder].y) / S;
      // A hand in front of the chest (out < 0) or out to the side both read as "forward".
      let fwd = 0.35 + Math.abs(out + 0.15) * 0.8;
      let d = down;
      const len = Math.hypot(fwd, d);
      if (len > 1.9) {
        fwd *= 1.9 / len;
        d *= 1.9 / len;
      }
      return { fwd, down: d };
    };
    const shieldArm = arm(KP.leftWrist, KP.leftShoulder, -1, REST_SHIELD);
    const swordArm = arm(KP.rightWrist, KP.rightShoulder, 1, REST_SWORD);

    // Shield level from the left wrist's height down the torso (0 = shoulders, 1 = hips).
    let shield: ShieldLevel = null;
    if (ok(KP.leftWrist)) {
      const f = (k[KP.leftWrist].y - shY) / torso;
      shield = f < 0.3 ? 'high' : f < 0.9 ? 'low' : null;
    }

    // Sword: a fast right-hand movement.
    let attack: Attack | undefined;
    let speed = 0;
    const w = k[KP.rightWrist];
    if (ok(KP.rightWrist)) {
      const flat = Math.hypot(w.vx, w.vy) / S;
      const depth = -w.vz / S; // towards the camera
      speed = Math.max(flat, depth);
      // Lifting the sword up to get ready (mostly upwards) isn't a swing.
      const liftingUp = w.vy < 0 && -w.vy > Math.abs(w.vx) * 1.2 && depth < flat;
      if (speed > SWING_SPEED && !liftingUp && now - b.lastSwing > SWING_GAP_MS) {
        b.lastSwing = now;
        const f = (w.y - shY) / torso;
        if (depth > flat) attack = 'thrust';
        else if (f < 0.1) attack = 'high';
        else if (f > 0.65) attack = 'low';
        else if (Math.abs(w.vx) <= 1.3 * Math.abs(w.vy)) attack = 'low';
        // Sideways at chest height: pushing the hand out is a thrust; pulling it back in isn't.
        else if (w.vx > 0) attack = 'thrust';
        else b.lastSwing = -1e9;
      }
    }
    return { duck, shieldArm, swordArm, shield, attack, speed };
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
