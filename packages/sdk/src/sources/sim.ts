import type { InputSource, RawPose } from '../types';

/**
 * Fake players for developing without a camera (or without kids!).
 *
 *  - Player 1's right hand follows the mouse.
 *  - Hold the mouse button: both hands follow the mouse.
 *  - Space: jump.   H: hold both hands up.
 *  - Extra players (?players=3) sway and wave on their own.
 */
const TEMPLATE: Array<[number, number]> = [
  [0, -0.42], // nose
  [-0.03, -0.45], // left eye  (screen space: player's left is screen left, like a mirror)
  [0.03, -0.45], // right eye
  [-0.06, -0.43], // left ear
  [0.06, -0.43], // right ear
  [-0.13, -0.28], // left shoulder
  [0.13, -0.28], // right shoulder
  [-0.18, -0.1], // left elbow
  [0.18, -0.1], // right elbow
  [-0.2, 0.06], // left wrist
  [0.2, 0.06], // right wrist
  [-0.09, 0.05], // left hip
  [0.09, 0.05], // right hip
  [-0.1, 0.3], // left knee
  [0.1, 0.3], // right knee
  [-0.1, 0.55], // left ankle
  [0.1, 0.55], // right ankle
];

export class SimSource implements InputSource {
  readonly name = 'sim';
  readonly aspect = 4 / 3;
  private cb: ((poses: RawPose[], t: number) => void) | null = null;
  private timer = 0;
  private mouse = { x: 0.6, y: 0.5, down: false };
  private jumpAt = -1e9;
  private handsUp = false;
  private present: boolean[];

  constructor(private count = 1) {
    this.present = Array.from({ length: count }, () => true);
  }

  /** Lets the launcher forward pointer positions from inside a game iframe. */
  setPointer(x: number, y: number, down?: boolean): void {
    if (!Number.isNaN(x)) this.mouse.x = x;
    if (!Number.isNaN(y)) this.mouse.y = y;
    if (down !== undefined) this.mouse.down = down;
  }

  /** Simulate a key press (also used when forwarded from a game iframe). */
  key(code: string, down: boolean): void {
    if (code === 'Space' && down) this.jumpAt = performance.now();
    if (code === 'KeyH') this.handsUp = down;
    // Digit1..4 toggles players in/out of frame, to test join/leave.
    const m = /^Digit([1-4])$/.exec(code);
    if (m && down) {
      const i = Number(m[1]) - 1;
      if (i < this.present.length) this.present[i] = !this.present[i];
    }
  }

  onPoses(cb: (poses: RawPose[], t: number) => void): void {
    this.cb = cb;
  }

  private onMove = (e: PointerEvent) => this.setPointer(e.clientX / innerWidth, e.clientY / innerHeight);
  private onDown = () => (this.mouse.down = true);
  private onUp = () => (this.mouse.down = false);
  private onKeyDown = (e: KeyboardEvent) => this.key(e.code, true);
  private onKeyUp = (e: KeyboardEvent) => this.key(e.code, false);

  async start(): Promise<void> {
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerdown', this.onDown);
    addEventListener('pointerup', this.onUp);
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    this.timer = window.setInterval(() => this.tick(), 1000 / 60);
  }

  stop(): void {
    clearInterval(this.timer);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
  }

  private tick(): void {
    const t = performance.now();
    const poses: RawPose[] = [];
    for (let i = 0; i < this.count; i++) {
      if (!this.present[i]) continue;
      poses.push(this.body(i, t));
    }
    this.cb?.(poses, t);
  }

  private body(i: number, t: number): RawPose {
    const s = 0.6; // body scale in normalised units
    const cx = (i + 1) / (this.count + 1) + Math.sin(t / 900 + i) * 0.01;
    const cy = 0.55;
    const pts = TEMPLATE.map(([dx, dy]) => ({ x: cx + dx * s, y: cy + dy * s }));

    if (i === 0) {
      const sh = (k: number) => pts[k];
      const reach = (wrist: number, elbow: number, shoulder: number, tx: number, ty: number) => {
        pts[wrist] = { x: tx, y: ty };
        pts[elbow] = {
          x: (sh(shoulder).x + tx) / 2 + (tx > sh(shoulder).x ? 0.03 : -0.03),
          y: (sh(shoulder).y + ty) / 2 + 0.03,
        };
      };
      reach(10, 8, 6, this.mouse.x, this.mouse.y);
      if (this.mouse.down) reach(9, 7, 5, this.mouse.x - 0.04, this.mouse.y);
      if (this.handsUp) {
        reach(9, 7, 5, pts[5].x - 0.03, pts[0].y - 0.12);
        reach(10, 8, 6, pts[6].x + 0.03, pts[0].y - 0.12);
      }
      // Jump: lift the whole body on a parabola.
      const jt = (t - this.jumpAt) / 450;
      if (jt >= 0 && jt <= 1) {
        const lift = 4 * jt * (1 - jt) * 0.12;
        pts.forEach((p) => (p.y -= lift));
      }
    } else {
      // Idle wave on alternating arms.
      const w = Math.sin(t / 300 + i * 2);
      const arm = i % 2 ? 10 : 9;
      const elbow = i % 2 ? 8 : 7;
      const dir = i % 2 ? 1 : -1;
      pts[arm] = { x: pts[elbow].x + dir * 0.05, y: pts[0].y - 0.05 + w * 0.05 };
    }

    // Back to UN-mirrored camera space, which is what real models produce.
    return pts.map((p) => ({ x: 1 - p.x, y: p.y, score: 0.95 }));
  }
}
