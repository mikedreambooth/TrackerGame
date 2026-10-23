import { CURSOR, handRaised, measureReach, reachToScreen } from './cursor';
import { BONES, KP, type Player, type Vec2 } from './types';

/**
 * Size a canvas to its CSS box at device pixel ratio. Call on every frame (cheap)
 * or on resize. Returns the size in CSS pixels; the context is pre-scaled.
 */
export function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/**
 * Maps normalised camera coordinates onto a w×h screen, preserving proportions.
 * "height" (default): the camera's full height fills the screen's, so heads and feet are
 *   never cut off and people stand at the bottom; the sides are cropped or left empty.
 * "cover": the camera image fills the screen, cropping edges.
 * "contain": the whole image is visible, with bars at the sides or top and bottom.
 */
export function screenMapper(aspect: number, w: number, h: number, fit: 'height' | 'cover' | 'contain' = 'height') {
  const k = fit === 'height' ? h : (fit === 'cover' ? Math.max : Math.min)(w / aspect, h);
  const ox = (w - aspect * k) / 2;
  const oy = (h - k) / 2;
  return {
    /** Normalised → pixels. */
    map: (p: Vec2): Vec2 => ({ x: ox + p.x * aspect * k, y: oy + p.y * k }),
    /** Normalised length → pixels. */
    len: (n: number) => n * k,
  };
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  player: Player,
  map: (p: Vec2) => Vec2,
  opts: { lineWidth?: number; alpha?: number; head?: boolean; minScore?: number } = {},
) {
  const { lineWidth = 8, alpha = 1, head = true, minScore = 0.3 } = opts;
  const k = player.keypoints;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = player.color;
  ctx.fillStyle = player.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    if (k[a].score < minScore || k[b].score < minScore) continue;
    const pa = map(k[a]);
    const pb = map(k[b]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  if (head && k[KP.nose].score >= minScore) {
    const n = map(k[KP.nose]);
    const ls = map(k[KP.leftShoulder]);
    const rs = map(k[KP.rightShoulder]);
    const r = Math.max(10, Math.hypot(ls.x - rs.x, ls.y - rs.y) * 0.35);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Which hand is "pointing": the higher of the two wrists, if raised above the hips. Stateless; see handCursor(). */
export function pointingHand(player: Player, aspect = 4 / 3): number | null {
  const k = player.keypoints;
  const r = measureReach(k, player.armLength, aspect);
  if (!r) return null;
  const cands = [KP.leftWrist, KP.rightWrist].filter((i) => k[i].score >= CURSOR.minScore && handRaised(r, k[i]));
  if (!cands.length) return null;
  return cands.reduce((a, b) => (k[a].y < k[b].y ? a : b));
}

/**
 * Body-relative cursor, in screen fractions 0..1, or null when no hand is raised above the
 * player's hips. Hand height maps from the hips (bottom of the screen) to the top of their
 * reach (top), and sideways across their own arm span, so a small child and a tall adult
 * both reach every corner without walking. Players from the PlayerTracker carry a smoothed
 * cursor with hysteresis (`player.cursor`), which this returns; for anything else it works
 * it out from the keypoints (pass the camera aspect).
 */
export function handCursor(player: Player, aspect = 4 / 3): Vec2 | null {
  if (player.cursor !== undefined) return player.cursor;
  const hand = pointingHand(player, aspect);
  if (hand === null) return null;
  const r = measureReach(player.keypoints, player.armLength, aspect)!;
  return reachToScreen(r, player.keypoints[hand]);
}
