import { handCursor } from './draw';
import type { Player, Vec2 } from './types';
import { drawText, theme } from './ui';

/**
 * A button you "press" by holding a raised hand over it — the same interaction
 * as the launcher's game tiles — or by tapping/clicking it. Position and size are fractions of the screen
 * (x, y = centre), so buttons scale with any canvas.
 */
export interface DwellButton {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  /** A picture shown above the label (drawn pixelated, fitted into the button's top part). */
  image?: CanvasImageSource & { width: number; height: number };
}

/**
 * Taps and clicks also press buttons (phones, tablets, a mouse on the box). One
 * window listener records them; each menu consumes the taps it hasn't seen yet.
 */
interface Tap {
  seq: number;
  x: number;
  y: number;
}
const taps: Tap[] = [];
let tapSeq = 0;
let tapsInstalled = false;

/** Record a tap at screen fractions (x, y). The launcher uses this to pass on taps made over its simulator layer. */
export function pushTap(x: number, y: number): void {
  taps.push({ seq: ++tapSeq, x, y });
  if (taps.length > 8) taps.shift();
}

/**
 * Calls `onTap` for quick taps/clicks (short, barely moving) on `target`, in
 * screen fractions — so a drag (e.g. moving a simulated hand) isn't a tap.
 */
export function detectTaps(target: EventTarget, onTap: (x: number, y: number) => void): void {
  const downs = new Map<number, { x: number; y: number; t: number }>();
  target.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  });
  target.addEventListener('pointerup', (ev) => {
    const e = ev as PointerEvent;
    const d = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (performance.now() - d.t < 400 && moved < Math.min(innerWidth, innerHeight) * 0.04) {
      onTap(d.x / innerWidth, d.y / innerHeight);
    }
  });
  target.addEventListener('pointercancel', (ev) => downs.delete((ev as PointerEvent).pointerId));
}

// ---------- press debounce ----------

/** After a press, nothing can be pressed by hand for this long (ms). */
export const PRESS_COOLDOWN_MS = 900;
let quietUntil = 0;
/** Bumped on every press: a hand must be seen off all buttons since the last press to press again. */
let pressEpoch = 1;
const offSince = new Map<number, number>();

/**
 * Something was pressed by hand, or the screen changed under the players' hands: nothing can be
 * pressed for a moment, and every hand must move off the buttons (or drop) before it can press
 * again. Stops a hand resting where it pressed from pressing again, or pressing whatever
 * appears under it on the next screen.
 */
export function pressHappened(now = performance.now()): void {
  quietUntil = now + PRESS_COOLDOWN_MS;
  pressEpoch++;
}

/**
 * May this player's hand count as holding a button right now? Call every frame for each
 * player with whether their hand is over a button (false also for no hand / hand down).
 */
export function pressArmed(playerId: number, overButton: boolean, now = performance.now()): boolean {
  if (!overButton) offSince.set(playerId, pressEpoch);
  return now >= quietUntil && offSince.get(playerId) === pressEpoch;
}

function installTaps() {
  if (tapsInstalled || typeof window === 'undefined') return;
  tapsInstalled = true;
  detectTaps(window, pushTap);
}

interface Cursor {
  x: number;
  y: number;
  color: string;
  progress: number;
}

/**
 * Hand-controlled menu for use inside games:
 *
 *   const menu = new DwellMenu([{ id: 'again', label: 'Play again', x: 0.35, y: 0.75, w: 0.24, h: 0.14 }]);
 *   // every frame:
 *   const picked = menu.update(game.frame.players, now);   // 'again' once, when held long enough
 *   menu.draw(ctx, w, h);
 */
export class DwellMenu {
  private holds = new Map<number, { id: string; since: number }>();
  private cursors: Cursor[] = [];
  private hovered = new Map<string, number>();
  private seenTap = tapSeq;
  private drawnAt = -Infinity;

  constructor(
    public buttons: DwellButton[],
    public dwellMs = 1200,
    /**
     * Where each player points, in screen fractions (default: the body-relative
     * `handCursor`). Games that use real hand positions (e.g. painting) pass their own.
     */
    private cursorOf: (p: Player) => Vec2 | null = handCursor,
  ) {
    installTaps();
  }

  /** A tap/click on a button that was on screen just now picks it straight away. */
  private tapped(): string | null {
    let picked: string | null = null;
    const visible = performance.now() - this.drawnAt < 500;
    for (const t of taps) {
      if (t.seq <= this.seenTap) continue;
      this.seenTap = t.seq;
      if (!visible || picked) continue;
      const b = this.buttons.find((b) => Math.abs(t.x - b.x) <= b.w / 2 && Math.abs(t.y - b.y) <= b.h / 2);
      if (b) picked = b.id;
    }
    return picked;
  }

  /** Returns a button id the moment a player has held a hand over it for `dwellMs`, otherwise null. */
  update(players: Player[], now: number): string | null {
    this.cursors = [];
    this.hovered.clear();
    let picked: string | null = this.tapped();
    if (picked) {
      this.holds.clear();
      pressHappened(now);
    }
    for (const p of players) {
      const c = this.cursorOf(p);
      if (!c) {
        pressArmed(p.id, false, now);
        this.holds.delete(p.id);
        continue;
      }
      const b = this.buttons.find(
        (b) => Math.abs(c.x - b.x) <= b.w / 2 && Math.abs(c.y - b.y) <= b.h / 2,
      );
      let progress = 0;
      // Debounce: just after a press, hands must move off the buttons before pressing again.
      if (b && !pressArmed(p.id, true, now)) {
        this.holds.delete(p.id);
        this.cursors.push({ ...c, color: p.color, progress: 0 });
        continue;
      }
      if (!b) pressArmed(p.id, false, now);
      if (b) {
        const hold = this.holds.get(p.id);
        if (!hold || hold.id !== b.id) this.holds.set(p.id, { id: b.id, since: now });
        else progress = Math.min(1, (now - hold.since) / this.dwellMs);
        this.hovered.set(b.id, Math.max(this.hovered.get(b.id) ?? 0, progress));
        if (progress >= 1 && !picked) {
          picked = b.id;
          this.holds.clear();
          pressHappened(now);
        }
      } else this.holds.delete(p.id);
      this.cursors.push({ ...c, color: p.color, progress });
    }
    return picked;
  }

  /** The button a hand is over right now (the one nearest to being pressed), or null. */
  hovering(): string | null {
    let best: string | null = null;
    let most = -1;
    for (const [id, progress] of this.hovered) {
      if (progress > most) {
        most = progress;
        best = id;
      }
    }
    return best;
  }

  /** Draws buttons (highlighted while hovered) and every player's hand cursor. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawnAt = performance.now();
    ctx.save();
    for (const b of this.buttons) {
      const hover = this.hovered.get(b.id);
      const bw = b.w * w;
      const bh = b.h * h;
      const x = b.x * w - bw / 2;
      const y = b.y * h - bh / 2;
      const grow = hover !== undefined ? 1.06 : 1;
      ctx.save();
      ctx.translate(b.x * w, b.y * h);
      ctx.scale(grow, grow);
      ctx.translate(-b.x * w, -b.y * h);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.roundRect(x, y + 8, bw, bh, bh / 3);
      ctx.fill();
      ctx.fillStyle = b.color ?? '#3a2a80';
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, bh / 3);
      ctx.fill();
      if (hover !== undefined) {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 6;
        ctx.stroke();
        // Fill-up progress behind the label.
        ctx.save();
        ctx.clip();
        ctx.fillStyle = 'rgba(255,190,11,0.35)';
        ctx.fillRect(x, y, bw * hover, bh);
        ctx.restore();
      }
      if (b.image) {
        // Picture in the top three-quarters, label underneath.
        const iw = b.image.width;
        const ih = b.image.height;
        const k = Math.min((bw * 0.88) / iw, (bh * 0.68) / ih);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(b.image, b.x * w - (iw * k) / 2, y + bh * 0.38 - (ih * k) / 2, iw * k, ih * k);
        ctx.imageSmoothingEnabled = true;
        drawText(ctx, b.label, b.x * w, y + bh * 0.86, Math.min(bh * 0.17, bw / (b.label.length * 0.55)));
      } else drawText(ctx, b.label, b.x * w, b.y * h, Math.min(bh * 0.42, bw / (b.label.length * 0.55)));
      ctx.restore();
    }
    for (const c of this.cursors) {
      const x = c.x * w;
      const y = c.y * h;
      ctx.fillStyle = c.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (c.progress > 0) {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(x, y, 36, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.progress);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
