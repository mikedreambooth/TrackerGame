/**
 * Core data types shared by the tracker, the launcher and every game.
 *
 * Coordinates are normalised to the camera frame: x and y run 0..1, with
 * (0,0) at the top-left of the SCREEN. The image is already mirrored, so when
 * a player moves their right hand to their right, it moves right on screen —
 * like looking in a mirror. Use `toScreen()` to map into canvas pixels.
 */

/** COCO-17 keypoint order. Model-agnostic: MediaPipe, YOLO-pose, MoveNet all map to this. */
export const KP = {
  nose: 0,
  leftEye: 1,
  rightEye: 2,
  leftEar: 3,
  rightEar: 4,
  leftShoulder: 5,
  rightShoulder: 6,
  leftElbow: 7,
  rightElbow: 8,
  leftWrist: 9,
  rightWrist: 10,
  leftHip: 11,
  rightHip: 12,
  leftKnee: 13,
  rightKnee: 14,
  leftAnkle: 15,
  rightAnkle: 16,
} as const;

export const KEYPOINT_COUNT = 17;

/** Bone list for drawing skeletons. */
export const BONES: ReadonlyArray<readonly [number, number]> = [
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

/** A raw keypoint straight from a model, in UN-mirrored camera space. */
export interface RawKeypoint {
  x: number;
  y: number;
  /**
   * Optional depth relative to the hips, roughly in x units; smaller = closer to
   * the camera. MediaPipe provides it (approximate); 2D-only models leave it out.
   */
  z?: number;
  /** Confidence / visibility 0..1. */
  score: number;
}

/** One detected person from one camera frame (17 keypoints, COCO order). */
export type RawPose = RawKeypoint[];

/** A smoothed keypoint in mirrored screen space, with velocity in units/second. */
export interface Keypoint {
  x: number;
  y: number;
  /** Depth (smaller = closer to the camera). 0 when the model gives no depth. Rough — use for big moves like punches. */
  z: number;
  score: number;
  vx: number;
  vy: number;
  /** Depth velocity per second; negative = moving towards the camera. */
  vz: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Which side, from the player's point of view (also screen side, since the view is mirrored). */
export type Side = 'left' | 'right';

/** Poses a player is holding right now. Read these every frame for "while holding" mechanics. */
export interface PoseState {
  handsUp: boolean;
  crouching: boolean;
  /** -1 leaning to screen-left, 0 upright, 1 leaning to screen-right. */
  lean: -1 | 0 | 1;
  /** Both arms stretched out to the sides (T-pose / aeroplane). */
  armsOut: boolean;
  /**
   * How hard they're running on the spot: knee movement in torso-lengths per
   * second, smoothed. Roughly 0 standing still, ~4 jogging, 8+ sprinting.
   * Falls back to arm pumping when knees are out of view.
   */
  run: number;
}

export interface Player {
  /**
   * Stable for as long as this person stays in view. Never shared by two people at once,
   * but when someone leaves, the next person to join takes over their id and slot (so a
   * game keyed by id or slot carries on: same colour, same score).
   */
  id: number;
  /** Seat 0..3. Decides colour and score slot; reused when someone leaves. */
  slot: number;
  color: string;
  keypoints: Keypoint[];
  /** Midpoint of shoulders and hips. */
  center: Vec2;
  /** Distance between shoulders — a handy per-player scale for gestures. */
  shoulderWidth: number;
  /**
   * Estimated arm length (shoulder → elbow → wrist), in units of the camera HEIGHT: x
   * distances are multiplied by `frame.aspect` first, so divide by the aspect for a
   * sideways distance in x units. The longest recently seen (a bent or foreshortened arm
   * reads short), slowly forgotten; estimated from the torso until an arm is seen.
   */
  armLength: number;
  /**
   * Where this player points, in screen fractions (0..1), or null when no hand is raised
   * above their hips. Body-relative, smoothed, with hysteresis — see `handCursor()`.
   */
  cursor: Vec2 | null;
  bbox: { x: number; y: number; w: number; h: number };
  /** ms timestamp this player joined. */
  joinedAt: number;
  /** Poses being held right now. */
  pose: PoseState;
  /**
   * Where the camera sees this player, before the layout (see PlayerLayout) moved and scaled
   * them: use for anything about the real room (e.g. how far back someone stands). Absent
   * when no layout ran (then the fields above are camera space).
   */
  raw?: PlayerRaw;
  /** How the layout placed this player: laid-out point = raw point × scale + (x, y). */
  transform?: PlayerTransform;
}

export interface PlayerRaw {
  keypoints: Keypoint[];
  center: Vec2;
  bbox: { x: number; y: number; w: number; h: number };
  shoulderWidth: number;
  armLength: number;
}

/** A uniform scale then a shift, in normalised coordinates. */
export interface PlayerTransform {
  scale: number;
  x: number;
  y: number;
}

interface Who {
  playerId: number;
  slot: number;
}

/** One-off moments, delivered once via game.on(type, ...). */
export type GameEvent =
  | ({ type: 'join' } & Who)
  | ({ type: 'leave' } & Who)
  | ({ type: 'jump' } & Who)
  /** Both hands went above the head. */
  | ({ type: 'handsUp' } & Who)
  /** Started crouching / squatting. */
  | ({ type: 'crouch' } & Who)
  /** Started leaning to one side. */
  | ({ type: 'lean'; direction: Side } & Who)
  /** Stretched both arms out to the sides. */
  | ({ type: 'armsOut' } & Who)
  /** Hands came together quickly. */
  | ({ type: 'clap' } & Who)
  /** An arm extended quickly (reads best punching to the side/diagonal, not straight at the camera). */
  | ({ type: 'punch'; hand: Side } & Who)
  /** A foot was raised quickly. */
  | ({ type: 'kick'; foot: Side } & Who);

export interface Frame {
  /** ms, performance.now() on the host. */
  t: number;
  /** Camera width / height, so games can preserve body proportions. */
  aspect: number;
  players: Player[];
  /** Events that happened since the previous frame. */
  events: GameEvent[];
  /**
   * The baseline (fraction of the screen height from the top) where players' feet are drawn
   * by default, set by the layout. Draw your ground here so players stand on it.
   */
  baseline?: number;
}

/** Anything that produces poses: the native tracker over WebSocket, or the simulator. */
export interface InputSource {
  readonly name: string;
  /** The default baseline, if the source sets one (the tracker's --baseline). */
  readonly baseline?: number;
  /** Camera aspect ratio (w/h). */
  readonly aspect: number;
  start(): Promise<void>;
  stop(): void;
  /** Called for every processed camera frame. */
  onPoses(cb: (poses: RawPose[], t: number) => void): void;
  /** Optional live stats for the debug view. */
  stats?(): Record<string, number | string>;
  /** Optional video element, for debug overlay / AR-style games. */
  video?: HTMLVideoElement;
  /** Optional latest camera image when there's no video element (e.g. from the native tracker). */
  preview?(): CanvasImageSource | null;
  /**
   * Optional: each person cut out of the camera picture (background transparent), for the
   * camera overlay. Calling it asks the source for them; stop calling and it stops making
   * them. Null until the first arrive (or if the source can't).
   */
  segmentation?(): Segmentation | null;
}

/** One person cut out of a camera frame. */
export interface Cutout {
  /** Their pixels, alpha 0 outside them; un-mirrored, upright. */
  image: CanvasImageSource;
  /** The area the image covers, 0..1 in UN-mirrored camera space (like RawKeypoint). */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Index of the matching pose in the poses of the same frame, or -1. */
  pose: number;
  /** Torso centre of that pose (un-mirrored), or null: shows which Player this is. */
  anchor: Vec2 | null;
}

export interface Segmentation {
  /** performance.now() when it arrived. */
  t: number;
  people: Cutout[];
}

export const PLAYER_COLORS = ['#ff4d6d', '#3a86ff', '#ffbe0b', '#2ec4b6'] as const;
export const MAX_PLAYERS = 4;
