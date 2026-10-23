import { fitCanvas, screenMapper } from './draw';
import { layoutPoint } from './layout';
import type { Cutout, Frame, InputSource, Player, Segmentation } from './types';
import { drawText } from './ui';

const KEY = 'tg.cameraGhost';

/**
 * Whether the viewer wants the people cut-outs shown (G toggles it; remembered on this
 * device). Shared by the launcher and its games (same origin).
 */
export function cameraGhostWanted(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true; // storage blocked
  }
}

/**
 * The camera picture an input source can show, the way it was tracked: its preview (the
 * native tracker's frames, or the browser tracker's picture turned the right way up) or
 * else its video.
 */
export function cameraImage(source: InputSource): () => CanvasImageSource | null {
  return () => source.preview?.() ?? (source.video && source.video.readyState >= 2 ? source.video : null);
}

/** A player where the camera sees them (before any layout). */
function cameraSpace(p: Player): Player {
  return p.raw ? { ...p, ...p.raw } : p;
}

/** Cut-outs older than this aren't shown (the tracker stopped sending them). */
export const PEOPLE_STALE_MS = 1000;

/**
 * Cut-out -> player: the one the tracker says (protocol v2), else the one whose torso centre
 * is nearest the cut-out's pose's (each used once).
 */
function matchCutouts(people: Cutout[], players: Player[], aspect: number): (Player | null)[] {
  const pairs: [number, number, number][] = [];
  people.forEach((c, i) => {
    if (c.player !== undefined && c.player >= 0) {
      const j = players.findIndex((p) => p.id === c.player);
      if (j >= 0) pairs.push([-1, i, j]); // first in line
      return;
    }
    if (!c.anchor) return;
    const ax = 1 - c.anchor.x; // mirrored, like players
    players.forEach((p, j) => {
      const d = Math.hypot((p.center.x - ax) * aspect, p.center.y - c.anchor!.y);
      if (d < 0.2) pairs.push([d, i, j]);
    });
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const out: (Player | null)[] = people.map(() => null);
  const used = new Set<number>();
  for (const [, i, j] of pairs) {
    if (out[i] || used.has(j)) continue;
    out[i] = players[j];
    used.add(j);
  }
  return out;
}

export interface DrawPeopleOptions {
  /** See-through-ness of the people, 0..1. Default 0.55. */
  opacity?: number;
  /** A soft glow in each player's colour. Default true. */
  glow?: boolean;
  /** How the camera maps onto the canvas, as for screenMapper(); use the game's own. Default 'height'. */
  fit?: 'height' | 'cover' | 'contain';
}

/**
 * Draw the people cut out of the camera picture (Segmentation) onto a canvas `w` × `h`
 * (CSS pixels, as fitCanvas() returns): mirrored and lined up with the players the way
 * screenMapper() maps them by default, moved and scaled with each player by the layout (see
 * PlayerLayout), kept on each player's torso between cut-outs, with a glow in their colour.
 * People who aren't players yet show where the camera sees them (unless the players are
 * laid out elsewhere). Low-level: games normally call game.drawPeople() instead.
 */
export function drawPeople(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  seg: Segmentation | null,
  w: number,
  h: number,
  opts: DrawPeopleOptions = {},
): void {
  if (!seg || !seg.people.length) return;
  const { map, len } = screenMapper(frame.aspect, w, h, opts.fit);
  const owners = matchCutouts(seg.people, frame.players.map(cameraSpace), frame.aspect);
  const laidOut = frame.players.some((p) => p.transform && (p.transform.scale !== 1 || p.transform.x || p.transform.y));
  seg.people.forEach((c, i) => {
    const owner = owners[i];
    if (!owner && laidOut) return;
    const player = owner && frame.players.find((p) => p.id === owner.id);
    const tf = player?.transform ?? { scale: 1, x: 0, y: 0 };
    // Keep the picture on the player as they move between cut-outs (~12 a second).
    const dx = owner && c.anchor ? owner.center.x - (1 - c.anchor.x) : 0;
    const dy = owner && c.anchor ? owner.center.y - c.anchor.y : 0;
    // Mirrored camera box, then placed the way the layout placed this player.
    const a = map(layoutPoint(tf, { x: 1 - c.box.x1 + dx, y: c.box.y0 + dy }));
    const b = map(layoutPoint(tf, { x: 1 - c.box.x0 + dx, y: c.box.y1 + dy }));
    ctx.save();
    ctx.globalAlpha = opts.opacity ?? 0.55;
    if (player && opts.glow !== false) {
      ctx.shadowColor = player.color;
      ctx.shadowBlur = Math.max(6, len(0.025));
    }
    ctx.translate(b.x, a.y); // mirrored, like the tracked keypoints
    ctx.scale(-1, 1);
    ctx.drawImage(c.image, 0, 0, b.x - a.x, b.y - a.y);
    ctx.restore();
  });
}

/**
 * Where CameraGhost's cut-outs go: 'overlay' (its own canvas over the whole page, above
 * everything), 'elsewhere' (something else draws them with drawPeople(), e.g. a game behind
 * its menus, or the launcher behind its tiles: the ghost just keeps them coming) or 'off'.
 */
export type GhostMode = 'overlay' | 'elsewhere' | 'off';

/**
 * The people in front of the camera, cut out of the room and drawn see-through (see
 * drawPeople()). By default over the whole page; set `mode` to draw them yourself (behind
 * menus) with drawPeople(ctx, frame, ghost.segmentation(), w, h). Needs a source with
 * segmentation() (the native tracker); others show nothing. On unless turned off: toggle
 * with G (or toggle()), remembered on this device. Games that draw players their own way
 * (avatars) won't line up with it.
 */
export class CameraGhost {
  on = true;
  mode: GhostMode = 'overlay';
  /** Called after G (or toggle()) switches it. */
  onToggle: ((on: boolean) => void) | null = null;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private toggledAt = -Infinity;
  private running = false;
  private hint = '';
  private hintAt = -Infinity;
  private hinted = false;
  private since = 0;

  constructor(
    private source: InputSource,
    private frame: () => Frame,
    private opacity = 0.55,
  ) {
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50';
    document.body.append(this.canvas);
    this.on = cameraGhostWanted();
    addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (e.code === 'KeyG' && !e.repeat && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) this.toggle();
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
    this.onToggle?.(this.on);
  }

  /**
   * The latest cut-outs while they're wanted (on, and mode isn't 'off') and fresh, else null.
   * Calling it keeps the source sending them.
   */
  segmentation(): Segmentation | null {
    if (!this.on || this.mode === 'off') return null;
    const seg = this.source.segmentation?.() ?? null;
    return seg && performance.now() - seg.t < PEOPLE_STALE_MS ? seg : null;
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
    if (this.on && this.mode !== 'off') {
      this.since ||= now;
      // Asks the source every frame, whoever draws them, so they keep coming.
      const seg = this.segmentation();
      if (!this.source.segmentation) this.showHint('Camera overlay needs the native tracker', now);
      else if (!this.source.segmentation() && now - this.since > 6000) this.showHint('No camera cut-outs from the tracker (update it?)', now);
      if (this.mode === 'overlay') drawPeople(ctx, this.frame(), seg, w, h, { opacity: this.opacity });
    } else this.since = 0;
    // Say what G did, briefly.
    const since = now - this.toggledAt;
    if (since < 1500) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (1500 - since) / 300);
      const text = !this.on ? 'Camera overlay off (G)' : 'Camera overlay on (G)';
      drawText(ctx, text, 16, h - 28, Math.max(16, h / 36), '#fff', { align: 'left' });
      ctx.restore();
    } else if (now - this.hintAt < 4000) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (4000 - (now - this.hintAt)) / 500) * 0.8;
      drawText(ctx, this.hint, w - 16, h - 28, Math.max(14, h / 44), '#fff', { align: 'right' }); // clear of the simulator's buttons
      ctx.restore();
    }
    if (this.on || since < 1500 || now - this.hintAt < 4000) requestAnimationFrame(this.draw);
    else this.running = false;
  };

  /** A small note, once per page, when there's nothing to show. */
  private showHint(text: string, now: number) {
    if (this.hinted) return;
    this.hinted = true;
    this.hint = text;
    this.hintAt = now;
  }
}
