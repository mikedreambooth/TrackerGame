/**
 * A knight in the duel — the same rules whether a person or the computer drives it.
 * Something sets `controls` every frame; `update()` turns them into moves.
 */

/** high = a slash at the head (duck or raise the shield), low = at the legs (shield down), thrust = at the body (any shield). */
export type Attack = 'high' | 'low' | 'thrust';
export type ShieldLevel = 'high' | 'low' | null;

/**
 * An arm as seen side-on, in the knight's own frame, measured in shoulder widths
 * from the shoulder: `fwd` towards the opponent, `down` towards the floor.
 */
export interface Arm {
  fwd: number;
  down: number;
}

/** What the driver (body or CPU) wants this frame. */
export interface Controls {
  /** 0 standing … 1 fully ducked. */
  duck: number;
  shieldArm: Arm;
  swordArm: Arm;
  /** Where the shield is covering, or null if it's down by the side. */
  shield: ShieldLevel;
  /** Set for one frame to swing the sword. */
  attack?: Attack;
}

export const REST_SHIELD: Arm = { fwd: 0.5, down: 1.5 };
export const REST_SWORD: Arm = { fwd: 0.6, down: 1.4 };

export const SWING_MS = 420;
/** Fraction of the swing at which it lands (or is blocked). */
const IMPACT = 0.45;
export const SWING_COST = 22;
const STAMINA_REGEN = 16; // per second
const COOLDOWN_MS = 450;
const DAMAGE: Record<Attack, number> = { high: 10, low: 9, thrust: 8 };
/** Holding a duck longer than this stops working — no hiding all round. */
const DODGE_FRESH_MS = 1800;

export type Outcome = 'hit' | 'blocked' | 'dodged' | 'parried';

export class Fighter {
  health = 100;
  stamina = 100;
  // Smoothed pose, for drawing and for defence.
  duck = 0;
  shieldArm: Arm = { ...REST_SHIELD };
  swordArm: Arm = { ...REST_SWORD };
  shield: ShieldLevel = null;
  swing: { kind: Attack; t: number; resolved: boolean } | null = null;
  /** CPU only: telegraphs a swing by winding up first (0..1). */
  windup = 0;
  windupKind: Attack = 'high';
  hitAt = -1e9;
  blockedAt = -1e9;
  tiredAt = -1e9;
  lastOutcome: { what: Outcome; kind: Attack; at: number } | null = null;
  controls: Controls = { duck: 0, shieldArm: { ...REST_SHIELD }, swordArm: { ...REST_SWORD }, shield: null };
  private dodgeSince = 0;
  private lastSwingAt = -1e9;

  constructor(
    public side: 'left' | 'right',
    public color: string,
    public name: string,
    /** Player id driving it, or null for the computer. */
    public playerId: number | null,
  ) {}

  get facing(): 1 | -1 {
    return this.side === 'left' ? 1 : -1;
  }

  get ko(): boolean {
    return this.health <= 0;
  }

  /** Ducking under a high slash (a fresh duck — you can't crouch all round). */
  isDucking(now: number): boolean {
    return this.duck > 0.5 && now - this.dodgeSince < DODGE_FRESH_MS;
  }

  /**
   * Advance one frame. Returns the outcome if our swing reached the opponent this frame.
   */
  update(now: number, dt: number, opponent: Fighter): Outcome | null {
    if (this.ko) {
      this.swing = null;
      return null;
    }
    const c = this.controls;
    const ease = Math.min(1, dt * 14);
    this.duck += (c.duck - this.duck) * ease;
    const armEase = Math.min(1, dt * 18);
    for (const [arm, want] of [
      [this.shieldArm, c.shieldArm],
      [this.swordArm, c.swordArm],
    ] as const) {
      arm.fwd += (want.fwd - arm.fwd) * armEase;
      arm.down += (want.down - arm.down) * armEase;
    }
    this.shield = c.shield;
    if (this.duck <= 0.5) this.dodgeSince = now;
    this.stamina = Math.min(100, this.stamina + STAMINA_REGEN * dt);

    // Start a swing: one at a time, after a short cooldown, not while staggered, and only with the energy for it.
    if (c.attack && !this.swing && now - this.lastSwingAt > COOLDOWN_MS && now - this.hitAt > 300) {
      if (this.stamina >= SWING_COST) {
        this.swing = { kind: c.attack, t: now, resolved: false };
        this.stamina -= SWING_COST;
        this.lastSwingAt = now;
      } else this.tiredAt = now;
    }
    c.attack = undefined;

    let outcome: Outcome | null = null;
    if (this.swing) {
      const p = (now - this.swing.t) / SWING_MS;
      if (!this.swing.resolved && p >= IMPACT) {
        this.swing.resolved = true;
        outcome = opponent.takeSwing(this.swing.kind, now, this);
      }
      if (p >= 1) this.swing = null;
    }
    return outcome;
  }

  private takeSwing(kind: Attack, now: number, attacker: Fighter): Outcome {
    let what: Outcome;
    const covers = this.shield === kind || (kind === 'thrust' && this.shield !== null);
    if (kind === 'high' && this.isDucking(now)) what = 'dodged';
    else if (covers) {
      what = 'blocked';
      this.stamina = Math.max(0, this.stamina - 5);
      attacker.blockedAt = now; // the sword bounces off: a short recoil
    } else if (this.swing && !this.swing.resolved) {
      // Both swung at once: the swords meet.
      what = 'parried';
      this.swing.resolved = true;
      attacker.blockedAt = this.blockedAt = now;
    } else {
      what = 'hit';
      this.health = Math.max(0, this.health - DAMAGE[kind]);
      this.hitAt = now; // a short stagger: no new swing for a moment
    }
    this.lastOutcome = { what, kind, at: now };
    return what;
  }

  /** 0..1 progress of the current swing (out and back), for drawing. */
  swingReach(now: number): number {
    if (!this.swing) return 0;
    const p = (now - this.swing.t) / SWING_MS;
    return p < IMPACT ? p / IMPACT : Math.max(0, 1 - (p - IMPACT) / (1 - IMPACT));
  }

  /** 0..1 raw progress of the current swing. */
  swingProgress(now: number): number {
    return this.swing ? Math.min(1, (now - this.swing.t) / SWING_MS) : 0;
  }
}
