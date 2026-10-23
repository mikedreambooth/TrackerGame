import { KP, type Player, type Vec2 } from '@trackergame/sdk';

/** How long two players hold raised hands together to pass the choice on. */
export const PASS_HOLD_MS = 5000;
/** How long a chooser who has left keeps the choice before it goes to someone else. */
const AWAY_MS = 4000;
/** Hands count as joined when the wrists are closer than this many shoulder widths… */
const JOIN_DIST = 0.6;
/** …and as let go when further than this (in between, the hold carries on). */
const PART_DIST = 1.0;
/** Tracking blips (wrists not seen) up to this long don't reset a hold. */
const DROPOUT_MS = 800;
/** Hands seen apart for this long do. */
const APART_MS = 250;

const COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Green'];
export const colorName = (slot: number) => COLOR_NAMES[slot % COLOR_NAMES.length];

interface Hold {
  other: number;
  since: number;
  /** Last time the hands were seen together. */
  touchAt: number;
  /** Midpoint of the joined wrists (normalised camera coordinates). */
  at: Vec2;
}

/**
 * Who picks the game on the home screen. One present player holds the choice: picked at
 * random when people first arrive, handed to a game's winner, or passed on when the
 * chooser holds raised hands with someone else for 5 s. If the chooser walks off it waits
 * a few seconds for them (they keep their id when they come straight back), then goes to
 * someone else.
 */
export class Chooser {
  id: number | null = null;
  hold: Hold | null = null;
  private awaySince = 0;
  private cooldownUntil = 0;

  constructor(private announce: (text: string) => void) {}

  /** True while a hand-hold is under way (the chooser's cursor shouldn't press things then). */
  get passing(): boolean {
    return this.hold !== null && performance.now() - this.hold.since > 300;
  }

  isChooser(p: Player): boolean {
    return p.id === this.id;
  }

  /** Hand the choice to this player, saying `text` (when more than one person is there). */
  giveTo(p: Player, players: Player[], text: string): void {
    console.info(`[chooser] id ${p.id} (P${p.slot + 1}): ${text}`);
    this.id = p.id;
    this.hold = null;
    this.awaySince = 0;
    if (players.length > 1) this.announce(text);
  }

  update(players: Player[], now: number, aspect: number): void {
    if (!players.length) {
      this.hold = null;
      return; // keep the choice for whoever comes back
    }
    const chooser = players.find((p) => p.id === this.id);
    if (!chooser) {
      if (this.id !== null && !this.awaySince) this.awaySince = now;
      if (this.id === null || now - this.awaySince > AWAY_MS) {
        const p = players[Math.floor(Math.random() * players.length)];
        this.giveTo(p, players, `${colorName(p.slot)} picks the game!`);
      }
      this.hold = null;
      return;
    }
    this.awaySince = 0;
    if (players.length < 2 || now < this.cooldownUntil) {
      this.hold = null;
      return;
    }
    this.handHold(chooser, players, now, aspect);
  }

  private handHold(c: Player, players: Player[], now: number, aspect: number): void {
    const wrists = [KP.leftWrist, KP.rightWrist];
    const hipY = (p: Player) => {
      const k = p.keypoints;
      return k[KP.leftHip].score > 0.35 && k[KP.rightHip].score > 0.35
        ? (k[KP.leftHip].y + k[KP.rightHip].y) / 2
        : (k[KP.leftShoulder].y + k[KP.rightShoulder].y) / 2 + 1.4 * p.shoulderWidth;
    };
    const scale = (p: Player) => {
      const k = p.keypoints;
      return Math.hypot((k[KP.leftShoulder].x - k[KP.rightShoulder].x) * aspect, k[KP.leftShoulder].y - k[KP.rightShoulder].y);
    };
    // The closest pair of raised wrists between the chooser and anyone else.
    let best: { other: Player; d: number; at: Vec2; S: number } | null = null;
    let seen = false; // the held pair's wrists are visible (so "apart" means apart, not lost)
    for (const o of players) {
      if (o === c) continue;
      const S = Math.max((scale(c) + scale(o)) / 2, 0.02);
      for (const a of wrists) {
        for (const b of wrists) {
          const wa = c.keypoints[a];
          const wb = o.keypoints[b];
          if (wa.score < 0.35 || wb.score < 0.35) continue;
          if (this.hold?.other === o.id) seen = true;
          if (wa.y > hipY(c) || wb.y > hipY(o)) continue; // hands must be up, not hanging by the sides
          const d = Math.hypot((wa.x - wb.x) * aspect, wa.y - wb.y) / S;
          if (!best || d < best.d) best = { other: o, d, at: { x: (wa.x + wb.x) / 2, y: (wa.y + wb.y) / 2 }, S };
        }
      }
    }
    const h = this.hold;
    const together = best && best.d < (h?.other === best.other.id ? PART_DIST : JOIN_DIST);
    if (together && best) {
      if (h && h.other === best.other.id) {
        h.touchAt = now;
        h.at = best.at;
      } else if (!h || now - h.touchAt > APART_MS) {
        this.hold = { other: best.other.id, since: now, touchAt: now, at: best.at };
      }
    } else if (h) {
      const gone = !players.some((p) => p.id === h.other);
      if (gone || now - h.touchAt > (seen ? APART_MS : DROPOUT_MS)) this.hold = null;
    }
    if (this.hold && now - this.hold.since >= PASS_HOLD_MS) {
      const to = players.find((p) => p.id === this.hold!.other);
      this.hold = null;
      this.cooldownUntil = now + 1500;
      if (to) this.giveTo(to, players, `${colorName(to.slot)} picks the game now!`);
    }
  }

  /** Progress 0..1 of the hand-hold under way. */
  holdProgress(now: number): number {
    return this.hold ? Math.min(1, (now - this.hold.since) / PASS_HOLD_MS) : 0;
  }
}

/** A gold crown centred at (x, y), `s` wide. */
export function drawCrown(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(-0.5 * s, 0.3 * s);
  ctx.lineTo(-0.5 * s, -0.25 * s);
  ctx.lineTo(-0.25 * s, 0.02 * s);
  ctx.lineTo(0, -0.35 * s);
  ctx.lineTo(0.25 * s, 0.02 * s);
  ctx.lineTo(0.5 * s, -0.25 * s);
  ctx.lineTo(0.5 * s, 0.3 * s);
  ctx.closePath();
  ctx.fillStyle = '#ffd60a';
  ctx.strokeStyle = '#1b1030';
  ctx.lineWidth = Math.max(3, s / 14);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = '#ff4d6d';
  for (const px of [-0.5, 0, 0.5]) {
    ctx.beginPath();
    ctx.arc(px * s, (px === 0 ? -0.35 : -0.25) * s, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** The filling ring over two joined hands. */
export function drawHoldRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, progress: number, color: string, now: number) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = r * 0.22;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
  // Sparkles chasing round the ring.
  ctx.fillStyle = '#ffd60a';
  for (let i = 0; i < 3; i++) {
    const a = now / 300 + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r * 1.35, y + Math.sin(a) * r * 1.35, r * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
