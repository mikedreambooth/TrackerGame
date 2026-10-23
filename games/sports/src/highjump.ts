/** High jump — three tries to jump as high as you can; your best jump counts. */
import { blip, drawText, playerName, type Frame } from '@trackergame/sdk';
import { HipMeter, drawAthlete, drawStadium, playerInSlot, type Lane, type Result, type SportEvent } from './common';
import { art } from './art';

const ATTEMPTS = 3;
const READY = 2.2; // seconds of "get ready" (standing height is measured)
const JUMP = 2.4; // seconds in which to jump
const SHOW = 2.4; // seconds showing the result
const CYCLE = READY + JUMP + SHOW;
/** Torso lengths → cm (a torso is roughly 45 cm). Generous on purpose: it's for kids. */
const CM_PER_TORSO = 50;

interface Jumper {
  lane: Lane;
  best: number;
  attempt: number;
  tries: number[];
  live: number;
}

export class HighJump implements SportEvent {
  readonly title = 'High Jump';
  readonly howTo = 'When it says jump, jump as high as you can! You get three tries.';
  callouts: string[] = [];
  private jumpers: Jumper[] = [];
  private hips = new HipMeter();
  private elapsed = 0;
  private lastPhase = '';

  start(lanes: Lane[]): void {
    this.jumpers = lanes.map((lane) => ({ lane, best: 0, attempt: 0, tries: [], live: 0 }));
    this.hips.reset();
    this.elapsed = 0;
    this.lastPhase = '';
    this.callouts = [];
  }

  private phase(elapsed: number): { n: number; name: 'ready' | 'jump' | 'show'; t: number } {
    const n = Math.min(ATTEMPTS - 1, Math.floor(elapsed / CYCLE));
    const t = elapsed - n * CYCLE;
    return { n, name: t < READY ? 'ready' : t < READY + JUMP ? 'jump' : 'show', t };
  }

  update(frame: Frame, elapsed: number): void {
    this.elapsed = elapsed;
    const ph = this.phase(elapsed);
    const key = `${ph.n}:${ph.name}`;
    if (key !== this.lastPhase) {
      this.lastPhase = key;
      if (ph.name === 'ready') this.callouts.push(ph.n === 0 ? 'Stand still. Get ready!' : `Jump ${ph.n + 1}. Get ready!`);
      if (ph.name === 'jump') {
        this.callouts.push('Jump!');
        blip(520, 200, 'square', 0.15, 1040);
        for (const j of this.jumpers) j.attempt = 0;
      }
      if (ph.name === 'show') {
        for (const j of this.jumpers) {
          j.tries.push(j.attempt);
          j.best = Math.max(j.best, j.attempt);
        }
        const top = [...this.jumpers].sort((a, b) => b.attempt - a.attempt)[0];
        if (top && top.attempt > 0.1) this.callouts.push(`${playerName(top.lane.slot)}, ${cm(top.attempt)} centimetres!`);
      }
    }
    for (const j of this.jumpers) {
      const p = playerInSlot(frame, j.lane.slot);
      j.live = p ? this.hips.update(p) : 0;
      if (ph.name === 'jump') j.attempt = Math.max(j.attempt, j.live);
    }
  }

  get done(): boolean {
    return this.elapsed >= ATTEMPTS * CYCLE;
  }

  results(): Result[] {
    return this.jumpers.map((j) => ({ slot: j.lane.slot, score: j.best, label: `${cm(j.best)} cm` }));
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const ground = h * 0.86;
    drawStadium(ctx, w, h, h * 0.5);
    // Landing mats.
    const n = Math.max(1, this.jumpers.length);
    const colW = w / n;
    const pxPerCm = (ground - h * 0.3) / 80;
    const ph = this.phase(this.elapsed);

    this.jumpers.forEach((j, i) => {
      const cx = colW * (i + 0.5);
      // The mat picture's top face is ~40% of the way down; its sides end at 71%.
      const ms = Math.min((colW * 0.8) / 0.94, h * 0.34);
      ctx.drawImage(art.mat, cx - ms / 2, ground - ms * 0.4, ms, ms);
      // Scale on the side (outlined so it reads over the crowd).
      ctx.lineCap = 'round';
      for (let c = 0; c <= 80; c += 20) {
        const y = ground - c * pxPerCm;
        for (const [style, width] of [['#1b1030', 6], ['#fff', 3]] as const) {
          ctx.strokeStyle = style;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(cx - colW * 0.36, y);
          ctx.lineTo(cx - colW * 0.31, y);
          ctx.stroke();
        }
        if (c) drawText(ctx, `${c}`, cx - colW * 0.375, y, h / 34, '#fff', { align: 'right' });
      }
      // Bar at this player's best (or the attempt being shown).
      const barCm = ph.name === 'show' ? cm(j.attempt) : cm(j.best);
      if (barCm > 0) {
        const by = ground - barCm * pxPerCm;
        // Striped uprights and a red-and-white bar, like the hurdles.
        for (const ux of [cx - colW * 0.3, cx + colW * 0.3 - 8]) {
          ctx.fillStyle = '#f8f9fa';
          ctx.fillRect(ux, by, 8, ground - by);
          ctx.fillStyle = '#e63946';
          for (let y = ground - 24; y > by; y -= 32) ctx.fillRect(ux, Math.max(by, y - 12), 8, Math.min(12, y - by));
        }
        const bw = colW * 0.6;
        ctx.fillStyle = '#f8f9fa';
        ctx.beginPath();
        ctx.roundRect(cx - colW * 0.3, by - 7, bw, 12, 6);
        ctx.fill();
        ctx.fillStyle = '#e63946';
        for (let i = 0; i < 8; i += 2) ctx.fillRect(cx - colW * 0.3 + (bw * i) / 8 + 4, by - 7, bw / 8, 12);
      }
      // The jumper follows the real player's jump.
      const lift = Math.min(j.live, 1.6) * CM_PER_TORSO * pxPerCm;
      drawAthlete(ctx, cx, ground, Math.min(colW * 0.5, h * 0.3), j.lane.color, {
        lift,
        stride: lift > 10 ? 0.3 : 0,
        phase: 1,
        cheer: ph.name === 'show' && j.attempt > 0.1,
      });
      drawText(ctx, playerName(j.lane.slot), cx, h * 0.24, Math.min(h / 16, colW / 5), j.lane.color);
      if (ph.name === 'show' && j.attempt > 0) drawText(ctx, `${cm(j.attempt)} cm`, cx, h * 0.32, h / 14, '#fff');
      drawText(ctx, `Best ${cm(j.best)} cm`, cx, h * 0.96, h / 26, '#fff');
      // Try dots.
      for (let t = 0; t < ATTEMPTS; t++) {
        ctx.fillStyle = t < j.tries.length ? j.lane.color : 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(cx + (t - 1) * 22, h * 0.39, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    const msg =
      ph.name === 'ready' ? `Jump ${ph.n + 1} of ${ATTEMPTS} — get ready…` : ph.name === 'jump' ? 'JUMP!' : 'Nice!';
    const size = ph.name === 'jump' ? (h / 8) * (1 + Math.sin(this.elapsed * 12) * 0.06) : h / 14;
    drawText(ctx, msg, w / 2, h * 0.1, size, ph.name === 'jump' ? '#ffbe0b' : '#fff');
  }
}

const cm = (rise: number) => Math.round(rise * CM_PER_TORSO);
