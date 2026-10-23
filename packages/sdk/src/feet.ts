import { fitCanvas, screenMapper } from './draw';
import { KP, type Frame, type Player, type Vec2 } from './types';
import { drawText } from './ui';
import { FEET } from './feet-config';

// Renamed when the guides became off by default, so an old saved "on" doesn't carry over.
const KEY = 'tg.feetGuides';

export { FEET } from './feet-config';

interface Warn {
  high: boolean;
  /** When the current problem started (0 = none). */
  highSince: number;
  closeSince: number;
  seenAt: number;
}

/**
 * Footprint outlines in each player's colour under their ankles, over the whole page, lined
 * up the way screenMapper() maps players by default (like CameraGhost), where the layout
 * put them. Faint while all is
 * well; they flash with "Step closer" when someone stands so far back that their feet sit
 * well above the bottom of the picture, and "Step back" shows when their feet are out of
 * the bottom of the picture. OFF by default: F (or toggle()) turns them on, remembered on
 * this device; ?feet=1 / ?feet=0 in the URL force them on / off. A game can hide them with
 * createGame({ feet: false }).
 */
export class FeetOverlay {
  /** The viewer's choice (F key). Off unless turned on. */
  on = false;
  /** False while the running game has asked not to show them. */
  allowed = true;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private toggledAt = -Infinity;
  private running = false;
  private warn = new Map<number, Warn>();

  constructor(private frame: () => Frame) {
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:51';
    document.body.append(this.canvas);
    try {
      this.on = localStorage.getItem(KEY) === '1';
    } catch {
      /* storage blocked */
    }
    const fromUrl = new URLSearchParams(location.search).get('feet');
    if (fromUrl === '0' || fromUrl === '1') this.on = fromUrl === '1';
    addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (e.code === 'KeyF' && !e.repeat && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) this.toggle();
    });
    this.start();
  }

  toggle(): void {
    this.on = !this.on;
    this.toggledAt = performance.now();
    try {
      localStorage.setItem(KEY, this.on ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    this.start();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.draw);
  }

  private draw = (now: number) => {
    const { w, h } = fitCanvas(this.canvas, this.ctx);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const f = this.frame();
    if (this.on && this.allowed) {
      const { map, len } = screenMapper(f.aspect, w, h);
      for (const p of f.players) this.drawPlayer(p, now, map, len, h);
      for (const [id, s] of this.warn) if (now - s.seenAt > 2000) this.warn.delete(id);
    }
    const since = now - this.toggledAt;
    if (since < 1500) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (1500 - since) / 300);
      drawText(ctx, this.on ? 'Feet guides on (F)' : 'Feet guides off (F)', 16, h - 28 - Math.max(16, h / 36) * 1.6, Math.max(16, h / 36), '#fff', { align: 'left' });
      ctx.restore();
    }
    if (this.on || since < 1500) requestAnimationFrame(this.draw);
    else this.running = false;
  };

  private drawPlayer(p: Player, now: number, map: (p: Vec2) => Vec2, len: (n: number) => number, h: number) {
    const k = p.keypoints;
    // Too far / too close is about the real room: judge it where the camera sees them, before
    // the layout moved them; draw where the layout put them.
    const rk = (p.raw ?? p).keypoints;
    const seen = (i: number) => k[i].score >= FEET.minScore;
    const ankles = [KP.leftAnkle, KP.rightAnkle].filter(seen);
    let s = this.warn.get(p.id);
    if (!s) this.warn.set(p.id, (s = { high: false, highSince: 0, closeSince: 0, seenAt: now }));
    s.seenAt = now;

    // Too far back: even the lower foot sits well above the bottom of the picture.
    const lowest = ankles.length ? Math.max(...ankles.map((i) => rk[i].y)) : null;
    // The tracker judges it (player.distance); players built by hand are judged here.
    if (p.distance) s.high = p.distance === 'far';
    else if (lowest !== null) s.high = s.high ? lowest < FEET.highClearY : lowest < FEET.highY;
    else s.high = false;
    s.highSince = s.high ? s.highSince || now : 0;
    // Too close: hips in view but the feet are out of the bottom of the picture.
    const hips = seen(KP.leftHip) && seen(KP.rightHip);
    const close = p.distance ? p.distance === 'close' : hips && (lowest === null ? true : lowest > FEET.edgeY);
    s.closeSince = close ? s.closeSince || now : 0;
    const tooHigh = s.highSince > 0 && now - s.highSince > FEET.warnAfterMs;
    const tooClose = s.closeSince > 0 && now - s.closeSince > FEET.warnAfterMs;

    const footLen = Math.max(14, len(p.shoulderWidth) * 0.75);
    const pulse = 0.5 + 0.5 * Math.sin(now / 130); // ~1.2 flashes a second
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.lineJoin = 'round';
    for (const i of ankles) {
      const a = map(k[i]);
      const left = i === KP.leftAnkle; // on screen-left (mirrored view)
      ctx.save();
      ctx.translate(a.x, a.y + footLen * 0.25);
      ctx.rotate(((left ? -1 : 1) * 12 * Math.PI) / 180); // toes turned out a little
      if (left) ctx.scale(-1, 1); // big toe on the inside
      if (tooHigh) {
        ctx.scale(1 + 0.12 * pulse, 1 + 0.12 * pulse);
        ctx.globalAlpha = 0.25 + 0.35 * pulse;
        footPath(ctx, footLen);
        ctx.fill();
        ctx.globalAlpha = 0.55 + 0.45 * pulse;
        ctx.lineWidth = 5;
      } else {
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 3;
      }
      footPath(ctx, footLen);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    const size = Math.max(16, h / 26);
    if (tooHigh && lowest !== null) {
      // A bouncing arrow from the feet towards the bottom of the screen (towards the camera).
      const xs = ankles.map((i) => map(k[i]).x);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const y0 = map({ x: 0, y: Math.max(...ankles.map((i) => k[i].y)) }).y + footLen * 0.9;
      const bob = Math.abs(Math.sin(now / 260)) * size * 0.5;
      arrow(ctx, x, y0 + bob, size * 1.1, 1, p.color);
      drawText(ctx, 'Step closer', x, Math.min(y0 + bob + size * 2.2, h - size * 0.8), size, p.color);
    } else if (tooClose) {
      const x = map(p.center).x;
      const y = h - size * 2.6;
      ctx.save();
      ctx.globalAlpha = 0.6 + 0.4 * pulse;
      arrow(ctx, x, y - size * 1.6, size * 1.1, -1, p.color);
      drawText(ctx, 'Step back', x, y, size, p.color);
      ctx.restore();
    }
  }
}

/** A right footprint, toes up, centred on the origin, `L` long: sole outline plus toes. */
function footPath(ctx: CanvasRenderingContext2D, L: number) {
  ctx.beginPath();
  // Sole: wide at the ball, narrow at the arch, round heel; the big toe is on the left.
  ctx.moveTo(0.02 * L, 0.5 * L);
  ctx.bezierCurveTo(-0.2 * L, 0.5 * L, -0.22 * L, 0.2 * L, -0.17 * L, 0.02 * L);
  ctx.bezierCurveTo(-0.13 * L, -0.12 * L, -0.24 * L, -0.24 * L, -0.15 * L, -0.3 * L);
  ctx.bezierCurveTo(-0.05 * L, -0.36 * L, 0.2 * L, -0.3 * L, 0.21 * L, -0.15 * L);
  ctx.bezierCurveTo(0.22 * L, 0.0 * L, 0.12 * L, 0.12 * L, 0.15 * L, 0.3 * L);
  ctx.bezierCurveTo(0.17 * L, 0.45 * L, 0.12 * L, 0.5 * L, 0.02 * L, 0.5 * L);
  ctx.closePath();
  // Toes, biggest first.
  const toes: [number, number, number][] = [
    [-0.12, -0.42, 0.075],
    [0.0, -0.44, 0.05],
    [0.08, -0.41, 0.045],
    [0.145, -0.36, 0.04],
    [0.19, -0.29, 0.035],
  ];
  for (const [x, y, r] of toes) {
    ctx.moveTo((x + r) * L, y * L);
    ctx.arc(x * L, y * L, r * L, 0, Math.PI * 2);
  }
}

/** A chunky arrow pointing down (dir 1) or up (dir -1), its tip at (x, y). */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, dir: 1 | -1, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, dir);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-0.55 * s, -0.6 * s);
  ctx.lineTo(-0.2 * s, -0.6 * s);
  ctx.lineTo(-0.2 * s, -1.2 * s);
  ctx.lineTo(0.2 * s, -1.2 * s);
  ctx.lineTo(0.2 * s, -0.6 * s);
  ctx.lineTo(0.55 * s, -0.6 * s);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#1a1033';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}
