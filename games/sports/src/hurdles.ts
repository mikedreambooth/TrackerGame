/** Hurdles — your athlete runs by itself; you jump each time a hurdle reaches you. */
import { blip, drawText, noise, playerName, type Frame } from '@trackergame/sdk';
import { HipMeter, drawAthlete, drawStadium, drawTrack, playerInSlot, type Lane, type Result, type SportEvent } from './common';

const COUNT = 8;
const FIRST = 2.5; // seconds until the first hurdle arrives
const GAP = 2.0; // seconds between hurdles
/** Hips this far above standing (in torso lengths) counts as "in the air". */
const AIRBORNE = 0.22;
/** A jump counts if you're in the air from this long before … */
const EARLY = 0.45;
/** … until this long after the hurdle reaches you. */
const LATE = 0.25;

interface Hurdler {
  lane: Lane;
  /** Elapsed times at which this player was in the air (recent only). */
  air: number[];
  live: number;
  results: ('clear' | 'hit' | null)[];
  stumbleAt: number;
}

export class Hurdles implements SportEvent {
  readonly title = 'Hurdles';
  readonly howTo = 'Your runner runs by itself. Jump each time a hurdle reaches you!';
  callouts: string[] = [];
  private hurdlers: Hurdler[] = [];
  private hips = new HipMeter();
  private elapsed = 0;
  private judged = 0;

  start(lanes: Lane[]): void {
    this.hurdlers = lanes.map((lane) => ({ lane, air: [], live: 0, results: Array(COUNT).fill(null), stumbleAt: -9 }));
    this.hips.reset();
    this.elapsed = 0;
    this.judged = 0;
    this.callouts = [];
  }

  private arrival = (i: number) => FIRST + i * GAP;

  update(frame: Frame, elapsed: number): void {
    this.elapsed = elapsed;
    for (const hu of this.hurdlers) {
      const p = playerInSlot(frame, hu.lane.slot);
      hu.live = p ? this.hips.update(p) : 0;
      if (hu.live > AIRBORNE) hu.air.push(elapsed);
      while (hu.air.length && elapsed - hu.air[0] > 2) hu.air.shift();
    }
    // Judge each hurdle once the "late" window has passed.
    while (this.judged < COUNT && elapsed > this.arrival(this.judged) + LATE) {
      const ta = this.arrival(this.judged);
      let clears = 0;
      for (const hu of this.hurdlers) {
        const cleared = hu.air.some((t) => t >= ta - EARLY && t <= ta + LATE);
        hu.results[this.judged] = cleared ? 'clear' : 'hit';
        if (cleared) clears++;
        else hu.stumbleAt = elapsed;
      }
      if (clears) blip(700, 120, 'triangle', 0.15, 1100);
      if (clears < this.hurdlers.length) noise(180, 0.2);
      this.judged++;
      if (this.judged === COUNT / 2) this.callouts.push('Halfway! Keep jumping!');
    }
  }

  get done(): boolean {
    return this.elapsed > this.arrival(COUNT - 1) + 1.8;
  }

  results(): Result[] {
    return this.hurdlers.map((hu) => {
      const c = hu.results.filter((r) => r === 'clear').length;
      return { slot: hu.lane.slot, score: c, label: `${c} / ${COUNT}` };
    });
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const top = h * 0.36;
    const bottom = h * 0.94;
    drawStadium(ctx, w, h, top);
    const n = Math.max(1, this.hurdlers.length);
    const grounds = drawTrack(ctx, 0, w, top, bottom, n);
    const lh = (bottom - top) / n;
    const runnerX = w * 0.25;
    const pxPerSec = w * 0.22;
    const t = this.elapsed;

    // Scrolling distance markers so the track feels like it's moving.
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let x = (-(t * pxPerSec) % 160) + 160; x < w; x += 160) ctx.fillRect(x, top, 4, bottom - top);

    this.hurdlers.forEach((hu, i) => {
      const g = grounds[i];
      const size = Math.min(lh * 1.2, h * 0.2);
      // Hurdles in this lane.
      for (let k = 0; k < COUNT; k++) {
        const x = runnerX + (this.arrival(k) - t) * pxPerSec;
        if (x < -40 || x > w + 40) continue;
        const knocked = hu.results[k] === 'hit';
        const hh = size * 0.32;
        ctx.save();
        ctx.translate(x + size * 0.15, g);
        if (knocked) ctx.rotate(1.2);
        ctx.fillStyle = '#fff';
        ctx.fillRect(-3, -hh, 6, hh);
        ctx.fillRect(size * 0.25 - 3, -hh, 6, hh);
        ctx.fillStyle = hu.results[k] === 'clear' ? '#2ec4b6' : '#ff4d6d';
        ctx.fillRect(-6, -hh - 8, size * 0.25 + 12, 12);
        ctx.restore();
      }
      const stumble = t - hu.stumbleAt < 0.5 ? Math.sin(((t - hu.stumbleAt) / 0.5) * Math.PI) * 0.6 : 0;
      drawAthlete(ctx, runnerX, g, size, hu.lane.color, {
        phase: t * 11,
        stride: 0.9,
        lift: Math.min(hu.live, 1.4) * size * 0.9,
        tumble: stumble,
      });
      const clears = hu.results.filter((r) => r === 'clear').length;
      drawText(ctx, `${playerName(hu.lane.slot)}  ${clears}`, 12, top + lh * i + lh * 0.25, Math.min(26, lh * 0.3), hu.lane.color, {
        align: 'left',
      });
    });

    // "JUMP!" cue as the next hurdle arrives.
    const next = this.arrival(Math.min(this.judged, COUNT - 1));
    const soon = next - t;
    if (this.judged < COUNT && soon < 0.45 && soon > -LATE) {
      drawText(ctx, 'JUMP!', w / 2, h * 0.12, h / 7, '#ffbe0b');
    } else {
      drawText(ctx, 'Jump over the hurdles!', w / 2, h * 0.1, h / 16);
    }
  }
}
