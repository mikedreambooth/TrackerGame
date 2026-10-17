import { handCursor } from './draw';
import type { Player } from './types';
import { drawText, theme } from './ui';

/**
 * A button you "press" by holding a raised hand over it — the same interaction
 * as the launcher's game tiles. Position and size are fractions of the screen
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

  constructor(
    public buttons: DwellButton[],
    public dwellMs = 1200,
  ) {}

  /** Returns a button id the moment a player has held a hand over it for `dwellMs`, otherwise null. */
  update(players: Player[], now: number): string | null {
    this.cursors = [];
    this.hovered.clear();
    let picked: string | null = null;
    for (const p of players) {
      const c = handCursor(p);
      if (!c) {
        this.holds.delete(p.id);
        continue;
      }
      const b = this.buttons.find(
        (b) => Math.abs(c.x - b.x) <= b.w / 2 && Math.abs(c.y - b.y) <= b.h / 2,
      );
      let progress = 0;
      if (b) {
        const hold = this.holds.get(p.id);
        if (!hold || hold.id !== b.id) this.holds.set(p.id, { id: b.id, since: now });
        else progress = Math.min(1, (now - hold.since) / this.dwellMs);
        this.hovered.set(b.id, Math.max(this.hovered.get(b.id) ?? 0, progress));
        if (progress >= 1 && !picked) {
          picked = b.id;
          this.holds.clear();
        }
      } else this.holds.delete(p.id);
      this.cursors.push({ ...c, color: p.color, progress });
    }
    return picked;
  }

  /** Draws buttons (highlighted while hovered) and every player's hand cursor. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
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
      drawText(ctx, b.label, b.x * w, b.y * h, Math.min(bh * 0.42, bw / (b.label.length * 0.55)));
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
