/** Shared pieces for the Sports Day events: lanes, results, body metrics, scenery, athletes. */
import { KP, type Frame, type Player } from '@trackergame/sdk';
import { art } from './art';

export interface Lane {
  slot: number;
  color: string;
  name: string;
}

export interface Result {
  slot: number;
  /** Used for ranking; higher is better (events negate times). */
  score: number;
  /** What to show, e.g. "8.42 s", "37 cm", "7 / 8". */
  label: string;
}

/** One event of the day. main.ts drives intro → countdown → play → results around it. */
export interface SportEvent {
  readonly title: string;
  /** Shown and spoken before the event. */
  readonly howTo: string;
  start(lanes: Lane[]): void;
  /** Called every frame while the event is live (not paused). `elapsed` = seconds of play. */
  update(frame: Frame, elapsed: number, dt: number): void;
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, elapsed: number): void;
  readonly done: boolean;
  /** Best first. */
  results(): Result[];
  /** Commentary lines the event wants spoken (main.ts drains this). */
  callouts: string[];
}

export const playerInSlot = (frame: Frame, slot: number): Player | undefined =>
  frame.players.find((p) => p.slot === slot);

/**
 * How high a player's hips are above their normal standing height, in torso
 * lengths — the basis for jump detection that doesn't care how tall a player
 * is or how far they stand from the camera.
 */
export class HipMeter {
  private base = new Map<number, number>();
  private torso = new Map<number, number>();

  /** Returns rise above standing (0 standing, ~0.5–0.9 for a good jump). */
  update(p: Player): number {
    const k = p.keypoints;
    const ok = (i: number) => k[i].score > 0.35;
    const hipY = ok(KP.leftHip) && ok(KP.rightHip) ? (k[KP.leftHip].y + k[KP.rightHip].y) / 2 : p.center.y;
    const shY = (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2;
    const t = Math.max(0.03, Math.abs(hipY - shY));
    const T = (this.torso.get(p.slot) ?? t) * 0.95 + t * 0.05;
    this.torso.set(p.slot, T);
    let base = this.base.get(p.slot) ?? hipY;
    const rise = (base - hipY) / T;
    // Follow the standing height slowly (people shuffle about), but not while in the air.
    if (rise < 0.12) base += (hipY - base) * 0.04;
    this.base.set(p.slot, base);
    return Math.max(0, (base - hipY) / T);
  }

  reset(): void {
    this.base.clear();
  }
}

/** Rank results and give 3 / 2 / 1 points for gold / silver / bronze. Ties share. */
export function medals(results: Result[]): { slot: number; place: number; points: number; label: string }[] {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  return sorted.map((r) => {
    const place = 1 + sorted.filter((o) => o.score > r.score).length;
    return { slot: r.slot, place, points: Math.max(0, 4 - place), label: r.label };
  });
}

// ---------- scenery ----------

/** Where the grandstand meets the grass in background.jpg, as a fraction of its height. */
const STAND_FOOT = 0.655;

/**
 * The stadium picture with the foot of the grandstand at `trackTop`: the sky and stand above
 * are drawn to scale, the grass below is stretched to fill the rest of the screen.
 */
export function drawStadium(ctx: CanvasRenderingContext2D, w: number, h: number, trackTop: number) {
  const img = art.background;
  const iw = img.width;
  const foot = img.height * STAND_FOOT;
  const k = Math.max(w / iw, trackTop / foot);
  const dx = (w - iw * k) / 2;
  ctx.drawImage(img, 0, 0, iw, foot, dx, trackTop - foot * k, iw * k, foot * k);
  ctx.drawImage(img, 0, foot, iw, img.height - foot, dx, trackTop, iw * k, h - trackTop);
}

/** A dark rounded panel so text stays readable over the busy crowd. */
export function drawScrim(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha = 0.5) {
  ctx.save();
  ctx.fillStyle = `rgba(20, 16, 48, ${alpha})`;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.12);
  ctx.fill();
  ctx.restore();
}

/** Red running track with white lane lines. Returns each lane's ground (foot) y. */
export function drawTrack(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number, lanes: number) {
  // Raised kerb, then the rubber track with a little sunlit shading.
  ctx.fillStyle = '#f4f1de';
  ctx.fillRect(x0, top - 6, x1 - x0, 6);
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, '#b9452f');
  g.addColorStop(0.25, '#d8613f');
  g.addColorStop(1, '#c4502f');
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, x1 - x0, bottom - top);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x0, bottom, x1 - x0, 5);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  const lh = (bottom - top) / lanes;
  for (let i = 0; i <= lanes; i++) {
    ctx.beginPath();
    ctx.moveTo(x0, top + i * lh);
    ctx.lineTo(x1, top + i * lh);
    ctx.stroke();
  }
  return Array.from({ length: lanes }, (_, i) => top + (i + 0.82) * lh);
}

export interface AthletePose {
  /** Running cycle phase in radians (legs/arms swing). */
  phase?: number;
  /** 0..1 how much the limbs swing (0 = standing). */
  stride?: number;
  /** Pixels above the ground (jumps). */
  lift?: number;
  /** Tumble angle in radians, for knocked hurdles. */
  tumble?: number;
  /** Arms up in celebration. */
  cheer?: boolean;
}

/** A chunky cartoon athlete, feet at (x, groundY), `size` = body height in px. */
export function drawAthlete(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  size: number,
  color: string,
  pose: AthletePose = {},
) {
  const { phase = 0, stride = 0, lift = 0, tumble = 0, cheer = false } = pose;
  const s = size;
  ctx.save();
  ctx.translate(x, groundY - lift);
  ctx.rotate(tumble);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Shadow on the ground.
  ctx.save();
  ctx.rotate(-tumble);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0, lift, s * 0.22 * Math.max(0.4, 1 - lift / (s * 2)), s * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const hip = { x: 0, y: -s * 0.45 };
  const neck = { x: s * 0.05 * stride, y: -s * 0.8 };
  const sw = Math.sin(phase) * stride;
  const leg = (dir: number) => {
    const a = dir * sw * 0.9;
    const knee = { x: hip.x + Math.sin(a) * s * 0.23, y: hip.y + Math.cos(a) * s * 0.23 };
    const kb = Math.max(0, -dir * sw) * 1.2; // trailing leg bends
    const foot = { x: knee.x - Math.sin(kb) * s * 0.22, y: knee.y + Math.cos(kb) * s * 0.22 };
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(knee.x, knee.y);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
  };
  const arm = (dir: number) => {
    ctx.beginPath();
    ctx.moveTo(neck.x, neck.y + s * 0.04);
    if (cheer) {
      ctx.lineTo(neck.x + dir * s * 0.12, neck.y - s * 0.14);
      ctx.lineTo(neck.x + dir * s * 0.18, neck.y - s * 0.3);
    } else {
      const a = -dir * sw * 1.1;
      const elbow = { x: neck.x + Math.sin(a) * s * 0.18, y: neck.y + s * 0.04 + Math.cos(a) * s * 0.18 };
      ctx.lineTo(elbow.x, elbow.y);
      ctx.lineTo(elbow.x + Math.sin(a + 1.4) * s * 0.15 * (stride > 0.1 ? 1 : 0.2), elbow.y + Math.cos(a + 1.4) * s * 0.15);
    }
    ctx.stroke();
  };

  // Back limbs darker, front limbs in full colour.
  ctx.strokeStyle = shade(color, -0.35);
  ctx.lineWidth = s * 0.09;
  leg(-1);
  arm(-1);
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.13;
  ctx.beginPath();
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(neck.x, neck.y);
  ctx.stroke();
  ctx.lineWidth = s * 0.09;
  leg(1);
  arm(1);
  // Head: a round shaded face with hair, a happy face and a headband.
  const hx = neck.x + s * 0.02;
  const hy = neck.y - s * 0.11;
  const hr = s * 0.1;
  const face = ctx.createRadialGradient(hx + hr * 0.3, hy - hr * 0.35, hr * 0.1, hx, hy, hr);
  face.addColorStop(0, '#ffe6c7');
  face.addColorStop(1, '#f2b880');
  ctx.fillStyle = '#5b3a29';
  ctx.beginPath();
  ctx.arc(hx - hr * 0.12, hy - hr * 0.1, hr * 1.02, Math.PI * 0.75, Math.PI * 1.95);
  ctx.fill();
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(hx, hy, hr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(neck.x - s * 0.08, neck.y - s * 0.17, s * 0.2, s * 0.04);
  ctx.fillStyle = '#2b2118';
  ctx.beginPath();
  ctx.arc(hx + hr * 0.45, hy - hr * 0.05, hr * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8a3b2a';
  ctx.lineWidth = hr * 0.12;
  ctx.beginPath();
  ctx.arc(hx + hr * 0.38, hy + hr * 0.25, hr * 0.3, 0.2, Math.PI * 0.8);
  ctx.stroke();
  ctx.restore();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * amt)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/** A round medal with a ribbon and place number. */
export function drawMedal(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, place: number) {
  // Where the disc sits in each medal picture: centre y and radius, as fractions of its size.
  const disc: Record<number, [number, number]> = { 1: [0.638, 0.354], 2: [0.625, 0.306], 3: [0.633, 0.309] };
  const [cy, cr] = disc[place] ?? disc[3];
  const img = art[`medal${Math.min(3, Math.max(1, place))}`];
  const s = r / cr;
  ctx.save();
  ctx.drawImage(img, x - s / 2, y - cy * s, s, s);
  ctx.fillStyle = '#1b1030';
  ctx.font = `900 ${Math.round(r)}px ui-rounded, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(place), x, y + r * 0.05);
  ctx.restore();
}
