import { lockTouchGestures } from '../touch';
import type { InputSource, RawPose } from '../types';

/**
 * Fake players for developing without a camera (or without kids!).
 *
 *  - Mouse: player 1's right hand follows it; hold the button for both hands.
 *  - Touch: first finger = right hand, second finger = left hand.
 *  - On-screen buttons (or keys): Hands up (H, hold), Jump (Space), and under
 *    "Moves": Crouch (C, hold), Lean (←/→, hold), T-pose (T, hold), Clap (X),
 *    Punch (P), Kick (K), Run on the spot (R, hold), Guard up (G, hold),
 *    Jab straight at the camera (J — uses depth, like MediaPipe gives).
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
  private clapAt = -1e9;
  private punchAt = -1e9;
  private kickAt = -1e9;
  private handsUp = false;
  private crouch = false;
  private leanDir: -1 | 0 | 1 = 0;
  private armsOut = false;
  private running = false;
  private guard = false;
  private jabAt = -1e9;
  /** Eased 0..1 / -1..1 amounts so held poses move smoothly, like a real body. */
  private crouchAmt = 0;
  private leanAmt = 0;
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
    const now = performance.now();
    if (code === 'Space' && down) this.jumpAt = now;
    if (code === 'KeyX' && down) this.clapAt = now;
    if (code === 'KeyP' && down) this.punchAt = now;
    if (code === 'KeyK' && down) this.kickAt = now;
    if (code === 'KeyH') this.handsUp = down;
    if (code === 'KeyC') this.crouch = down;
    if (code === 'KeyT') this.armsOut = down;
    if (code === 'KeyR') this.running = down;
    if (code === 'KeyG') this.guard = down;
    if (code === 'KeyJ' && down) this.jabAt = now;
    if (code === 'ArrowLeft') this.leanDir = down ? -1 : this.leanDir === -1 ? 0 : this.leanDir;
    if (code === 'ArrowRight') this.leanDir = down ? 1 : this.leanDir === 1 ? 0 : this.leanDir;
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
    lockTouchGestures();
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
      'position:fixed;left:12px;bottom:12px;right:12px;z-index:2147483647;display:flex;flex-direction:column;' +
        'gap:8px;align-items:flex-start;pointer-events:none;' +
        'font:600 14px system-ui,sans-serif;color:#fff;user-select:none;-webkit-user-select:none;touch-action:none',
    );
    const row = () => {
      const r = document.createElement('div');
      r.setAttribute('style', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;pointer-events:none');
      return r;
    };
    const moves = row();
    moves.style.display = 'none';
    const main = row();
    box.append(moves, main);

    const button = (parent: HTMLElement, label: string, title: string, big = true) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      const h = big ? 64 : 52;
      b.setAttribute(
        'style',
        `min-width:${h}px;height:${h}px;padding:0 14px;border-radius:${h / 2}px;border:3px solid #fff;white-space:nowrap;` +
          'background:rgba(20,10,50,.7);color:#fff;font:700 16px system-ui,sans-serif;touch-action:none;pointer-events:auto',
      );
      // Don't let button presses also move a hand.
      for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        b.addEventListener(ev, (e) => e.stopPropagation());
      }
      parent.append(b);
      return b;
    };
    /** Held for as long as the finger stays down. */
    const hold = (parent: HTMLElement, label: string, title: string, code: string, big = true) => {
      const b = button(parent, label, title, big);
      b.addEventListener('pointerdown', (e) => {
        b.setPointerCapture(e.pointerId);
        b.style.background = 'rgba(255,190,11,.85)';
        this.key(code, true);
      });
      const release = () => {
        b.style.background = 'rgba(20,10,50,.7)';
        this.key(code, false);
      };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
    };
    const tap = (parent: HTMLElement, label: string, title: string, code: string, big = true) => {
      const b = button(parent, label, title, big);
      b.addEventListener('pointerdown', () => this.key(code, true));
    };

    hold(main, '🙌 Hands up', 'Hold to raise both hands (H)', 'KeyH');
    tap(main, '⤒ Jump', 'Jump (Space)', 'Space');
    const more = button(main, 'Moves ▴', 'More gestures');
    more.addEventListener('pointerdown', () => {
      const open = moves.style.display === 'none';
      moves.style.display = open ? 'flex' : 'none';
      more.textContent = open ? 'Moves ▾' : 'Moves ▴';
    });
    hold(moves, 'Crouch', 'Hold to crouch (C)', 'KeyC', false);
    hold(moves, '◀ Lean', 'Hold to lean left (←)', 'ArrowLeft', false);
    hold(moves, 'Lean ▶', 'Hold to lean right (→)', 'ArrowRight', false);
    hold(moves, 'T-pose', 'Hold arms out (T)', 'KeyT', false);
    tap(moves, '👏 Clap', 'Clap (X)', 'KeyX', false);
    tap(moves, '👊 Punch', 'Punch (P)', 'KeyP', false);
    tap(moves, '🦵 Kick', 'Kick (K)', 'KeyK', false);
    hold(moves, '🏃 Run', 'Hold to run on the spot (R)', 'KeyR', false);
    hold(moves, '🛡 Guard', 'Hold gloves up by your face (G)', 'KeyG', false);
    tap(moves, '🥊 Jab', 'Punch straight at the camera (J)', 'KeyJ', false);

    const hint = document.createElement('span');
    hint.textContent = 'Sim: drag = right hand, 2nd finger = left';
    hint.setAttribute('style', 'background:rgba(0,0,0,.5);padding:6px 10px;border-radius:8px;opacity:.85;max-width:40vw');
    main.append(hint);
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
    /** Depth per keypoint (smaller = closer to the camera), like MediaPipe's z. */
    const zs: number[] = Array(pts.length).fill(0);

    if (i === 0) {
      // Ease held poses so they look (and filter) like real movement.
      this.crouchAmt += ((this.crouch ? 1 : 0) - this.crouchAmt) * 0.25;
      this.leanAmt += (this.leanDir - this.leanAmt) * 0.25;

      const sh = (k: number) => pts[k];
      const reach = (wrist: number, elbow: number, shoulder: number, tx: number, ty: number) => {
        pts[wrist] = { x: tx, y: ty };
        pts[elbow] = {
          x: (sh(shoulder).x + tx) / 2 + (tx > sh(shoulder).x ? 0.03 : -0.03),
          y: (sh(shoulder).y + ty) / 2 + 0.03,
        };
      };
      const anim = (at: number, ms: number) => {
        const p = (t - at) / ms;
        return p >= 0 && p <= 1 ? Math.sin(p * Math.PI) : 0; // 0 → 1 → 0
      };

      reach(10, 8, 6, this.right.x, this.right.y);
      if (this.left) reach(9, 7, 5, this.left.x, this.left.y);
      if (this.armsOut) {
        reach(9, 7, 5, pts[5].x - 0.38 * s, pts[5].y);
        reach(10, 8, 6, pts[6].x + 0.38 * s, pts[6].y);
        pts[7] = { x: pts[5].x - 0.19 * s, y: pts[5].y };
        pts[8] = { x: pts[6].x + 0.19 * s, y: pts[6].y };
      }
      if (this.handsUp) {
        reach(9, 7, 5, pts[5].x - 0.03, pts[0].y - 0.12);
        reach(10, 8, 6, pts[6].x + 0.03, pts[0].y - 0.12);
      }
      // Clap: hands swing in from the sides, meet at the chest, swing back out.
      const clap = anim(this.clapAt, 450);
      if (clap > 0) {
        const chest = { x: (pts[5].x + pts[6].x) / 2, y: pts[5].y + 0.12 * s };
        const spread = 0.3 * s * (1 - Math.min(1, clap * 1.4));
        reach(9, 7, 5, chest.x - spread, chest.y);
        reach(10, 8, 6, chest.x + spread, chest.y);
      }
      // Punch: fist up in guard by the shoulder, then shoots out, then back.
      const pt = (t - this.punchAt) / 650;
      if (pt >= 0 && pt <= 1) {
        const from = { x: pts[6].x + 0.02, y: pts[6].y + 0.05 };
        const reachX = pts[6].x + 0.42 * s;
        const out = pt < 0.4 ? 0 : pt < 0.6 ? (pt - 0.4) / 0.2 : Math.max(0, 1 - (pt - 0.75) / 0.25);
        reach(10, 8, 6, from.x + (reachX - from.x) * out, from.y + (pts[6].y - from.y) * out);
      }
      // Guard: both gloves up by the chin, a little in front of the body.
      const chin = { x: pts[0].x, y: pts[0].y + 0.05 * s };
      if (this.guard) {
        reach(9, 7, 5, chin.x - 0.05 * s, chin.y);
        reach(10, 8, 6, chin.x + 0.05 * s, chin.y);
        zs[9] = zs[10] = -0.12 * s;
      }
      // Jab: right glove from the chin straight at the camera (only depth changes much).
      const jt2 = (t - this.jabAt) / 500;
      if (jt2 >= 0 && jt2 <= 1) {
        const out = jt2 < 0.3 ? 0 : jt2 < 0.5 ? (jt2 - 0.3) / 0.2 : Math.max(0, 1 - (jt2 - 0.65) / 0.35);
        reach(10, 8, 6, chin.x + 0.05 * s, chin.y + 0.02 * s * out);
        zs[10] = -0.12 * s - 0.45 * s * out;
        zs[8] = -0.2 * s * out;
      }
      // Run on the spot: knees and feet alternate, left arm pumps.
      if (this.running) {
        const ph = (t / 1000) * 3.5 * Math.PI * 2;
        const l = Math.max(0, Math.sin(ph));
        const r = Math.max(0, -Math.sin(ph));
        pts[13] = { x: pts[13].x, y: pts[13].y - 0.1 * s * l };
        pts[15] = { x: pts[15].x, y: pts[15].y - 0.12 * s * l };
        pts[14] = { x: pts[14].x, y: pts[14].y - 0.1 * s * r };
        pts[16] = { x: pts[16].x, y: pts[16].y - 0.12 * s * r };
        if (!this.left && !this.handsUp && !this.armsOut) {
          pts[9] = { x: pts[9].x + 0.04 * s, y: pts[7].y + 0.02 + 0.06 * s * Math.sin(ph) };
        }
      }
      // Kick: right foot swings up.
      const kick = anim(this.kickAt, 400);
      if (kick > 0) {
        pts[16] = { x: pts[16].x + 0.12 * s * kick, y: pts[16].y - 0.32 * s * kick };
        pts[14] = { x: pts[14].x + 0.06 * s * kick, y: pts[14].y - 0.12 * s * kick };
      }
      // Lean: tilt the upper body around the hips.
      if (Math.abs(this.leanAmt) > 0.01) {
        const hip = { x: (pts[11].x + pts[12].x) / 2, y: (pts[11].y + pts[12].y) / 2 };
        const a = this.leanAmt * 0.45;
        for (let j = 0; j <= 10; j++) {
          const dx = pts[j].x - hip.x;
          const dy = pts[j].y - hip.y;
          pts[j] = { x: hip.x + dx * Math.cos(a) - dy * Math.sin(a), y: hip.y + dx * Math.sin(a) + dy * Math.cos(a) };
        }
      }
      // Crouch: upper body and hips drop, knees bend outwards.
      if (this.crouchAmt > 0.01) {
        const drop = 0.25 * s * this.crouchAmt;
        for (let j = 0; j <= 12; j++) pts[j] = { x: pts[j].x, y: pts[j].y + drop };
        pts[13] = { x: pts[13].x - 0.08 * s * this.crouchAmt, y: pts[13].y + drop * 0.4 };
        pts[14] = { x: pts[14].x + 0.08 * s * this.crouchAmt, y: pts[14].y + drop * 0.4 };
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
    return pts.map((p, j) => ({ x: 1 - p.x, y: p.y, z: zs[j], score: 0.95 }));
  }
}
