import { KP, type Frame, type Player, type PlayerTransform, type Vec2 } from './types';

/**
 * How players are placed on screen (see PlayerLayout):
 * - 'free': each player's actual position and size, as the camera sees them (as tracked):
 *   for games where players roam the whole picture. 'camera' is the same (older name).
 * - 'normalised': everyone the same standing height, feet on the baseline, each still where
 *   they stand left to right.
 * - 'spread': normalised, and each given an equal lane of the screen in left-to-right order,
 *   so they never overlap however bunched up they stand. Where they stand across the room
 *   maps into their lane, so moving sideways still moves them (alone, across the whole
 *   screen). The default for games.
 * - 'custom': normalised, with a place per slot from `slots` (e.g. facing sides for a duel).
 */
export type LayoutMode = 'free' | 'camera' | 'normalised' | 'spread' | 'custom';

/** Where one slot's player goes in a 'custom' layout. All in screen fractions. */
export interface SlotPlace {
  /** Body centre across the whole screen (0 = left edge, 1 = right edge). */
  x: number;
  /** Baseline their feet stand on (0 = top, 1 = bottom). Default: the layout's baseline. */
  baseline?: number;
  /** Standing height as a fraction of the screen height. Default LAYOUT.height. */
  height?: number;
}

export type Layout =
  | LayoutMode
  | {
      mode: LayoutMode;
      /** Standing height, fraction of the screen height (default LAYOUT.height). */
      height?: number;
      /** Baseline for everyone in this layout (default: the tracker's, else LAYOUT.baseline). */
      baseline?: number;
      /** 'custom': a place per slot; slots without one are spread over the rest of the screen. */
      slots?: SlotPlace[];
    };

export const LAYOUT = {
  /** Standing height, as a fraction of the screen height. */
  height: 0.62,
  /**
   * The baseline: where players' feet are drawn by default (fraction of the screen height from
   * the top), padded up a little from the bottom edge. The tracker can set its own default
   * (`--baseline`), and games can override it for everyone or per player.
   */
  baseline: 0.95,
  /** 'spread': room left at each side of the screen (fraction of its width). */
  margin: 0.08,
  /** Standing height ≈ this many torso lengths (shoulders to hips), for adults and children. */
  heightPerTorso: 3.2,
  /** Body-size smoothing (s): grows quickly, shrinks slowly, so bending or crouching doesn't shrink anyone. */
  sizeUpTau: 0.6,
  sizeDownTau: 4,
  /** Floor smoothing (s): follows the feet down quickly and up slowly, so jumps still show. */
  floorDownTau: 0.08,
  floorUpTau: 2,
  /** 'spread': the part of the camera's width (centre x) people stand in, mapped onto each lane. */
  roomLeft: 0.1,
  roomRight: 0.9,
  /** How slowly the left-to-right order (and a 'custom' resting place) follows where people stand (s). */
  homeTau: 1.5,
  /** 'spread': how quickly lanes glide to their new places when someone joins or leaves (s). */
  moveTau: 0.35,
  /** Scale limits, so a misdetection can't blow someone up. */
  minScale: 0.35,
  maxScale: 3,
};

interface State {
  torso: number;
  floor: number;
  home: number;
  /** Eased lane (screen fractions) in 'spread', or place in 'custom' (lo = hi). */
  lo: number | null;
  hi: number;
  t: number;
}

const IDENTITY: PlayerTransform = { scale: 1, x: 0, y: 0 };

/**
 * The layout stage: takes the PlayerTracker's frame (players where the camera sees them) and
 * moves and scales each player as a whole (a uniform scale plus a shift, so their shape and
 * gestures are unchanged) so that games get players laid out the way they want. Their
 * camera-space measurements stay on `player.raw`, the transform used on `player.transform`.
 *
 * Positions are in the usual normalised camera coordinates (mapped to the screen with
 * screenMapper()'s default 'height' fit), so a player can also be placed out to the sides
 * of a wide screen where the camera picture doesn't reach.
 */
export class PlayerLayout {
  private layout: Exclude<Layout, LayoutMode> = { mode: 'spread' };
  /** The default baseline (from the tracker when it says, else LAYOUT.baseline). */
  defaultBaseline = LAYOUT.baseline;
  /** Per-slot baselines set by the game (setBaseline(y, slot)). */
  private slotBaselines = new Map<number, number>();
  /** Game-wide baseline set by the game (setBaseline(y)); null = the default. */
  private gameBaseline: number | null = null;
  /** Everyone drawn the same height (setNormalise). Off: real relative sizes, as the camera sees them. */
  private normalise = true;
  /** Standing height when normalised, fraction of the screen height (null = layout's / LAYOUT.height). */
  private playerHeight: number | null = null;
  private state = new Map<number, State>();
  /** Player ids left to right ('spread' order, with hysteresis). */
  private order: number[] = [];

  constructor(
    layout: Layout = 'spread',
    /** Screen width / height (the page the players are drawn on). */
    private screenAspect: () => number = () => innerWidth / Math.max(1, innerHeight),
  ) {
    this.set(layout);
  }

  get mode(): LayoutMode {
    return this.layout.mode;
  }

  /**
   * Where players' feet go: for everyone (no slot) or one player slot. null goes back to the
   * default. Most specific wins: per slot > game-wide > the layout's own > the default.
   */
  setBaseline(y: number | null, slot?: number): void {
    const v = y === null ? null : Math.min(1, Math.max(0, y));
    if (slot === undefined) this.gameBaseline = v;
    else if (v === null) this.slotBaselines.delete(slot);
    else this.slotBaselines.set(slot, v);
  }

  /** The baseline for a slot right now (see setBaseline). */
  baselineFor(slot?: number): number {
    const own = slot === undefined ? undefined : this.slotBaselines.get(slot);
    return own ?? this.gameBaseline ?? this.layout.baseline ?? this.defaultBaseline;
  }

  /**
   * Draw every player the same height on screen (on, the default), at `height` (fraction of the
   * screen height; omit to keep the current one) — or off: keep their real relative sizes, as
   * the camera sees them (a child stays smaller than an adult), still standing on the baseline.
   */
  setNormalise(on: boolean, height?: number): void {
    this.normalise = on;
    if (height !== undefined) this.playerHeight = Math.min(1, Math.max(0.05, height));
  }

  /** Back to the defaults for a new game: default baseline, normalised at the default height. */
  resetGameSettings(): void {
    this.slotBaselines.clear();
    this.gameBaseline = null;
    this.normalise = true;
    this.playerHeight = null;
  }

  set(layout: Layout): void {
    const next = typeof layout === 'string' ? { mode: layout } : { ...layout };
    if (next.mode !== this.layout.mode) for (const s of this.state.values()) s.lo = null; // jump to new places
    this.layout = next;
  }

  apply(frame: Frame): Frame {
    const { t, aspect } = frame;
    const L = this.layout;
    for (const [id, s] of this.state) if (t - s.t > 3000) this.state.delete(id);
    const baseline = this.baselineFor();
    if (L.mode === 'free' || L.mode === 'camera') return { ...frame, baseline, players: frame.players.map((p) => laidOut(p, IDENTITY)) };

    // Screen fraction (across the whole screen) -> normalised camera x.
    const sa = this.screenAspect();
    const toX = (fx: number) => (fx * sa - (sa - aspect) / 2) / aspect;
    const height = this.playerHeight ?? L.height ?? LAYOUT.height;

    const states = frame.players.map((p) => this.measure(p, t, aspect));
    const ordered = this.reorder(frame.players, states);
    // Spread places for everyone without a custom one.
    const custom = L.mode === 'custom' ? (L.slots ?? []) : [];
    const free = ordered.filter((p) => !custom[p.slot]);
    const span = 1 - 2 * LAYOUT.margin;

    const players = frame.players.map((p, i) => {
      const s = states[i];
      const place = custom[p.slot];
      const h = place?.height ?? height;
      // Not normalised: their real size (camera scale), still standing on the baseline.
      const scale = this.normalise ? Math.min(LAYOUT.maxScale, Math.max(LAYOUT.minScale, h / (s.torso * LAYOUT.heightPerTorso))) : 1;
      const feetAt = this.slotBaselines.get(p.slot) ?? place?.baseline ?? this.baselineFor();
      const y = feetAt - s.floor * scale;
      if (L.mode === 'normalised') {
        // Scale about their own centre line: they stay where they stand.
        return laidOut(p, { scale, x: p.center.x * (1 - scale), y });
      }
      let lo: number, hi: number;
      if (place) lo = hi = place.x;
      else {
        const n = Math.max(1, free.length);
        lo = LAYOUT.margin + (free.indexOf(p) * span) / n;
        hi = lo + span / n;
      }
      const dt = Math.min(0.2, (t - s.t) / 1000 || 0);
      const k = 1 - Math.exp(-dt / LAYOUT.moveTau);
      if (s.lo === null) [s.lo, s.hi] = [lo, hi];
      else [s.lo, s.hi] = [s.lo + (lo - s.lo) * k, s.hi + (hi - s.hi) * k];
      let x: number;
      if (place) {
        // At their place, plus how far they've stepped from where they usually stand.
        x = toX(s.lo) + (p.center.x - s.home) * scale;
      } else {
        // Where they stand across the room, mapped into their lane, keeping their body (about
        // a quarter of their height either side, arms out) inside it where the lane allows.
        const f = (p.center.x - LAYOUT.roomLeft) / (LAYOUT.roomRight - LAYOUT.roomLeft);
        const pad = Math.min((s.hi - s.lo) / 2, (h * 0.25) / sa);
        x = toX(s.lo + pad + Math.min(1, Math.max(0, f)) * (s.hi - s.lo - 2 * pad));
      }
      return laidOut(p, { scale, x: x - p.center.x * scale, y });
    });
    for (const s of states) s.t = t;
    return { ...frame, baseline, players };
  }

  /** Update a player's smoothed size, floor and resting place (camera space). */
  private measure(p: Player, t: number, aspect: number): State {
    const k = p.keypoints;
    const seen = (i: number) => k[i].score >= 0.35;
    let torso = 0;
    let hipY: number | null = null;
    if (seen(KP.leftShoulder) && seen(KP.rightShoulder) && seen(KP.leftHip) && seen(KP.rightHip)) {
      const sh = mid(k[KP.leftShoulder], k[KP.rightShoulder]);
      const hip = mid(k[KP.leftHip], k[KP.rightHip]);
      torso = Math.hypot((sh.x - hip.x) * aspect, sh.y - hip.y);
      hipY = hip.y;
    } else torso = p.shoulderWidth * 1.4;
    torso = Math.max(torso, 0.02);
    const ankles = [KP.leftAnkle, KP.rightAnkle].filter((i) => k[i].score >= 0.3).map((i) => k[i].y);
    const feet = ankles.length ? Math.max(...ankles) : (hipY ?? p.center.y + torso / 2) + 1.55 * torso;

    let s = this.state.get(p.id);
    if (!s) {
      s = { torso, floor: feet, home: p.center.x, lo: null, hi: 0, t };
      this.state.set(p.id, s);
      return s;
    }
    const dt = Math.min(0.5, Math.max(0, (t - s.t) / 1000));
    const ease = (v: number, to: number, tau: number) => v + (to - v) * (1 - Math.exp(-dt / tau));
    s.torso = ease(s.torso, torso, torso > s.torso ? LAYOUT.sizeUpTau : LAYOUT.sizeDownTau);
    s.floor = ease(s.floor, feet, feet > s.floor ? LAYOUT.floorDownTau : LAYOUT.floorUpTau);
    s.home = ease(s.home, p.center.x, LAYOUT.homeTau);
    return s;
  }

  /** Players left to right by where they usually stand; neighbours swap only when clearly crossed. */
  private reorder(players: Player[], states: State[]): Player[] {
    const ids = new Set(players.map((p) => p.id));
    const home = new Map(players.map((p, i) => [p.id, states[i].home]));
    this.order = this.order.filter((id) => ids.has(id));
    for (const p of players) {
      if (this.order.includes(p.id)) continue;
      const at = this.order.findIndex((id) => home.get(id)! > home.get(p.id)!);
      this.order.splice(at < 0 ? this.order.length : at, 0, p.id);
    }
    for (let swapped = true; swapped; ) {
      swapped = false;
      for (let i = 0; i + 1 < this.order.length; i++) {
        if (home.get(this.order[i])! > home.get(this.order[i + 1])! + 0.05) {
          [this.order[i], this.order[i + 1]] = [this.order[i + 1], this.order[i]];
          swapped = true;
        }
      }
    }
    const byId = new Map(players.map((p) => [p.id, p]));
    return this.order.map((id) => byId.get(id)!);
  }
}

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A camera-space point -> where the layout put it. */
export function layoutPoint(tf: PlayerTransform, p: Vec2): Vec2 {
  return { x: p.x * tf.scale + tf.x, y: p.y * tf.scale + tf.y };
}

/** The player moved and scaled by `tf`; their camera-space measurements kept on `raw`. */
function laidOut(p: Player, tf: PlayerTransform): Player {
  const raw = p.raw ?? {
    keypoints: p.keypoints,
    center: p.center,
    bbox: p.bbox,
    shoulderWidth: p.shoulderWidth,
    armLength: p.armLength,
  };
  const s = tf.scale;
  return {
    ...p,
    keypoints: raw.keypoints.map((k) => ({
      ...k,
      x: k.x * s + tf.x,
      y: k.y * s + tf.y,
      z: k.z * s,
      vx: k.vx * s,
      vy: k.vy * s,
      vz: k.vz * s,
    })),
    center: layoutPoint(tf, raw.center),
    bbox: { x: raw.bbox.x * s + tf.x, y: raw.bbox.y * s + tf.y, w: raw.bbox.w * s, h: raw.bbox.h * s },
    shoulderWidth: raw.shoulderWidth * s,
    armLength: raw.armLength * s,
    raw,
    transform: tf,
  };
}
