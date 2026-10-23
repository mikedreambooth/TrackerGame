/**
 * Jousting artwork. The lists (sky, castle, grandstand, sand) and the tilt barrier are
 * Gemini pictures (art.ts); the caparisoned horses and knights in armour are canvas paths
 * so they can gallop and be unseated, decorated with the lion crest. Figures face right
 * when dir = 1 and are mirrored for dir = -1. Sizes are in units of `s`, the
 * horse's height to the top of its head.
 */

import { art } from './art';

const STEEL = '#cfd6de';
const STEEL_DARK = '#8b96a3';
const INK = '#22223b';
const HORSE = '#8d5a3b';
const HORSE_DARK = '#5e3a26';
const GOLD = '#ffd166';

// ---------- scenery ----------

/** Where the grandstand's fence meets the sand in background.jpg, as a fraction of its height. */
const SAND_LINE = 0.6;

/**
 * Everything behind the riders: the tournament picture with its sand line at `horizon`.
 * The sky, grandstand and castle are drawn to scale; the sand is stretched to the bottom.
 */
export function drawLists(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number) {
  const img = art.background;
  const iw = img.width;
  const line = img.height * SAND_LINE;
  const k = Math.max(w / iw, horizon / line);
  const dx = (w - iw * k) / 2;
  ctx.drawImage(img, 0, 0, iw, line, dx, horizon - line * k, iw * k, line * k);
  ctx.drawImage(img, 0, line, iw, img.height - line, dx, horizon, iw * k, h - horizon);
}

/** The long wooden tilt fence the knights ride either side of; `y` is its foot. */
export function drawBarrier(ctx: CanvasRenderingContext2D, w: number, y: number, height: number) {
  const img = art.barrier;
  const th = height * 1.3;
  const tw = (th * img.width) / img.height;
  // Overlap the tiles a touch so the end posts join up.
  for (let x = -tw * 0.05; x < w; x += tw * 0.94) ctx.drawImage(img, x, y - th, tw, th);
}

/** The lion crest, centred at (x, y), `size` across, in the current transform. */
function crest(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.drawImage(art.crest, x - size / 2, y - size / 2, size, size);
}

// ---------- horse ----------

export interface Gait {
  /** Gallop cycle in radians. */
  phase: number;
  /** 0..1 how hard the horse is galloping (0 = standing). */
  stride: number;
}

/** How high the saddle sits above the ground, for placing the knight. */
export const SEAT = 0.82;

/** Body bob for this moment of the gallop (negative = up), in units of s. */
export const bob = (g: Gait) => -Math.abs(Math.sin(g.phase)) * 0.05 * g.stride;

export function drawHorse(ctx: CanvasRenderingContext2D, x: number, ground: number, s: number, dir: 1 | -1, color: string, g: Gait) {
  ctx.save();
  ctx.translate(x, ground);
  ctx.scale(dir * s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.5, 0.05, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(0, bob(g));
  const leg = (hx: number, off: number, far: boolean) => {
    const sw = Math.sin(g.phase + off);
    const a = sw * 0.75 * g.stride; // swing forward/back
    const bend = Math.max(0, Math.sin(g.phase + off + 1.3)) * 1.1 * g.stride;
    const hip = { x: hx, y: -0.55 };
    const knee = { x: hip.x + Math.sin(a) * 0.25, y: hip.y + Math.cos(a) * 0.25 };
    const b = a - bend;
    const hoof = { x: knee.x + Math.sin(b) * 0.27, y: knee.y + Math.cos(b) * 0.27 };
    ctx.strokeStyle = far ? HORSE_DARK : HORSE;
    ctx.lineWidth = 0.075;
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(knee.x, knee.y);
    ctx.lineTo(hoof.x, hoof.y);
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.085;
    ctx.beginPath();
    ctx.moveTo(hoof.x - Math.sin(b) * 0.02, hoof.y - Math.cos(b) * 0.02);
    ctx.lineTo(hoof.x + Math.sin(b) * 0.02, hoof.y + Math.cos(b) * 0.02);
    ctx.stroke();
  };
  // Far legs first (darker), near legs over the body later.
  leg(0.27, 0.5, true);
  leg(-0.28, 3.6, true);

  // Tail.
  ctx.strokeStyle = HORSE_DARK;
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  ctx.moveTo(-0.42, -0.7);
  const flick = Math.sin(g.phase * 0.5) * 0.08 * (0.3 + g.stride);
  ctx.quadraticCurveTo(-0.62, -0.68 + flick, -0.6 - g.stride * 0.15, -0.38 + flick);
  ctx.stroke();

  // Body, neck, head.
  ctx.fillStyle = HORSE;
  ctx.beginPath();
  ctx.ellipse(0, -0.62, 0.44, 0.19, 0, 0, Math.PI * 2);
  ctx.fill();
  const nod = Math.sin(g.phase) * 0.04 * g.stride;
  ctx.beginPath();
  ctx.moveTo(0.22, -0.74);
  ctx.lineTo(0.44, -1.0 + nod);
  ctx.lineTo(0.58, -0.96 + nod);
  ctx.lineTo(0.42, -0.58);
  ctx.fill();
  ctx.save();
  ctx.translate(0.6, -0.93 + nod);
  ctx.rotate(0.55);
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.16, 0.075, 0, 0, Math.PI * 2);
  ctx.fill();
  // Chanfron (face armour).
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.075);
  ctx.lineTo(0.12, -0.05);
  ctx.lineTo(0.12, 0.01);
  ctx.lineTo(-0.1, 0.02);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(-0.02, -0.03, 0.025, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Ear and eye.
  ctx.fillStyle = HORSE_DARK;
  ctx.beginPath();
  ctx.moveTo(0.47, -1.0 + nod);
  ctx.lineTo(0.5, -1.1 + nod);
  ctx.lineTo(0.53, -0.99 + nod);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(0.56, -0.97 + nod, 0.017, 0, Math.PI * 2);
  ctx.fill();
  // Mane.
  ctx.strokeStyle = HORSE_DARK;
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(0.24, -0.78);
  ctx.lineTo(0.45, -1.03 + nod);
  ctx.stroke();

  // Caparison: the long cloth in the player's colour, with a gold trim.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-0.47, -0.74);
  ctx.quadraticCurveTo(-0.05, -0.86, 0.3, -0.8);
  ctx.lineTo(0.42, -0.62);
  ctx.lineTo(0.4, -0.36);
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const px = 0.4 - (0.88 * i) / n;
    const flutter = Math.sin(g.phase * 1.5 + i) * 0.02 * g.stride;
    ctx.quadraticCurveTo(px + 0.06, -0.3 + flutter, px, -0.36 + flutter);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 0.02;
  ctx.stroke();
  // Soft shading along the bottom of the cloth, and the lion crest on it.
  ctx.save();
  ctx.clip();
  const shade = ctx.createLinearGradient(0, -0.8, 0, -0.3);
  shade.addColorStop(0, 'rgba(255,255,255,0.25)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = shade;
  ctx.fillRect(-0.6, -0.9, 1.1, 0.7);
  ctx.restore();
  crest(ctx, -0.14, -0.56, 0.2);

  leg(0.3, 0, false);
  leg(-0.25, 3.1, false);
  ctx.restore();
}

// ---------- knight ----------

export interface KnightLook {
  /** Lance broken off near the grip after a hit. */
  broken?: boolean;
  /** Lance raised in triumph. */
  cheer?: boolean;
  /** 0 seated … 1 flat on the sand (unseated, flung backwards). */
  fall?: number;
}

/**
 * A knight in plate armour with a plumed great helm, shield and lance. (x, ground) is the
 * spot on the ground below the saddle; `lift` raises the seat (the horse's gallop bob).
 * `lance` is the lance length in units of s.
 */
export function drawKnight(
  ctx: CanvasRenderingContext2D,
  x: number,
  ground: number,
  s: number,
  dir: 1 | -1,
  color: string,
  lance: number,
  look: KnightLook = {},
  lift = 0,
) {
  const fall = look.fall ?? 0;
  ctx.save();
  ctx.translate(x, ground);
  ctx.scale(dir * s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Flung backwards in an arc, rotating onto their back.
  const fx = -fall * 0.7;
  const fy = -Math.sin(fall * Math.PI) * 0.35 + fall * (SEAT - 0.1);
  ctx.translate(fx, -SEAT + lift + fy);
  ctx.rotate(-fall * Math.PI * 0.5);

  // Near leg in the stirrup (straight out when flying).
  ctx.strokeStyle = STEEL_DARK;
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  ctx.moveTo(0, 0.02);
  ctx.lineTo(0.1 + fall * 0.1, 0.18 - fall * 0.05);
  ctx.lineTo(0.05 + fall * 0.25, 0.38 - fall * 0.2);
  ctx.stroke();
  ctx.strokeStyle = STEEL;
  ctx.lineWidth = 0.055;
  ctx.stroke();

  // Lance (behind the shield), held under the arm. An unseated knight drops it.
  const lanceAngle = look.cheer ? -1.25 : 0.04;
  ctx.save();
  ctx.translate(0.06, -0.18);
  ctx.rotate(lanceAngle);
  if (fall > 0) ctx.globalAlpha = 0;
  const len = look.broken ? 0.35 : lance;
  const stripes = look.broken ? 2 : 8;
  for (let i = 0; i < stripes; i++) {
    ctx.strokeStyle = i % 2 ? '#f8f9fa' : color;
    ctx.lineWidth = 0.05 - (0.03 * i) / stripes;
    ctx.beginPath();
    ctx.moveTo(-0.3 + ((len + 0.3) * i) / stripes, 0);
    ctx.lineTo(-0.3 + ((len + 0.3) * (i + 1)) / stripes, 0);
    ctx.stroke();
  }
  if (look.broken) {
    // Jagged splintered end.
    ctx.strokeStyle = '#e9c46a';
    ctx.lineWidth = 0.012;
    for (const a of [-0.5, 0, 0.6]) {
      ctx.beginPath();
      ctx.moveTo(len, 0);
      ctx.lineTo(len + Math.cos(a) * 0.06, Math.sin(a) * 0.04);
      ctx.stroke();
    }
  }
  // Vamplate: the cone guarding the hand.
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.moveTo(0.06, -0.07);
  ctx.lineTo(0.2, -0.02);
  ctx.lineTo(0.2, 0.02);
  ctx.lineTo(0.06, 0.07);
  ctx.fill();
  ctx.restore();

  // Torso: breastplate under a tabard in the player's colour.
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.roundRect(-0.1, -0.36, 0.2, 0.38, 0.06);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-0.09, -0.28);
  ctx.lineTo(0.09, -0.28);
  ctx.lineTo(0.1, 0.06);
  ctx.lineTo(-0.1, 0.06);
  ctx.fill();
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(-0.1, -0.06, 0.2, 0.035); // belt

  // Arm holding the lance.
  ctx.strokeStyle = STEEL_DARK;
  ctx.lineWidth = 0.065;
  ctx.beginPath();
  ctx.moveTo(-0.02, -0.3);
  ctx.lineTo(-0.04, -0.17);
  ctx.lineTo(0.08, -0.17);
  ctx.stroke();

  // Great helm with a visor slit and a plume.
  ctx.save();
  ctx.translate(0, -0.47);
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.roundRect(-0.085, -0.1, 0.17, 0.2, [0.07, 0.07, 0.02, 0.02]);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.018;
  ctx.beginPath();
  ctx.moveTo(0.0, -0.025);
  ctx.lineTo(0.085, -0.025);
  ctx.stroke();
  ctx.fillStyle = INK;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(0.045, 0.03 + i * 0.022, 0.006, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = STEEL_DARK;
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(0, -0.1);
  ctx.lineTo(0, 0.1);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-0.02, -0.09);
  ctx.quadraticCurveTo(-0.05, -0.24, -0.24, -0.2 + lift);
  ctx.quadraticCurveTo(-0.12, -0.14, -0.06, -0.08);
  ctx.fill();
  ctx.restore();

  // Heater shield on the arm facing the opponent.
  ctx.save();
  ctx.translate(0.11, -0.2);
  ctx.rotate(0.12);
  ctx.fillStyle = color;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 0.018;
  ctx.beginPath();
  ctx.moveTo(-0.08, -0.1);
  ctx.lineTo(0.08, -0.1);
  ctx.lineTo(0.08, 0.02);
  ctx.quadraticCurveTo(0.07, 0.11, 0, 0.15);
  ctx.quadraticCurveTo(-0.07, 0.11, -0.08, 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  crest(ctx, 0, 0.005, 0.135);
  ctx.restore();

  ctx.restore();
}
