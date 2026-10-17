import { DwellMenu } from './dwell';
import type { GameClient } from './game';
import {
  drawCountdown,
  drawPaused,
  drawResults,
  drawScoreChips,
  drawText,
  drawTimerBar,
  drawTitle,
} from './ui';

export type RoundState = 'lobby' | 'countdown' | 'playing' | 'results';

export interface RoundOptions {
  title: string;
  /** Lobby instruction. Default "Raise both hands to start!" */
  subtitle?: string;
  /** Round length in seconds; 0 = untimed (call flow.end() yourself). Default 60. */
  seconds?: number;
  /** Countdown seconds before play. Default 3. */
  countdown?: number;
  /** Results stay up at least this long before "play again" works. Default 2500 ms. */
  resultsMinMs?: number;
}

type RoundEvent = 'start' | 'end';

/**
 * The standard flow every round-based game needs, with the shared look:
 *
 *   lobby ──(both hands up, or hold hand on "Start")──▶ countdown 3-2-1 ──▶ playing
 *     ▲                                                                      │ time up / flow.end()
 *     └──────────── results ◀────────────────────────────────────────────────┘
 *                   (Play again / Home buttons, or both hands up)
 *
 * Handles per-player scores, the timer, and auto-pause (timer freezes while
 * nobody's in view). Usage:
 *
 *   const flow = new RoundFlow(game, { title: 'Fruit Swipe', seconds: 60 });
 *   flow.on('start', () => resetWorld());
 *   // each frame:
 *   flow.update(now);
 *   if (flow.playing) { ...spawn, move, flow.addScore(player.slot) }
 *   drawWorld(); flow.drawOverlay(ctx, w, h);
 */
export class RoundFlow {
  state: RoundState = 'lobby';
  /** Score per player slot for the current/last round. */
  scores: Record<number, number> = {};
  private stateAt = performance.now();
  private playedMs = 0;
  private lastNow = performance.now();
  private listeners: Record<RoundEvent, (() => void)[]> = { start: [], end: [] };
  private lobbyMenu = new DwellMenu([{ id: 'start', label: 'Start', x: 0.5, y: 0.66, w: 0.26, h: 0.14, color: '#2a9d3a' }]);
  private resultsMenu = new DwellMenu([
    { id: 'again', label: 'Play again', x: 0.35, y: 0.76, w: 0.26, h: 0.14, color: '#2a9d3a' },
    { id: 'home', label: 'Home', x: 0.65, y: 0.76, w: 0.2, h: 0.14, color: '#3a2a80' },
  ]);
  private opts: Required<RoundOptions>;

  constructor(
    private game: GameClient,
    opts: RoundOptions,
  ) {
    this.opts = {
      subtitle: 'Raise both hands to start!',
      seconds: 60,
      countdown: 3,
      resultsMinMs: 2500,
      ...opts,
    };
    game.on('handsUp', () => {
      if (this.state === 'lobby') this.start();
      else if (this.state === 'results' && this.resultsReady()) this.start();
    });
  }

  on(type: RoundEvent, cb: () => void): void {
    this.listeners[type].push(cb);
  }

  /** True while the round is running and not paused — gate spawning, physics and scoring on this. */
  get playing(): boolean {
    return this.state === 'playing' && !this.game.paused;
  }

  /** Seconds of actual play so far (paused time excluded). */
  get elapsed(): number {
    return this.playedMs / 1000;
  }

  /** Seconds left in a timed round. */
  get remaining(): number {
    return Math.max(0, this.opts.seconds - this.elapsed);
  }

  addScore(slot: number, points = 1): void {
    this.scores[slot] = Math.max(0, (this.scores[slot] ?? 0) + points);
  }

  /** Begin the countdown (resets scores for everyone in view). */
  start(): void {
    this.scores = {};
    for (const p of this.game.frame.players) this.scores[p.slot] = 0;
    this.setState('countdown');
  }

  /** Finish the round now and show results. */
  end(): void {
    if (this.state !== 'playing') return;
    this.setState('results');
    this.game.reportScores(this.scores);
    this.listeners.end.forEach((cb) => cb());
  }

  update(now: number): void {
    const dt = Math.min(now - this.lastNow, 100);
    this.lastNow = now;
    const players = this.game.frame.players;
    switch (this.state) {
      case 'lobby':
        if (this.lobbyMenu.update(players, now) === 'start') this.start();
        break;
      case 'countdown':
        if (this.game.paused) this.setState('lobby');
        else if (now - this.stateAt >= this.opts.countdown * 1000) {
          this.playedMs = 0;
          this.setState('playing');
          this.listeners.start.forEach((cb) => cb());
        }
        break;
      case 'playing':
        if (this.game.paused) break;
        this.playedMs += dt;
        for (const p of players) this.scores[p.slot] ??= 0; // late joiners get a slot
        if (this.opts.seconds > 0 && this.playedMs >= this.opts.seconds * 1000) this.end();
        break;
      case 'results':
        if (this.resultsReady()) {
          const pick = this.resultsMenu.update(players, now);
          if (pick === 'again') this.start();
          if (pick === 'home') this.game.exit();
        }
        break;
    }
  }

  /** Draw the lobby / countdown / HUD / results / paused layers. Call after drawing your world. */
  drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const now = performance.now();
    switch (this.state) {
      case 'lobby': {
        const anyone = this.game.frame.players.length > 0;
        drawTitle(ctx, w, h, this.opts.title, anyone ? this.opts.subtitle : 'Step in to play!');
        if (anyone) this.lobbyMenu.draw(ctx, w, h);
        break;
      }
      case 'countdown':
        drawCountdown(ctx, w, h, this.opts.countdown - (now - this.stateAt) / 1000);
        break;
      case 'playing':
        if (this.opts.seconds > 0) {
          drawTimerBar(ctx, w, this.remaining / this.opts.seconds, this.remaining);
          if (this.remaining < 10 && Math.floor(now / 500) % 2) {
            drawText(ctx, String(Math.ceil(this.remaining)), w / 2, h * 0.1, h / 10, '#ff4d6d');
          }
        }
        drawScoreChips(ctx, this.scores);
        if (this.game.paused) drawPaused(ctx, w, h);
        break;
      case 'results':
        drawResults(ctx, w, h, this.scores);
        if (this.resultsReady()) {
          this.resultsMenu.draw(ctx, w, h);
          drawText(ctx, 'or raise both hands', w / 2, h * 0.9, h / 24);
        }
        break;
    }
  }

  private resultsReady(): boolean {
    return performance.now() - this.stateAt > this.opts.resultsMinMs;
  }

  private setState(s: RoundState): void {
    this.state = s;
    this.stateAt = performance.now();
  }
}
