/**
 * A boxer in the ring — the same rules whether a person or the computer drives it.
 * Something sets `controls` every frame; `update()` turns them into moves.
 */

export type Hand = 'lead' | 'rear';

/** What the driver (body or CPU) wants this frame. */
export interface Controls {
  /** 0 standing … 1 fully ducked ("bob"). */
  duck: number;
  /** -1 … 1 leaning to either side ("weave"). Either direction slips a punch. */
  weave: number;
  /** Gloves up by the face. */
  guard: boolean;
  /** Set for one frame to throw a punch. */
  punch?: Hand;
  /** How hard that punch is: 1 normal (0.85 � 1.35 from the player's punch speed). */
  power?: number;
}

export const PUNCH_MS = 330;
/** Fraction of the punch at which it lands (or misses). */
const IMPACT = 0.45;
const PUNCH_COST = 14;
const STAMINA_REGEN = 20; // per second
const HIT_DAMAGE = 9;
const BLOCK_DAMAGE = 2;
/** Holding a dodge longer than this stops working — no hiding all round. */
const DODGE_FRESH_MS = 1800;

export type Outcome = 'hit' | 'blocked' | 'dodged';

export class Fighter {
  health = 100;
  stamina = 100;
  // Smoothed pose, for drawing and for defence.
  duck = 0;
  weave = 0;
  guard = false;
  punch: { hand: Hand; t: number; resolved: boolean; power: number } | null = null;
  /** CPU only: telegraphs a punch by pulling the glove back first. */
  windup = 0;
  windupHand: Hand = 'rear';
  hitAt = -1e9;
  lastOutcome: { what: Outcome; at: number } | null = null;
  controls: Controls = { duck: 0, weave: 0, guard: false };
  private dodgeSince = 0;

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

  /** Is this fighter currently slipping punches (fresh duck/weave)? */
  isDodging(now: number): boolean {
    const dodging = this.duck > 0.5 || Math.abs(this.weave) > 0.5;
    return dodging && now - this.dodgeSince < DODGE_FRESH_MS;
  }

  /**
   * Advance one frame. Returns the outcome if one of our punches reached the
   * opponent this frame.
   */
  update(now: number, dt: number, opponent: Fighter): Outcome | null {
    if (this.ko) {
      this.punch = null;
      return null;
    }
    const c = this.controls;
    const ease = Math.min(1, dt * 14);
    this.duck += (c.duck - this.duck) * ease;
    this.weave += (c.weave - this.weave) * ease;
    this.guard = c.guard;
    const dodging = this.duck > 0.5 || Math.abs(this.weave) > 0.5;
    if (!dodging) this.dodgeSince = now;
    this.stamina = Math.min(100, this.stamina + STAMINA_REGEN * dt);

    // Start a punch (not while one is already flying, and only with the energy for it).
    if (c.punch && !this.punch && this.stamina >= PUNCH_COST && now - this.hitAt > 250) {
      this.punch = { hand: c.punch, t: now, resolved: false, power: c.power ?? 1 };
      this.stamina -= PUNCH_COST;
    }
    c.punch = undefined;

    let outcome: Outcome | null = null;
    if (this.punch) {
      const p = (now - this.punch.t) / PUNCH_MS;
      if (!this.punch.resolved && p >= IMPACT) {
        this.punch.resolved = true;
        outcome = opponent.takePunch(now, this.punch.power);
      }
      if (p >= 1) this.punch = null;
    }
    return outcome;
  }

  private takePunch(now: number, power: number): Outcome {
    let what: Outcome;
    if (this.isDodging(now)) what = 'dodged';
    else if (this.guard) {
      what = 'blocked';
      this.health = Math.max(0, this.health - BLOCK_DAMAGE);
    } else {
      what = 'hit';
      this.health = Math.max(0, this.health - HIT_DAMAGE * power);
      this.hitAt = now; // a short stagger: no new punch for a moment
    }
    this.lastOutcome = { what, at: now };
    return what;
  }

  /** 0..1 progress of the current punch's reach (out and back). */
  punchReach(now: number): number {
    if (!this.punch) return 0;
    const p = (now - this.punch.t) / PUNCH_MS;
    return p < IMPACT ? p / IMPACT : Math.max(0, 1 - (p - IMPACT) / (1 - IMPACT));
  }
}
