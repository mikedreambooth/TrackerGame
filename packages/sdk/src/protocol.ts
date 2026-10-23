import type { Distance, Facing, GameEvent, JumpState, Side } from './types';

/**
 * The tracker's per-frame message, protocol v2 (tracker/tracker.py; a page asks for it by
 * sending {"v": 2} on connect). The tracker does all player tracking: ids, smoothing, body
 * measures, gestures and hand cursors; the browser only adds slots, colours and the layout
 * (PlayerTracker.fromServer). The SDK's PoseTracker produces the same thing from raw poses,
 * for the simulator.
 *
 * Coordinates are MIRRORED (x = 1 - camera x), normalised 0..1, like Player keypoints.
 * Older trackers send v1 ({"aspect", "poses"}: raw, un-mirrored poses) and the browser
 * tracks players itself.
 */
export interface ServerFrame {
  v: 2;
  /** Tracker clock, ms, when the camera frame was taken. */
  t: number;
  /** Camera width / height. */
  aspect: number;
  /** Players (confirmed people), by id. */
  players: ServerPlayer[];
  /** Events in this frame, with player ids (join/leave too). */
  events: ServerEvent[];
  /** How many people the pose model found in this frame (joined or not). */
  detections?: number;
  /** About once a second: fps, timings, model. */
  stats?: Record<string, number | string>;
}

export interface ServerPlayer {
  /** Stable while they stay; a leaver's id goes to the next person to join. */
  id: number;
  /** Tracker ms when they joined. */
  since: number;
  /** Index of their detection in this frame (-1: not seen this frame, briefly lost). */
  det: number;
  /** 17 smoothed keypoints, COCO order: [x, y, score, vx, vy] (+ [z, vz] when the source has depth). */
  kp: number[][];
  /** Midpoint of shoulders and hips. */
  center: [number, number];
  /** Visible keypoints' box [x, y, w, h]. */
  bbox: [number, number, number, number];
  /** Mean keypoint confidence this frame. */
  confidence: number;
  body: {
    /** Shoulder width (normalised, not aspect-corrected: Player.shoulderWidth). */
    shoulder: number;
    /** Torso length, aspect-corrected (camera-height units). */
    torso: number;
    /** Arm length, camera-height units (Player.armLength). */
    arm: number;
    /** Standing height estimate, fraction of the camera height. */
    height: number;
  };
  motion: { vx: number; vy: number; dx: number; speed: number; drift: [number, number] };
  facing: Facing;
  distance: Distance;
  pose: {
    handsUp: boolean;
    crouching: boolean;
    crouchDepth: number;
    lean: -1 | 0 | 1;
    leanAngle: number;
    armsOut: boolean;
    run: number;
    handsTogether: boolean;
    balance: Side | null;
  };
  jump: JumpState;
  /** Hand cursor in screen fractions, or null when no hand is raised. */
  cursor: { x: number; y: number; hand: Side } | null;
}

type ServerEventOf<E> = E extends GameEvent ? Omit<E, 'playerId' | 'slot'> & { id: number } : never;

/** A GameEvent as the tracker sends it: the player's `id` instead of playerId/slot. */
export type ServerEvent = ServerEventOf<GameEvent>;
