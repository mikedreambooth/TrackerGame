/** Ring, crowd and the cartoon boxers (side view, facing each other). */
import type { Fighter } from './fighter';

export function drawArena(ctx: CanvasRenderingContext2D, w: number, h: number, now: number, floorY: number) {
  // Dark hall with spotlights.
  ctx.fillStyle = '#14112b';
  ctx.fillRect(0, 0, w, h);
  for (const [x, a] of [
    [0.3, 0.12],
    [0.7, 0.12],
    [0.5, 0.18],
  ]) {
    const g = ctx.createRadialGradient(w * x, 0, 10, w * x, h * 0.6, h * 0.9);
    g.addColorStop(0, `rgba(255, 236, 179, ${a + 0.05 * Math.sin(now / 900 + x * 10)})`);
    g.addColorStop(1, 'rgba(255, 236, 179, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  // Crowd silhouettes, bobbing.
  for (let i = 0; i < w / 26; i++) {
    const x = i * 26 + 13;
    const y = h * 0.5 + Math.sin(now / 300 + i * 1.7) * 3 + (i % 3) * 6;
    ctx.fillStyle = i % 4 === 0 ? '#2b2650' : '#221d42';
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x - 13, y + 8, 26, 40);
  }
  // Ring floor (trapezoid), apron, posts and ropes.
  ctx.fillStyle = '#3d405b';
  ctx.beginPath();
  ctx.moveTo(w * 0.08, floorY - h * 0.08);
  ctx.lineTo(w * 0.92, floorY - h * 0.08);
  ctx.lineTo(w * 1.02, floorY + h * 0.06);
  ctx.lineTo(-w * 0.02, floorY + h * 0.06);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#9d0208';
  ctx.fillRect(-w * 0.02, floorY + h * 0.06, w * 1.04, h);
  ctx.fillStyle = '#ffffff22';
  ctx.font = `900 ${Math.round(h / 16)}px ui-rounded, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('PLAYBOX BOXING', w / 2, floorY + h * 0.15);
  for (const x of [w * 0.08, w * 0.92]) {
    ctx.fillStyle = '#e9ecef';
    ctx.fillRect(x - 6, floorY - h * 0.4, 12, h * 0.33);
  }
  const ropes: [number, string][] = [
    [0.36, '#e63946'],
    [0.28, '#f1faee'],
    [0.2, '#3a86ff'],
  ];
  for (const [dy, c] of ropes) {
    ctx.strokeStyle = c;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(w * 0.08, floorY - h * dy);
    ctx.lineTo(w * 0.92, floorY - h * dy);
    ctx.stroke();
  }
}

/**
 * Cartoon boxer, feet at (x, floorY), facing the opponent. `size` ≈ standing height.
 */
export function drawBoxer(ctx: CanvasRenderingContext2D, f: Fighter, x: number, floorY: number, size: number, now: number) {
  const s = size;
  const dir = f.facing;
  const hitT = (now - f.hitAt) / 350;
  const recoil = hitT >= 0 && hitT < 1 ? Math.sin(hitT * Math.PI) : 0;
  const bounce = f.ko ? 0 : Math.sin(now / 160) * s * 0.01;
  const duck = f.ko ? 0 : f.duck;
  // Weave leans the upper body back, away from the opponent.
  const lean = (f.ko ? 0 : -Math.abs(f.weave) * 0.32) * dir - recoil * 0.25 * dir;

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
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.22, s * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();

  const hipY = -s * (0.46 - duck * 0.16) + bounce;
  const kneeOut = s * (0.05 + duck * 0.09);
  // Legs (boots + bent knees when ducking).
  ctx.strokeStyle = '#ffd6a5';
  ctx.lineWidth = s * 0.075;
  for (const [fx, kx] of [
    [-s * 0.1 * dir, -kneeOut * dir],
    [s * 0.12 * dir, kneeOut * dir + s * 0.04 * dir],
  ]) {
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(kx, hipY + (0 - hipY) * 0.5);
    ctx.lineTo(fx, -s * 0.03);
    ctx.stroke();
    ctx.fillStyle = '#1b1030';
    ctx.beginPath();
    ctx.ellipse(fx + s * 0.03 * dir, -s * 0.02, s * 0.06, s * 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shorts.
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.roundRect(-s * 0.12, hipY - s * 0.06, s * 0.24, s * 0.16, s * 0.04);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(-s * 0.12, hipY - s * 0.06, s * 0.24, s * 0.025);

  // Upper body pivots at the hips for weaving / being hit.
  ctx.save();
  ctx.translate(0, hipY - s * 0.04);
  ctx.rotate(lean);
  const torsoH = s * 0.3;
  ctx.fillStyle = '#ffd6a5';
  ctx.beginPath();
  ctx.roundRect(-s * 0.1, -torsoH, s * 0.2, torsoH, s * 0.07);
  ctx.fill();
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
    ctx.strokeStyle = front ? '#ffd6a5' : '#e8b88a';
    ctx.lineWidth = s * 0.065;
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.quadraticCurveTo((shoulder.x + g.x) / 2, Math.max(shoulder.y, g.y) + s * 0.08, g.x, g.y);
    ctx.stroke();
    ctx.fillStyle = front ? f.color : shade(f.color);
    ctx.beginPath();
    ctx.arc(g.x, g.y, s * 0.075, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(g.x - s * 0.02 * dir, g.y - s * 0.025, s * 0.025, 0, Math.PI * 2);
    ctx.fill();
  };
  drawArm('rear', false);

  // Head + headguard.
  ctx.fillStyle = '#ffd6a5';
  ctx.beginPath();
  ctx.arc(head.x, head.y, s * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = f.color;
  ctx.lineWidth = s * 0.035;
  ctx.beginPath();
  ctx.arc(head.x, head.y, s * 0.09, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  // Eye + mouth (looking at the opponent; dizzy when hit / KO).
  ctx.fillStyle = '#1b1030';
  const ex = head.x + s * 0.045 * dir;
  if (f.ko || recoil > 0.3) {
    ctx.font = `900 ${Math.round(s * 0.06)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('x', ex, head.y + s * 0.015);
  } else {
    ctx.beginPath();
    ctx.arc(ex, head.y - s * 0.01, s * 0.014, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillRect(head.x + s * 0.03 * dir - (dir < 0 ? s * 0.04 : 0), head.y + s * 0.04, s * 0.04, s * 0.008);

  drawArm('lead', true);
  ctx.restore();

  // Stars when dizzy.
  if (f.ko || recoil > 0) {
    for (let i = 0; i < 3; i++) {
      const a = now / 200 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = '#ffbe0b';
      ctx.font = `${Math.round(s * 0.06)}px system-ui`;
      ctx.fillText('★', Math.cos(a) * s * 0.12, hipY - s * 0.52 + Math.sin(a) * s * 0.03);
    }
  }
  ctx.restore();
}

function shade(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c * 0.7);
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
