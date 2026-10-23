/**
 * 60 m sprint — run on the spot; the faster your knees pump, the faster you go. Crouch down
 * during "on your marks, get set" for a sprint start: your runner crouches with you and gets
 * a flying start on "Go!".
 */
import { drawText, playerName, type Frame } from '@trackergame/sdk';
import { drawAthlete, drawStadium, drawTrack, playerInSlot, type Lane, type Result, type SportEvent } from './common';

const DISTANCE = 60; // metres
const TIME_LIMIT = 25; // seconds
const TOP_SPEED = 10; // m/s
/** Once someone finishes, everyone else has this long to cross the line. */
const AFTER_WINNER = 8;
/** Crouched at least this deep (player.pose.crouchDepth, 0..1) on "Go!" = a sprint start… */
const START_CROUCH = 0.35;
/** …which starts the runner at this speed (m/s) instead of from standing. */
const START_SPEED = 5;

interface Runner {
  lane: Lane;
  dist: number;
  speed: number;
  phase: number;
  finishedAt: number | null;
  /** How deep they're crouched during the countdown (smoothed), for the sprint start. */
  crouch: number;
  goodStart: boolean;
}

export class Race implements SportEvent {
  readonly title = 'Running Race';
  readonly howTo = 'Crouch down for a sprint start, then run on the spot as fast as you can!';
  callouts: string[] = [];
  private runners: Runner[] = [];
  private elapsed = 0;
  private finishOrder = 0;
  private firstFinish: number | null = null;
  private started = false;

  start(lanes: Lane[]): void {
    this.runners = lanes.map((lane) => ({ lane, dist: 0, speed: 0, phase: 0, finishedAt: null, crouch: 0, goodStart: false }));
    this.started = false;
    this.elapsed = 0;
    this.finishOrder = 0;
    this.firstFinish = null;
    this.callouts = [];
  }

  /** On your marks… get set: runners crouch with their players. */
  ready(frame: Frame, dt: number): void {
    for (const r of this.runners) {
      const depth = playerInSlot(frame, r.lane.slot)?.pose.crouchDepth ?? 0;
      r.crouch += (depth - r.crouch) * Math.min(1, dt * 10);
    }
  }

  update(frame: Frame, elapsed: number, dt: number): void {
    this.elapsed = elapsed;
    if (!this.started) {
      // "Go!": anyone down in a crouch gets a flying start.
      this.started = true;
      for (const r of this.runners) {
        r.goodStart = r.crouch >= START_CROUCH;
        if (r.goodStart) r.speed = START_SPEED;
      }
    }
    for (const r of this.runners) {
      if (r.finishedAt !== null) {
        r.speed *= 0.95; // jog to a stop past the line
        r.phase += r.speed * dt * 1.6;
        continue;
      }
      const p = playerInSlot(frame, r.lane.slot);
      const effort = p ? p.pose.run : 0;
      const target = effort < 0.6 ? 0 : Math.min(TOP_SPEED, effort * 2.4);
      r.speed += (target - r.speed) * Math.min(1, dt * 3);
      r.dist = Math.min(DISTANCE, r.dist + r.speed * dt);
      r.phase += r.speed * dt * 1.6;
      if (r.dist >= DISTANCE) {
        r.finishedAt = elapsed;
        this.finishOrder++;
        if (this.finishOrder === 1) {
          this.firstFinish = elapsed;
          this.callouts.push(`${playerName(r.lane.slot)} wins the race!`);
        }
      }
    }
  }

  get done(): boolean {
    return (
      this.elapsed > TIME_LIMIT ||
      (this.firstFinish !== null && this.elapsed - this.firstFinish > AFTER_WINNER) ||
      this.runners.every((r) => r.finishedAt !== null && this.elapsed - r.finishedAt > 1.5)
    );
  }

  results(): Result[] {
    return this.runners.map((r) =>
      r.finishedAt !== null
        ? { slot: r.lane.slot, score: 1000 - r.finishedAt, label: `${r.finishedAt.toFixed(2)} s` }
        : { slot: r.lane.slot, score: r.dist, label: `${Math.floor(r.dist)} m` },
    );
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const top = h * 0.36;
    const bottom = h * 0.94;
    drawStadium(ctx, w, h, top);
    const x0 = w * 0.04;
    const x1 = w * 0.96;
    const n = Math.max(1, this.runners.length);
    const grounds = drawTrack(ctx, x0, x1, top, bottom, n);
    const startX = x0 + w * 0.06;
    const finishX = x1 - w * 0.06;
    // Start & finish lines.
    ctx.fillStyle = '#fff';
    ctx.fillRect(startX - 3, top, 6, bottom - top);
    for (let y = top, i = 0; y < bottom; y += 14, i++) {
      ctx.fillStyle = i % 2 ? '#111' : '#fff';
      ctx.fillRect(finishX - 7, y, 14, 14);
    }
    const lh = (bottom - top) / n;
    this.runners.forEach((r, i) => {
      const x = startX + ((finishX - startX) * r.dist) / DISTANCE;
      drawAthlete(ctx, x, grounds[i], Math.min(lh * 1.25, h * 0.2), r.lane.color, {
        phase: r.phase,
        stride: Math.min(1, r.speed / 6),
        lift: Math.abs(Math.sin(r.phase)) * Math.min(r.speed, 8) * 0.8,
        cheer: r.finishedAt !== null && r.speed < 2,
        crouch: this.started ? 0 : r.crouch,
      });
      if (r.goodStart && this.elapsed < 1.5) {
        drawText(ctx, 'Great start!', x + lh * 0.3, top + lh * i + lh * 0.3, Math.min(26, lh * 0.3), '#ffbe0b', { align: 'left' });
      }
      // Lane label + time.
      drawText(ctx, playerName(r.lane.slot), x0 + 10, top + lh * i + lh * 0.3, Math.min(26, lh * 0.3), r.lane.color, {
        align: 'left',
      });
      if (r.finishedAt !== null) {
        drawText(ctx, `${r.finishedAt.toFixed(2)} s`, finishX - 20, top + lh * i + lh * 0.3, Math.min(28, lh * 0.32), '#fff', {
          align: 'right',
        });
      }
    });
    // Instruction + clock.
    const pulse = 1 + Math.sin(this.elapsed * 8) * 0.05;
    if (!this.started) drawText(ctx, 'Crouch down… ready…', w / 2, h * 0.08, h / 14, '#fff');
    else drawText(ctx, 'RUN ON THE SPOT!', w / 2, h * 0.08, (h / 14) * pulse, '#ffbe0b');
    drawText(ctx, `${this.elapsed.toFixed(1)} s`, w / 2, h * 0.17, h / 20);
  }
}
