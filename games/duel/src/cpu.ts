/**
 * Computer knight: fair and readable for kids. It always telegraphs a swing —
 * sword raised high, held low, or pulled back for a thrust, with a big HIGH / LOW /
 * THRUST sign over its head — so you can get your shield to the right place.
 * It sometimes blocks or ducks your swings, and gets a little sharper each round.
 */
import { REST_SHIELD, REST_SWORD, type Attack, type Controls, type Fighter, type ShieldLevel } from './fighter';

export class CpuBrain {
  private nextSwingAt = 0;
  private windupStart = 0;
  private kind: Attack = 'high';
  private defendUntil = 0;
  private defence: ShieldLevel | 'duck' = null;
  private reactedTo = 0;
  private lastHitSeen = 0;

  constructor(public skill = 0.45) {}

  /** Forget any wind-up from the break, so each round starts calmly. */
  reset(): void {
    this.nextSwingAt = 0;
    this.windupStart = 0;
    this.defendUntil = 0;
  }

  /** How long the wind-up shows before the swing (always at least ~0.6 s). */
  get windupMs(): number {
    return 950 - this.skill * 400;
  }

  think(me: Fighter, opp: Fighter, now: number): Controls {
    const t = now / 1000;
    const c: Controls = {
      duck: 0.1 + Math.sin(t * 4) * 0.06, // idle bounce (too small to count as a duck)
      shieldArm: { fwd: REST_SHIELD.fwd + 0.2, down: 0.9 + Math.sin(t * 2) * 0.1 },
      swordArm: { fwd: 1.0, down: 0.6 + Math.sin(t * 2.3) * 0.15 },
      shield: null,
    };

    // Just took a hit? Often raise the shield for a moment.
    if (me.hitAt !== this.lastHitSeen) {
      this.lastHitSeen = me.hitAt;
      if (Math.random() < 0.3 + this.skill * 0.3) {
        this.defence = Math.random() < 0.6 ? 'high' : 'low';
        this.defendUntil = now + 700;
      }
    }
    // React to an incoming swing, sometimes — and sometimes guess wrong.
    if (opp.swing && opp.swing.t !== this.reactedTo) {
      this.reactedTo = opp.swing.t;
      if (Math.random() < 0.2 + this.skill * 0.35) {
        const k = opp.swing.kind;
        const right = Math.random() < 0.55 + this.skill * 0.3;
        if (k === 'high') this.defence = right ? (Math.random() < 0.7 ? 'high' : 'duck') : 'low';
        else if (k === 'low') this.defence = right ? 'low' : 'high';
        else this.defence = right ? 'high' : 'duck';
        this.defendUntil = now + 550;
      }
    }
    if (now < this.defendUntil) {
      if (this.defence === 'duck') c.duck = 1;
      else if (this.defence) {
        c.shield = this.defence;
        c.shieldArm = this.defence === 'high' ? { fwd: 0.9, down: -0.6 } : { fwd: 1.0, down: 0.8 };
      }
    }

    // Attack: wind up (clearly visible), then swing.
    if (!this.nextSwingAt) this.nextSwingAt = now + 1800;
    if (!this.windupStart && now >= this.nextSwingAt && now >= this.defendUntil && !me.swing) {
      this.windupStart = now;
      const r = Math.random();
      this.kind = r < 0.45 ? 'high' : r < 0.8 ? 'low' : 'thrust';
      me.windupKind = this.kind;
    }
    if (this.windupStart) {
      me.windup = Math.min(1, (now - this.windupStart) / this.windupMs);
      // Wind-up pose: sword raised overhead / held low / pulled back.
      c.swordArm =
        this.kind === 'high' ? { fwd: 0.1, down: -1.7 } : this.kind === 'low' ? { fwd: 0.2, down: 1.6 } : { fwd: -0.3, down: 0.4 };
      if (now - this.windupStart >= this.windupMs) {
        c.attack = this.kind;
        this.windupStart = 0;
        me.windup = 0;
        this.nextSwingAt = now + 1100 + Math.random() * (1800 - this.skill * 700);
      }
    } else me.windup = 0;
    if (me.swing) c.swordArm = { ...REST_SWORD, fwd: 1.6, down: 0.3 };
    return c;
  }
}
