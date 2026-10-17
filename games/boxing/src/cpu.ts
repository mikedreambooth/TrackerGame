/**
 * Computer boxer: fair and readable for kids. It always telegraphs a punch by
 * pulling its glove back first (so you can duck or weave), sometimes slips or
 * blocks your punches, and gets a little sharper each round.
 */
import type { Controls, Fighter, Hand } from './fighter';

export class CpuBrain {
  private nextPunchAt = 0;
  private windupStart = 0;
  private windupHand: Hand = 'lead';
  private defendUntil = 0;
  private defence: 'duck' | 'weave' | 'guard' | null = null;
  private weaveDir = 1;
  private reactedTo = 0;
  private lastHitSeen = 0;

  constructor(public skill = 0.5) {}

  think(me: Fighter, opp: Fighter, now: number): Controls {
    const c: Controls = { duck: 0, weave: 0, guard: false };
    const t = now / 1000;

    // Idle bounce so it looks alive (too small to count as a dodge).
    c.duck = 0.12 + Math.sin(t * 5) * 0.08;

    // Just took a hit? Often cover up for a moment.
    if (me.hitAt !== this.lastHitSeen) {
      this.lastHitSeen = me.hitAt;
      if (Math.random() < 0.35 + this.skill * 0.3) {
        this.defence = 'guard';
        this.defendUntil = now + 700;
      }
    }
    // React to an incoming punch, sometimes.
    if (opp.punch && opp.punch.t !== this.reactedTo) {
      this.reactedTo = opp.punch.t;
      if (Math.random() < 0.2 + this.skill * 0.3) {
        const r = Math.random();
        this.defence = r < 0.4 ? 'guard' : r < 0.7 ? 'duck' : 'weave';
        this.weaveDir = Math.random() < 0.5 ? -1 : 1;
        this.defendUntil = now + 550;
      }
    }
    if (now < this.defendUntil) {
      if (this.defence === 'guard') c.guard = true;
      if (this.defence === 'duck') c.duck = 1;
      if (this.defence === 'weave') c.weave = this.weaveDir;
    }

    // Attack: wind up (visible), then punch.
    if (!this.nextPunchAt) this.nextPunchAt = now + 1500;
    if (!this.windupStart && now >= this.nextPunchAt && now >= this.defendUntil) {
      this.windupStart = now;
      this.windupHand = Math.random() < 0.6 ? 'lead' : 'rear';
      me.windupHand = this.windupHand;
    }
    const windupMs = 650 - this.skill * 250;
    if (this.windupStart) {
      me.windup = Math.min(1, (now - this.windupStart) / windupMs);
      if (now - this.windupStart >= windupMs) {
        c.punch = this.windupHand;
        this.windupStart = 0;
        me.windup = 0;
        // Sometimes a quick one-two.
        const combo = Math.random() < this.skill * 0.4;
        this.nextPunchAt = now + (combo ? 380 : 900 + Math.random() * (1500 - this.skill * 600));
      }
    } else me.windup = 0;
    return c;
  }
}
