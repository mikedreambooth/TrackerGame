/**
 * Jousting artwork, all canvas paths: the lists (sky, castle, grandstand, sand,
 * tilt barrier), caparisoned horses and knights in armour. Figures face right
 * when dir = 1 and are mirrored for dir = -1. Sizes are in units of `s`, the
 * horse's height to the top of its head.
 */

const STEEL = '#cfd6de';
const STEEL_DARK = '#8b96a3';
const INK = '#22223b';
const HORSE = '#8d5a3b';
const HORSE_DARK = '#5e3a26';
const GOLD = '#ffd166';

// ---------- scenery ----------

/** Everything behind the riders. `horizon` is where the grandstand meets the sand. */
export function drawLists(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number, t: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#5aa9e6');
  sky.addColorStop(1, '#bde0fe');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);

  // Distant hills and a castle.
  ctx.fillStyle = '#7fb069';
  ctx.beginPath();
  ctx.moveTo(0, horizon - h * 0.12);
  for (let x = 0; x <= w; x += w / 8) ctx.lineTo(x, horizon - h * (0.14 + 0.04 * Math.sin(x / w * 7)));
  ctx.lineTo(w, horizon);
  ctx.lineTo(0, horizon);
  ctx.fill();
  castle(ctx, w * 0.78, horizon - h * 0.13, h * 0.2);

  // Grandstand: striped awning, crowd, pennants.
  const top = horizon - h * 0.13;
  ctx.fillStyle = '#6b4226';
  ctx.fillRect(w * 0.06, top, w * 0.52, horizon - top);
  const colors = ['#e63946', '#f1faee', '#3a86ff', '#ffbe0b', '#2ec4b6', '#8338ec'];
  for (let i = 0; i < (w * 0.52) / 12; i++) {
    for (let r = 0; r < 3; r++) {
      const bob = Math.sin(t * 6 + i * 1.7 + r) * 1.5;
      ctx.fillStyle = colors[(i * 5 + r * 2) % colors.length];
      ctx.beginPath();
      ctx.arc(w * 0.06 + i * 12 + (r % 2) * 6 + 6, top + h * 0.03 + r * h * 0.03 + bob, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const stripes = 13;
  for (let i = 0; i < stripes; i++) {
    const x0 = w * 0.05 + (i * w * 0.54) / stripes;
    ctx.fillStyle = i % 2 ? '#f1faee' : '#9d0208';
    ctx.beginPath();
    ctx.moveTo(x0, top - h * 0.045);
    ctx.lineTo(x0 + (w * 0.54) / stripes, top - h * 0.045);
    ctx.lineTo(x0 + (w * 0.54) / stripes, top);
    ctx.arc(x0 + (w * 0.27) / stripes, top, (w * 0.27) / stripes, 0, Math.PI);
    ctx.fill();
  }
  for (const [x, c] of [
    [w * 0.05, '#e63946'],
    [w * 0.32, '#ffbe0b'],
    [w * 0.59, '#3a86ff'],
  ] as const) {
    pennant(ctx, x, top - h * 0.045, h * 0.1, c, t);
  }

  // Sand.
  const sand = ctx.createLinearGradient(0, horizon, 0, h);
  sand.addColorStop(0, '#d9b47c');
  sand.addColorStop(1, '#c2925a');
  ctx.fillStyle = sand;
  ctx.fillRect(0, horizon, w, h - horizon);
}

function castle(ctx: CanvasRenderingContext2D, x: number, base: number, size: number) {
  ctx.fillStyle = '#8d99ae';
  ctx.fillRect(x - size * 0.5, base - size * 0.35, size, size * 0.35);
  for (const dx of [-0.55, 0.35]) {
    ctx.fillRect(x + dx * size, base - size * 0.6, size * 0.2, size * 0.6);
    ctx.fillStyle = '#5c677d';
    ctx.beginPath();
    ctx.moveTo(x + dx * size - size * 0.03, base - size * 0.6);
    ctx.lineTo(x + dx * size + size * 0.1, base - size * 0.8);
    ctx.lineTo(x + dx * size + size * 0.23, base - size * 0.6);
    ctx.fill();
    ctx.fillStyle = '#8d99ae';
  }
  for (let i = 0; i < 5; i++) ctx.fillRect(x - size * 0.5 + i * size * 0.22, base - size * 0.42, size * 0.12, size * 0.08);
  ctx.fillStyle = '#3d405b';
  ctx.beginPath();
  ctx.arc(x, base, size * 0.1, Math.PI, 0);
  ctx.fill();
}

function pennant(ctx: CanvasRenderingContext2D, x: number, base: number, size: number, color: string, t: number) {
  ctx.strokeStyle = '#5e3a26';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, base);
  ctx.lineTo(x, base - size);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, base - size);
  const wave = Math.sin(t * 5 + x) * size * 0.08;
  ctx.quadraticCurveTo(x + size * 0.3, base - size * 0.92 + wave, x + size * 0.55, base - size * 0.85 + wave);
  ctx.quadraticCurveTo(x + size * 0.3, base - size * 0.8 - wave, x, base - size * 0.7);
  ctx.fill();
}

/** The long wooden fence the knights ride either side of. */
export function drawBarrier(ctx: CanvasRenderingContext2D, w: number, y: number, height: number) {
  ctx.fillStyle = '#7f5539';
  for (let x = w * 0.02; x < w; x += w / 14) ctx.fillRect(x, y - height, height * 0.18, height);
  ctx.fillStyle = '#9c6644';
  ctx.fillRect(0, y - height, w, height * 0.22);
  ctx.fillRect(0, y - height * 0.45, w, height * 0.18);
  // Painted cloth panels.
  for (let i = 0, x = 0; x < w; i++, x += w / 7) {
    ctx.fillStyle = i % 2 ? '#9d0208' : '#023e8a';
    ctx.fillRect(x + w * 0.01, y - height * 0.78, w / 7 - w * 0.02, height * 0.33);
  }
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
  // A big diamond badge on the cloth.
  ctx.fillStyle = GOLD;
  ctx.beginPath();
  ctx.moveTo(-0.16, -0.66);
  ctx.lineTo(-0.08, -0.56);
  ctx.lineTo(-0.16, -0.46);
  ctx.lineTo(-0.24, -0.56);
  ctx.fill();

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
  ctx.fillStyle = '#f8f9fa';
  ctx.beginPath();
  ctx.moveTo(-0.07, 0.0);
  ctx.lineTo(0, -0.06);
  ctx.lineTo(0.07, 0.0);
  ctx.lineTo(0.07, 0.04);
  ctx.lineTo(0, -0.02);
  ctx.lineTo(-0.07, 0.04);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}
