import type { InputSource, RawPose } from '../types';

/**
 * Fake players for developing without a camera (or without kids!).
 *
 *  - Mouse: player 1's right hand follows it; hold the button for both hands.
 *  - Touch: first finger = right hand, second finger = left hand.
 *  - On-screen buttons (or keys): Hands up (H, hold), Jump (Space).
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

export type SimPointerPhase = 'down' | 'move' | 'up';

/** A pointer event in screen fractions (0..1), as forwarded from a game iframe. */
export interface SimPointer {
  id: number;
  phase: SimPointerPhase;
  x: number;
  y: number;
  pointerType: string;
}

export class SimSource implements InputSource {
  readonly name = 'sim';
  readonly aspect = 4 / 3;
  private cb: ((poses: RawPose[], t: number) => void) | null = null;
  private timer = 0;
  /** Player 1's hand targets, in camera space (mirrored). */
  private right = { x: 0.6, y: 0.5 };
  private left: { x: number; y: number } | null = null;
  private mouseDown = false;
  /** Active touches in arrival order: first = right hand, second = left hand. */
  private touches = new Map<number, { x: number; y: number }>();
  private jumpAt = -1e9;
  private handsUp = false;
  private present: boolean[];
  private controls: HTMLElement | null = null;

  constructor(
    private count = 1,
    /** Show on-screen Hands up / Jump buttons (for touch screens). */
    private showControls = true,
  ) {
    this.present = Array.from({ length: count }, () => true);
  }

  /**
   * Feed a pointer event (screen fractions 0..1). Mouse: hovering moves the right
   * hand, holding the button brings the left hand too. Touch: first finger is the
   * right hand, a second finger is the left hand.
   */
  pointer(e: SimPointer): void {
    const pos = this.toCamera(e.x, e.y);
    if (e.pointerType === 'mouse') {
      if (e.phase === 'down') this.mouseDown = true;
      if (e.phase === 'up') this.mouseDown = false;
      this.right = pos;
      this.left = this.mouseDown ? { x: pos.x - 0.04, y: pos.y } : null;
      return;
    }
    if (e.phase === 'down') this.touches.set(e.id, pos);
    else if (e.phase === 'move' && this.touches.has(e.id)) this.touches.set(e.id, pos);
    else if (e.phase === 'up') this.touches.delete(e.id);
    const [first, second] = [...this.touches.values()];
    if (first) this.right = first; // the right hand stays put when the finger lifts
    this.left = second ?? null;
  }

  /** Simulate a key press (also used for the on-screen buttons and from game iframes). */
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

  /** Screen fraction → camera-space (mirrored) position, undoing the "cover" fit games use. */
  private toCamera(fx: number, fy: number) {
    const w = innerWidth;
    const h = innerHeight;
    const k = Math.max(w / this.aspect, h);
    const ox = (w - this.aspect * k) / 2;
    const oy = (h - k) / 2;
    return { x: (fx * w - ox) / (this.aspect * k), y: (fy * h - oy) / k };
  }

  private onPointer = (phase: SimPointerPhase) => (e: PointerEvent) =>
    this.pointer({
      id: e.pointerId,
      phase,
      x: e.clientX / innerWidth,
      y: e.clientY / innerHeight,
      pointerType: e.pointerType,
    });
  private onDown = this.onPointer('down');
  private onMove = this.onPointer('move');
  private onUp = this.onPointer('up');
  private onKeyDown = (e: KeyboardEvent) => this.key(e.code, true);
  private onKeyUp = (e: KeyboardEvent) => this.key(e.code, false);

  async start(): Promise<void> {
    // Stop touches from scrolling/zooming the page instead of moving hands.
    document.documentElement.style.touchAction = 'none';
    addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    addEventListener('pointercancel', this.onUp);
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    if (this.showControls) this.controls = this.makeControls();
    this.timer = window.setInterval(() => this.tick(), 1000 / 60);
  }

  stop(): void {
    clearInterval(this.timer);
    removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointercancel', this.onUp);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    this.controls?.remove();
  }

  /** Floating buttons for the gestures a finger can't do. */
  private makeControls(): HTMLElement {
    const box = document.createElement('div');
    box.setAttribute(
      'style',
      'position:fixed;left:12px;bottom:12px;z-index:2147483647;display:flex;gap:10px;align-items:center;' +
        'font:600 14px system-ui,sans-serif;color:#fff;user-select:none;-webkit-user-select:none;touch-action:none',
    );
    const button = (label: string, title: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute(
        'style',
        'min-width:64px;height:64px;padding:0 14px;border-radius:32px;border:3px solid #fff;white-space:nowrap;' +
          'background:rgba(20,10,50,.65);color:#fff;font:700 16px system-ui,sans-serif;touch-action:none',
      );
      // Don't let button presses also move a hand.
      for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        b.addEventListener(ev, (e) => e.stopPropagation());
      }
      box.append(b);
      return b;
    };
    const hands = button('🙌 Hands up', 'Hold to raise both hands (H)');
    hands.addEventListener('pointerdown', (e) => {
      hands.setPointerCapture(e.pointerId);
      this.key('KeyH', true);
    });
    const release = () => this.key('KeyH', false);
    hands.addEventListener('pointerup', release);
    hands.addEventListener('pointercancel', release);
    const jump = button('⤒ Jump', 'Jump (Space)');
    jump.addEventListener('pointerdown', () => this.key('Space', true));
    const hint = document.createElement('span');
    hint.textContent = 'Sim: drag = right hand, 2nd finger = left';
    hint.setAttribute('style', 'background:rgba(0,0,0,.5);padding:6px 10px;border-radius:8px;opacity:.85;max-width:40vw');
    box.append(hint);
    document.body.append(box);
    return box;
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
    // Spread players across the part of the camera image that's actually on screen
    // (on a portrait phone, "cover" fitting crops the sides a lot).
    const a = this.toCamera(0, 0);
    const b = this.toCamera(1, 1);
    const x0 = Math.max(0, a.x) + 0.08;
    const x1 = Math.min(1, b.x) - 0.08;
    const cx = x0 + ((x1 - x0) * (i + 1)) / (this.count + 1) + Math.sin(t / 900 + i) * 0.01;
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
      reach(10, 8, 6, this.right.x, this.right.y);
      if (this.left) reach(9, 7, 5, this.left.x, this.left.y);
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
