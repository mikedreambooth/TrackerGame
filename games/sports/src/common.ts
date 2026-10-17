/** Shared pieces for the Sports Day events: lanes, results, body metrics, scenery, athletes. */
import { KP, type Frame, type Player } from '@trackergame/sdk';

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

export function drawStadium(ctx: CanvasRenderingContext2D, w: number, h: number, trackTop: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, trackTop);
  sky.addColorStop(0, '#4fa3d9');
  sky.addColorStop(1, '#a8dcf0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, trackTop);
  // Crowd stand.
  ctx.fillStyle = '#3d405b';
  ctx.fillRect(0, trackTop - h * 0.12, w, h * 0.12);
  const colors = ['#e63946', '#ffbe0b', '#3a86ff', '#2ec4b6', '#f1faee', '#8338ec'];
  for (let i = 0; i < w / 14; i++) {
    for (let r = 0; r < 3; r++) {
      ctx.fillStyle = colors[(i * 7 + r * 3) % colors.length];
      ctx.beginPath();
      ctx.arc(i * 14 + (r % 2) * 7 + 6, trackTop - h * 0.1 + r * h * 0.032, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#2a9d3a';
  ctx.fillRect(0, trackTop, w, h - trackTop);
}

/** Red running track with white lane lines. Returns each lane's ground (foot) y. */
export function drawTrack(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number, lanes: number) {
  ctx.fillStyle = '#c8553d';
  ctx.fillRect(x0, top, x1 - x0, bottom - top);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
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
  // Head + headband.
  ctx.fillStyle = '#ffd6a5';
  ctx.beginPath();
  ctx.arc(neck.x + s * 0.02, neck.y - s * 0.11, s * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(neck.x - s * 0.08, neck.y - s * 0.17, s * 0.2, s * 0.04);
  ctx.restore();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * amt)));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/** A round medal with a ribbon and place number. */
export function drawMedal(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, place: number) {
  const colors: Record<number, string> = { 1: '#ffd166', 2: '#d9d9d9', 3: '#cd7f32' };
  const c = colors[place] ?? '#888';
  ctx.save();
  ctx.fillStyle = '#3a86ff';
  ctx.beginPath();
  ctx.moveTo(x - r * 0.6, y - r * 2.2);
  ctx.lineTo(x - r * 0.1, y - r * 0.6);
  ctx.lineTo(x + r * 0.1, y - r * 0.6);
  ctx.lineTo(x + r * 0.6, y - r * 2.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = c;
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = r * 0.12;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#1b1030';
  ctx.font = `900 ${Math.round(r)}px ui-rounded, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(place), x, y + r * 0.05);
  ctx.restore();
}
