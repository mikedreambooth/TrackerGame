/**
 * Arena, the cartoon boxers (side view, facing each other) and hit effects.
 * Artwork: art/generate.py (Gemini) -> public/art. The boxers stay procedural so
 * they follow the players' moves; only their heads and gloves are sprites.
 */
import type { Fighter } from './fighter';

export type Art = Record<'background' | 'glove_red' | 'glove_blue' | 'head_red' | 'head_blue' | 'pow' | 'star' | 'belt', HTMLImageElement>;
let art: Art;
/** Hand the loaded artwork to the drawing code (once, at start-up). */
export function useArt(images: Art) {
  art = images;
}

const SKIN = '#ffd6a5';
const SKIN_BACK = '#e8b88a';
const INK = '#2a1230';

/** Camera flashes popping in the crowd, as fractions of the screen. */
const flashes: { x: number; y: number; at: number }[] = [];

export function drawArena(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, _floorY: number) {
  const img = art.background;
  const k = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, (w - img.width * k) / 2, (h - img.height * k) / 2, img.width * k, img.height * k);
  // Tone the busy crowd down a little so the boxers and text stand out.
  ctx.fillStyle = 'rgba(15, 8, 35, 0.22)';
  ctx.fillRect(0, 0, w, h);
  // Spotlights breathing on the ring.
  for (const x of [0.32, 0.68]) {
    const a = 0.08 + 0.04 * Math.sin(now / 900 + x * 10);
    const g = ctx.createRadialGradient(w * x, h * 0.78, 10, w * x, h * 0.78, h * 0.5);
    g.addColorStop(0, `rgba(255, 236, 179, ${a})`);
    g.addColorStop(1, 'rgba(255, 236, 179, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // Camera flashes in the stands.
  if (Math.random() < 0.06) flashes.push({ x: Math.random(), y: 0.22 + Math.random() * 0.25, at: now });
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    const age = (now - f.at) / 220;
    if (age > 1) {
      flashes.splice(i, 1);
      continue;
    }
    const r = h * 0.035 * (1 - age * 0.5);
    const g = ctx.createRadialGradient(f.x * w, f.y * h, 0, f.x * w, f.y * h, r);
    g.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - age)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(f.x * w - r, f.y * h - r, r * 2, r * 2);
  }
}

/** A sprite centred at (x, y), `size` wide/high, turned by `angle`, mirrored when `flip`. */
function sprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, size: number, angle = 0, flip = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(img, -size / 2, -size / 2, size, size);
  ctx.restore();
}

/** A limb with a dark outline so it reads over the busy crowd. */
function limb(ctx: CanvasRenderingContext2D, width: number, colour: string, path: () => void) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = width + Math.max(3, width * 0.22);
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  path();
  ctx.stroke();
}

/**
 * Cartoon boxer, feet at (x, floorY), facing the opponent. `size` ≈ standing height.
 * Procedural so it follows the player's moves; the head and gloves are sprites.
 */
export function drawBoxer(ctx: CanvasRenderingContext2D, f: Fighter, x: number, floorY: number, size: number, now: number) {
  const s = size;
  const dir = f.facing;
  const red = f.side === 'left';
  const hitT = (now - f.hitAt) / 350;
  const recoil = hitT >= 0 && hitT < 1 ? Math.sin(hitT * Math.PI) : 0;
  const bounce = f.ko ? 0 : Math.sin(now / 160) * s * 0.01;
  const duck = f.ko ? 0 : f.duck;
  // Weave leans the upper body back, away from the opponent.
  const lean = (f.ko ? 0 : -Math.abs(f.weave) * 0.32) * dir - recoil * 0.25 * dir;
  const line = Math.max(2, s * 0.012);

  ctx.save();
  ctx.translate(x, floorY);
  if (f.ko) {
    // Knocked out: flat on the canvas.
    ctx.rotate(-dir * Math.PI / 2.2);
    ctx.translate(0, -s * 0.05);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.22, s * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();

  const hipY = -s * (0.46 - duck * 0.16) + bounce;
  const kneeOut = s * (0.05 + duck * 0.09);
  // Legs (bent knees when ducking) and boots in the corner's colour.
  for (const [fx, kx] of [
    [-s * 0.1 * dir, -kneeOut * dir],
    [s * 0.12 * dir, kneeOut * dir + s * 0.04 * dir],
  ]) {
    limb(ctx, s * 0.075, SKIN, () => {
      ctx.moveTo(0, hipY);
      ctx.lineTo(kx, hipY + (0 - hipY) * 0.5);
      ctx.lineTo(fx, -s * 0.06);
    });
    ctx.fillStyle = f.color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.roundRect(fx - s * 0.045, -s * 0.1, s * 0.09, s * 0.08, s * 0.02);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(fx + s * 0.025 * dir, -s * 0.028, s * 0.065, s * 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillRect(fx - s * 0.04, -s * 0.095, s * 0.08, s * 0.016);
  }
  // Shorts: corner colour with a white waistband, a side stripe and a gold star.
  ctx.fillStyle = f.color;
  ctx.strokeStyle = INK;
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.roundRect(-s * 0.13, hipY - s * 0.06, s * 0.26, s * 0.17, s * 0.045);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(-s * 0.125, hipY - s * 0.055, s * 0.25, s * 0.03);
  ctx.fillRect(-s * 0.01 - s * 0.06 * dir, hipY - s * 0.025, s * 0.02, s * 0.13);
  sprite(ctx, art.star, s * 0.05 * dir, hipY + s * 0.04, s * 0.05);

  // Upper body pivots at the hips for weaving / being hit.
  ctx.save();
  ctx.translate(0, hipY - s * 0.04);
  ctx.rotate(lean);
  const torsoH = s * 0.3;
  const torso = ctx.createLinearGradient(-s * 0.1 * dir, 0, s * 0.1 * dir, 0);
  torso.addColorStop(0, SKIN_BACK);
  torso.addColorStop(1, SKIN);
  ctx.fillStyle = torso;
  ctx.strokeStyle = INK;
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.roundRect(-s * 0.1, -torsoH, s * 0.2, torsoH, s * 0.07);
  ctx.fill();
  ctx.stroke();
  const shoulder = { x: s * 0.03 * dir, y: -torsoH + s * 0.05 };
  const head = { x: s * 0.02 * dir, y: -torsoH - s * 0.1 };

  // Gloves: idle in front of the chest; up at the face when guarding; out when punching.
  const reach = f.punchReach(now);
  const hand = f.punch?.hand;
  const glove = (which: 'lead' | 'rear') => {
    const back = which === 'rear' ? -1 : 1;
    let gx = s * (0.16 + (which === 'lead' ? 0.05 : 0)) * dir;
    let gy = -torsoH + s * 0.12;
    if (f.guard) {
      gx = s * (0.1 + (which === 'lead' ? 0.03 : -0.02)) * dir;
      gy = head.y + s * 0.04 * back;
    }
    if (f.windup && which === f.windupHand) {
      // Telegraph: pull the glove back (and a little higher) before throwing it.
      gx -= s * 0.14 * f.windup * dir;
      gy -= s * 0.05 * f.windup;
    }
    if (hand === which) {
      gx += s * 0.42 * reach * dir;
      gy = gy + (head.y + s * 0.02 - gy) * reach;
    }
    return { x: gx, y: gy };
  };
  const drawArm = (which: 'lead' | 'rear', front: boolean) => {
    const g = glove(which);
    const cx = (shoulder.x + g.x) / 2;
    const cy = Math.max(shoulder.y, g.y) + s * 0.08;
    limb(ctx, s * 0.065, front ? SKIN : SKIN_BACK, () => {
      ctx.moveTo(shoulder.x, shoulder.y);
      ctx.quadraticCurveTo(cx, cy, g.x, g.y);
    });
    // The glove sprite points along the forearm (it's drawn pointing right, so mirror it
    // for the boxer facing left). The fist sits a little ahead of the sprite's centre.
    let a = Math.atan2(g.y - cy, g.x - cx);
    if (dir < 0) a -= Math.PI;
    const ux = Math.cos(a) * dir;
    const uy = Math.sin(a) * dir;
    if (!front) ctx.filter = 'brightness(0.72)';
    sprite(ctx, red ? art.glove_red : art.glove_blue, g.x - ux * s * 0.03, g.y - uy * s * 0.03, s * 0.22, a, dir < 0);
    ctx.filter = 'none';
  };
  drawArm('rear', false);

  // Head in a headguard (a sprite facing right; mirrored for the right-hand corner).
  const dizzy = f.ko || recoil > 0.3;
  sprite(ctx, red ? art.head_red : art.head_blue, head.x - s * 0.01 * dir, head.y, s * 0.3, dizzy ? -0.25 * dir : 0, dir < 0);
  if (recoil > 0) {
    // A white flash over the face when it's just been hit.
    ctx.globalAlpha = 0.4 * recoil;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(head.x + s * 0.03 * dir, head.y, s * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawArm('lead', true);
  ctx.restore();

  // Stars circling when dizzy.
  if (f.ko || recoil > 0) {
    for (let i = 0; i < 3; i++) {
      const a = now / 200 + (i * Math.PI * 2) / 3;
      sprite(ctx, art.star, Math.cos(a) * s * 0.13, hipY - s * 0.6 + Math.sin(a) * s * 0.035, s * 0.07, a);
    }
  }
  ctx.restore();
}

/** Comic burst behind a POW!, popping in. `age` 0..1. */
export function drawBurst(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, age: number, spin: number) {
  const pop = Math.min(1, age * 6);
  sprite(ctx, art.pow, x, y, size * (0.6 + 0.5 * pop), spin + age * 0.4);
}

/** The champion's belt on the results screen. */
export function drawBelt(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, now: number) {
  sprite(ctx, art.belt, x, y + Math.sin(now / 400) * size * 0.02, size, Math.sin(now / 700) * 0.05);
}

/** Health + stamina bars along the top. */
export function drawBars(ctx: CanvasRenderingContext2D, w: number, f: Fighter, label: string) {
  const left = f.side === 'left';
  const bw = w * 0.36;
  const x = left ? w * 0.04 : w * 0.96 - bw;
  const y = 28;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(x - 4, y - 4, bw + 8, 34, 10);
  ctx.fill();
  const hp = Math.max(0, f.health) / 100;
  ctx.fillStyle = hp > 0.3 ? f.color : '#ffbe0b';
  const hw = bw * hp;
  ctx.beginPath();
  ctx.roundRect(left ? x : x + bw - hw, y, Math.max(0, hw), 26, 8);
  ctx.fill();
  // Stamina underneath.
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(x, y + 36, bw, 6);
  ctx.fillStyle = '#8ecae6';
  const sw = bw * (f.stamina / 100);
  ctx.fillRect(left ? x : x + bw - sw, y + 36, sw, 6);
  ctx.font = `900 22px ui-rounded, system-ui, sans-serif`;
  ctx.textAlign = left ? 'left' : 'right';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#1b1030';
  ctx.strokeText(label, left ? x : x + bw, y + 66);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, left ? x : x + bw, y + 66);
}
