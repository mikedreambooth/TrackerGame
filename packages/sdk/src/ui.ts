/**
 * Shared look for every game: chunky outlined text, title, countdown, timer,
 * score chips, results and pause screens. Canvas 2D, sizes in CSS pixels.
 */
import { PLAYER_COLORS } from './types';

export const theme = {
  font: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
  ink: '#fff8ec',
  accent: '#ffbe0b',
  dark: '#1b1030',
  danger: '#ff4d6d',
  scrim: 'rgba(10, 6, 30, 0.6)',
};

export const playerColor = (slot: number) => PLAYER_COLORS[slot % PLAYER_COLORS.length];
/** Names to say out loud or show, matching PLAYER_COLORS. */
export const PLAYER_NAMES = ['Red', 'Blue', 'Yellow', 'Green'] as const;
export const playerName = (slot: number) => PLAYER_NAMES[slot % PLAYER_NAMES.length];

export interface TextOptions {
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  /** Outline colour, or false for none. Default dark outline. */
  stroke?: string | false;
  weight?: number;
}

/** Big friendly outlined text. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color = theme.ink,
  opts: TextOptions = {},
) {
  ctx.save();
  ctx.font = `${opts.weight ?? 900} ${Math.round(size)}px ${theme.font}`;
  ctx.textAlign = opts.align ?? 'center';
  ctx.textBaseline = opts.baseline ?? 'middle';
  ctx.lineJoin = 'round';
  if (opts.stroke !== false) {
    ctx.lineWidth = Math.max(4, size / 8);
    ctx.strokeStyle = opts.stroke ?? theme.dark;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function scrim(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.6) {
  ctx.save();
  ctx.fillStyle = `rgba(10, 6, 30, ${alpha})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Game title with an instruction underneath (lobby screen). */
export function drawTitle(ctx: CanvasRenderingContext2D, w: number, h: number, title: string, subtitle?: string) {
  drawText(ctx, title, w / 2, h * 0.28, Math.min(h / 7, w / (title.length * 0.6)), theme.accent);
  if (subtitle) drawText(ctx, subtitle, w / 2, h * 0.44, Math.min(h / 15, w / (subtitle.length * 0.55)));
}

/** Pulsing "3, 2, 1". */
export function drawCountdown(ctx: CanvasRenderingContext2D, w: number, h: number, secondsLeft: number) {
  const n = Math.max(1, Math.ceil(secondsLeft));
  const pulse = 1 + (secondsLeft % 1) * 0.35;
  drawText(ctx, String(n), w / 2, h / 2, (Math.min(w, h) / 2.5) * pulse, theme.accent);
}

/** Thin bar across the top; turns red for the last 10 s. */
export function drawTimerBar(ctx: CanvasRenderingContext2D, w: number, fraction: number, secondsLeft?: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(0, 0, w, 14);
  ctx.fillStyle = secondsLeft !== undefined && secondsLeft < 10 ? theme.danger : theme.accent;
  ctx.fillRect(0, 0, w * Math.max(0, Math.min(1, fraction)), 14);
  ctx.restore();
}

/** Coloured score chips along the top-left, one per player slot. */
export function drawScoreChips(ctx: CanvasRenderingContext2D, scores: Record<number, number>) {
  const slots = Object.keys(scores)
    .map(Number)
    .sort((a, b) => a - b);
  ctx.save();
  slots.forEach((s, i) => {
    const x = 20 + i * 130;
    ctx.fillStyle = playerColor(s);
    ctx.beginPath();
    ctx.roundRect(x, 30, 110, 64, 18);
    ctx.fill();
    drawText(ctx, String(scores[s]), x + 55, 63, 40);
  });
  ctx.restore();
}

/** Final scores per player colour, with a star for the winner(s). */
export function drawResults(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scores: Record<number, number>,
  title = 'Time up!',
) {
  scrim(ctx, w, h, 0.55);
  const slots = Object.keys(scores)
    .map(Number)
    .sort((a, b) => a - b);
  const best = Math.max(0, ...slots.map((s) => scores[s]));
  drawText(ctx, title, w / 2, h * 0.16, h / 9, theme.accent);
  slots.forEach((s, i) => {
    const x = (w * (i + 1)) / (slots.length + 1);
    if (best > 0 && scores[s] === best) drawText(ctx, '★', x, h * 0.3, h / 10, theme.accent);
    drawText(ctx, String(scores[s]), x, h * 0.45, h / 6, playerColor(s));
  });
}

/** "Come back!" screen shown while auto-paused. */
export function drawPaused(ctx: CanvasRenderingContext2D, w: number, h: number) {
  scrim(ctx, w, h, 0.65);
  drawText(ctx, 'Paused', w / 2, h * 0.4, h / 7, theme.accent);
  drawText(ctx, 'Step back in to keep playing', w / 2, h * 0.56, h / 16);
}
