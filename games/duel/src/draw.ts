/** Courtyard, the cartoon knights (side view, facing each other), sparks and bars. */
import type { Arm, Attack, Fighter } from './fighter';

const SKIN = '#ffd6a5';
const STEEL = '#c9d1dc';
const STEEL_DARK = '#7d8794';
const GOLD = '#ffbe0b';

/** Fallback courtyard if the painted background isn't available. */
export function drawCourtyard(ctx: CanvasRenderingContext2D, w: number, h: number, floorY: number, bg: HTMLImageElement | null) {
  if (bg && bg.width) {
    // Cover-fit, anchored so the sandy floor stays under the knights.
    const k = Math.max(w / bg.width, h / bg.height);
    const dw = bg.width * k;
    const dh = bg.height * k;
    ctx.drawImage(bg, (w - dw) / 2, Math.min(0, floorY - dh * 0.86), dw, dh);
    return;
  }
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, '#4ea8de');
  sky.addColorStop(1, '#bde0fe');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#d4a373';
  ctx.fillRect(0, h * 0.35, w, h * 0.3);
  for (let x = 0; x < w; x += 40) ctx.fillRect(x, h * 0.32, 24, h * 0.04);
  ctx.fillStyle = '#e9c46a';
  ctx.fillRect(0, h * 0.62, w, h);
}

/** Where the hand of an arm ends up, in the knight's local frame. */
function hand(shoulder: { x: number; y: number }, a: Arm, u: number, dir: number) {
  return { x: shoulder.x + a.fwd * u * dir, y: shoulder.y + a.down * u };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Cartoon knight, feet at (x, floorY), facing the opponent. `size` ≈ standing height.
 * Shield in the left hand (front), sword in the right (behind).
 */
export function drawKnight(ctx: CanvasRenderingContext2D, f: Fighter, x: number, floorY: number, size: number, now: number) {
  const s = size;
  const dir = f.facing;
  const hitT = (now - f.hitAt) / 400;
  const recoil = hitT >= 0 && hitT < 1 ? Math.sin(hitT * Math.PI) : 0;
  const bounce = f.ko ? 0 : Math.sin(now / 180) * s * 0.008;
  const duck = f.ko ? 0 : f.duck;
  const lean = -recoil * 0.22 * dir + duck * 0.25 * dir;

  ctx.save();
  ctx.translate(x - recoil * s * 0.04 * dir, floorY);
  if (f.ko) {
    ctx.rotate(-dir * Math.PI / 2.2);
    ctx.translate(0, -s * 0.05);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.24, s * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();

  const hipY = -s * (0.46 - duck * 0.17) + bounce;
  const kneeOut = s * (0.05 + duck * 0.1);
  // Legs: grey hose and brown boots, front foot towards the opponent.
  for (const [fx, kx, col] of [
    [-s * 0.11 * dir, -kneeOut * dir, '#5c677d'],
    [s * 0.13 * dir, kneeOut * dir + s * 0.05 * dir, '#6c7a92'],
  ] as const) {
    ctx.strokeStyle = col;
    ctx.lineWidth = s * 0.07;
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(kx, hipY * 0.5);
    ctx.lineTo(fx, -s * 0.04);
    ctx.stroke();
    ctx.fillStyle = '#6f4518';
    ctx.beginPath();
    ctx.ellipse(fx + s * 0.03 * dir, -s * 0.025, s * 0.065, s * 0.032, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Upper body pivots at the hips (ducking leans forward, a hit knocks it back).
  ctx.save();
  ctx.translate(0, hipY);
  ctx.rotate(lean);
  const torsoH = s * 0.3;
  // Chainmail body + team tabard with a belt.
  ctx.fillStyle = STEEL_DARK;
  ctx.beginPath();
  ctx.roundRect(-s * 0.11, -torsoH, s * 0.22, torsoH + s * 0.04, s * 0.07);
  ctx.fill();
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.moveTo(-s * 0.1, -torsoH + s * 0.04);
  ctx.lineTo(s * 0.1, -torsoH + s * 0.04);
  ctx.lineTo(s * 0.12, s * 0.09);
  ctx.lineTo(-s * 0.12, s * 0.09);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffffaa';
  drawStar(ctx, s * 0.01 * dir, -torsoH * 0.55, s * 0.045);
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(-s * 0.115, -s * 0.03, s * 0.23, s * 0.03);
  ctx.fillStyle = GOLD;
  ctx.fillRect(-s * 0.02, -s * 0.032, s * 0.04, s * 0.034);

  const shoulder = { x: s * 0.02 * dir, y: -torsoH + s * 0.05 };
  const head = { x: s * 0.02 * dir, y: -torsoH - s * 0.1 };
  const u = s * 0.14; // one "shoulder width" of arm movement

  // --- Sword arm (behind the body) ---
  let sh = hand(shoulder, f.swordArm, u, dir);
  const v = Math.max(-1, Math.min(1, f.swordArm.down / 1.8));
  let ang = 0.5 - v * 0.9; // radians above "forward"
  if (f.windup > 0) {
    // Telegraph: sword raised back over the head / held low / pulled back.
    ang = f.windupKind === 'high' ? 2.3 : f.windupKind === 'low' ? -2.2 : 0.05;
  }
  if (f.swing) {
    const p = f.swingProgress(now);
    const r = f.swingReach(now);
    const k = Math.min(1, p / 0.45);
    const from: Record<Attack, Arm> = { high: { fwd: 0.3, down: -1.7 }, low: { fwd: 0.3, down: 1.5 }, thrust: { fwd: 0.1, down: 0.5 } };
    const to: Record<Attack, Arm> = { high: { fwd: 1.7, down: -0.6 }, low: { fwd: 1.6, down: 1.0 }, thrust: { fwd: 1.95, down: 0.2 } };
    const a = from[f.swing.kind];
    const b = to[f.swing.kind];
    sh = hand(shoulder, { fwd: lerp(a.fwd, b.fwd, r), down: lerp(a.down, b.down, r) }, u, dir);
    ang =
      f.swing.kind === 'high' ? lerp(2.0, -0.5, Math.min(1, p / 0.6)) : f.swing.kind === 'low' ? lerp(-2.1, -0.45, Math.min(1, p / 0.6)) : 0;
    // Motion trail.
    if (p < 0.7) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - p / 0.7)})`;
      ctx.lineWidth = s * 0.05;
      ctx.beginPath();
      const a0 = f.swing.kind === 'high' ? 2.0 : f.swing.kind === 'low' ? -2.1 : 0;
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * k;
        const aa = f.swing.kind === 'thrust' ? 0 : lerp(a0, ang, t / Math.max(k, 0.01));
        const len = s * 0.36;
        const px = sh.x + Math.cos(aa) * len * dir;
        const py = sh.y - Math.sin(aa) * len;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
  drawArmLine(ctx, shoulder, sh, s, shade(f.color, 0.7), dir);
  drawSword(ctx, sh.x, sh.y, ang, dir, s, now - f.blockedAt < 200);

  // --- Head: face + helmet with a plume ---
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(head.x, head.y, s * 0.085, 0, Math.PI * 2);
  ctx.fill();
  // Helmet dome (open face towards the opponent).
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.arc(head.x, head.y - s * 0.01, s * 0.095, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  // Neck guard covering the back of the head.
  ctx.beginPath();
  ctx.roundRect(dir > 0 ? head.x - s * 0.095 : head.x, head.y - s * 0.02, s * 0.095, s * 0.09, s * 0.02);
  ctx.fill();
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(head.x + s * 0.035 * dir - s * 0.01, head.y - s * 0.07, s * 0.02, s * 0.07); // nose guard
  // Plume.
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.ellipse(head.x - s * 0.06 * dir, head.y - s * 0.11, s * 0.08, s * 0.035, -0.4 * dir, 0, Math.PI * 2);
  ctx.fill();
  // Eye + mouth (dizzy when hit / KO).
  ctx.fillStyle = '#1b1030';
  const ex = head.x + s * 0.055 * dir;
  if (f.ko || recoil > 0.3) {
    ctx.font = `900 ${Math.round(s * 0.06)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('x', ex, head.y + s * 0.02);
  } else {
    ctx.beginPath();
    ctx.arc(ex, head.y, s * 0.014, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillRect(head.x + s * 0.04 * dir - (dir < 0 ? s * 0.035 : 0), head.y + s * 0.045, s * 0.035, s * 0.008);

  // --- Shield arm (in front) ---
  const hh = hand(shoulder, f.shieldArm, u, dir);
  drawArmLine(ctx, shoulder, hh, s, f.color, dir);
  // Nudge the shield so a LOW guard visibly covers the legs and a HIGH one the face.
  const nudge = f.shield === 'low' ? s * 0.09 : f.shield === 'high' ? -s * 0.03 : 0;
  drawShield(ctx, hh.x + s * 0.03 * dir, hh.y + nudge, s, f, now);
  ctx.restore();

  // Stars when dizzy.
  if (f.ko || recoil > 0) {
    for (let i = 0; i < 3; i++) {
      const a = now / 200 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = GOLD;
      ctx.font = `${Math.round(s * 0.06)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('★', Math.cos(a) * s * 0.12, hipY - s * 0.56 + Math.sin(a) * s * 0.03);
    }
  }
  ctx.restore();
}

function drawArmLine(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  s: number,
  color: string,
  dir: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.06;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  // Elbow bends down and back a little.
  const mx = (from.x + to.x) / 2 - s * 0.02 * dir;
  const my = Math.max(from.y, to.y) + s * 0.04;
  ctx.quadraticCurveTo(mx, my, to.x, to.y);
  ctx.stroke();
  ctx.fillStyle = '#8d6e63'; // leather glove
  ctx.beginPath();
  ctx.arc(to.x, to.y, s * 0.032, 0, Math.PI * 2);
  ctx.fill();
}

/** A shiny cartoon sword held at (x, y), pointing `ang` radians above forward. */
function drawSword(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, dir: number, s: number, flash: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  ctx.rotate(-ang);
  const len = s * 0.36;
  const bw = s * 0.03;
  // Grip + pommel behind the hand.
  ctx.fillStyle = '#6f4518';
  ctx.fillRect(-s * 0.06, -bw * 0.35, s * 0.06, bw * 0.7);
  ctx.fillStyle = GOLD;
  ctx.beginPath();
  ctx.arc(-s * 0.065, 0, bw * 0.55, 0, Math.PI * 2);
  ctx.fill();
  // Blade with a rounded (kid-safe) tip.
  ctx.fillStyle = flash ? '#fff' : '#e9ecef';
  ctx.strokeStyle = '#495057';
  ctx.lineWidth = s * 0.006;
  ctx.beginPath();
  ctx.moveTo(s * 0.02, -bw / 2);
  ctx.lineTo(len - bw * 0.6, -bw / 2);
  ctx.quadraticCurveTo(len + bw * 0.3, 0, len - bw * 0.6, bw / 2);
  ctx.lineTo(s * 0.02, bw / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#adb5bd';
  ctx.beginPath();
  ctx.moveTo(s * 0.03, 0);
  ctx.lineTo(len - bw, 0);
  ctx.stroke();
  // Cross-guard.
  ctx.fillStyle = GOLD;
  ctx.beginPath();
  ctx.roundRect(s * 0.01, -bw * 1.6, s * 0.022, bw * 3.2, s * 0.008);
  ctx.fill();
  ctx.restore();
}

function drawShield(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, f: Fighter, now: number) {
  const rx = s * 0.075;
  const ry = s * 0.115;
  const flash = now - (f.lastOutcome?.what === 'blocked' ? f.lastOutcome.at : -1e9) < 250;
  ctx.save();
  ctx.translate(x, y);
  // A glow when it's up and covering.
  if (f.shield) {
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = s * 0.05;
  }
  // Heater shield: flat top, pointed bottom.
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(-rx, -ry);
    ctx.lineTo(rx, -ry);
    ctx.quadraticCurveTo(rx, ry * 0.4, 0, ry);
    ctx.quadraticCurveTo(-rx, ry * 0.4, -rx, -ry);
    ctx.closePath();
  };
  path();
  ctx.fillStyle = flash ? '#fff' : STEEL;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.save();
  ctx.translate(0, s * 0.005);
  ctx.scale(0.8, 0.84);
  path();
  ctx.fillStyle = flash ? '#fff' : f.color;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = flash ? f.color : GOLD;
  drawStar(ctx, 0, -ry * 0.15, s * 0.04);
  ctx.restore();
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

/** The CPU's warning sign over its head while it winds up a swing. */
export function drawTelegraph(ctx: CanvasRenderingContext2D, f: Fighter, x: number, y: number, size: number, now: number) {
  if (f.windup <= 0 || f.ko) return;
  const kind = f.windupKind;
  const label = kind === 'high' ? '⬆ HIGH!' : kind === 'low' ? '⬇ LOW!' : f.facing > 0 ? 'THRUST ➡' : '⬅ THRUST';
  const tip = kind === 'high' ? 'Shield UP or duck!' : kind === 'low' ? 'Shield DOWN!' : 'Shield up!';
  const pulse = 1 + Math.sin(now / 60) * 0.06;
  const fs = size * 0.09 * pulse;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Fills up like a fuse: when it's full, the swing comes.
  const bw = size * 0.42;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(x - bw / 2, y - fs * 1.1, bw, fs * 2.9, fs * 0.4);
  ctx.fill();
  ctx.fillStyle = '#ff4d6d';
  ctx.fillRect(x - bw / 2 + 6, y + fs * 1.45, (bw - 12) * f.windup, fs * 0.2);
  ctx.font = `900 ${Math.round(fs)}px ui-rounded, system-ui, sans-serif`;
  ctx.fillStyle = kind === 'low' ? '#4cc9f0' : kind === 'high' ? GOLD : '#ff9f1c';
  ctx.fillText(label, x, y);
  ctx.font = `800 ${Math.round(fs * 0.45)}px ui-rounded, system-ui, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.fillText(tip, x, y + fs * 0.95);
  ctx.restore();
}

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  at: number;
  color: string;
}

export function drawSparks(ctx: CanvasRenderingContext2D, sparks: Spark[], now: number, dt: number) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i];
    const age = (now - p.at) / 450;
    if (age > 1) {
      sparks.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 900 * dt;
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 1 - age;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c * k);
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
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
  ctx.fillStyle = hp > 0.3 ? f.color : GOLD;
  const hw = bw * hp;
  ctx.beginPath();
  ctx.roundRect(left ? x : x + bw - hw, y, Math.max(0, hw), 26, 8);
  ctx.fill();
  // Stamina underneath.
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x, y + 36, bw, 8);
  ctx.fillStyle = f.stamina < 22 ? '#ff9f1c' : '#8ecae6';
  const sw = bw * (f.stamina / 100);
  ctx.fillRect(left ? x : x + bw - sw, y + 36, sw, 8);
  ctx.font = `900 22px ui-rounded, system-ui, sans-serif`;
  ctx.textAlign = left ? 'left' : 'right';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#1b1030';
  ctx.strokeText(label, left ? x : x + bw, y + 70);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, left ? x : x + bw, y + 70);
}
