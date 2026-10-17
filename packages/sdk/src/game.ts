import { isHostMessage, type GameMessage } from './bridge';
import { createInputFromUrl } from './input';
import { lockTouchGestures } from './touch';
import { PlayerTracker } from './tracker';
import type { Frame, GameEvent } from './types';

type EventOf<T extends GameEvent['type']> = Extract<GameEvent, { type: T }>;

export interface GameClient {
  /** True when running inside the launcher; false when opened directly for development. */
  readonly embedded: boolean;
  /** Most recent tracking frame. Read this from your render loop. */
  readonly frame: Frame;
  /** Called for every new tracking frame (camera rate, not render rate). */
  onFrame(cb: (frame: Frame) => void): void;
  on<T extends GameEvent['type']>(type: T, cb: (e: EventOf<T>) => void): void;
  /** Report scores by slot, e.g. { 0: 12, 1: 9 } — the launcher may show them later. */
  reportScores(scores: Record<number, number>): void;
  /** Return to the launcher. */
  exit(): void;
}

/**
 * Entry point for every game:
 *
 *   const game = await createGame();
 *   game.on('jump', e => ...);
 *   function loop() { draw(game.frame.players); requestAnimationFrame(loop) }
 *
 * Inside the launcher, frames arrive from the host. Opened directly
 * (npm run dev in a game folder), the game runs its own camera/simulator,
 * so games can be built and tested on their own.
 */
export async function createGame(): Promise<GameClient> {
  const embedded = window.parent !== window;
  const frameCbs: ((f: Frame) => void)[] = [];
  const eventCbs = new Map<string, ((e: GameEvent) => void)[]>();
  let frame: Frame = { t: 0, aspect: 4 / 3, players: [], events: [] };

  const deliver = (f: Frame) => {
    frame = f;
    for (const cb of frameCbs) cb(f);
    for (const e of f.events) for (const cb of eventCbs.get(e.type) ?? []) cb(e);
  };

  const post = (m: GameMessage) => window.parent.postMessage(m, '*');

  if (embedded) {
    addEventListener('message', (ev) => {
      if (ev.source !== window.parent || !isHostMessage(ev.data)) return;
      if (ev.data.kind === 'frame') deliver(ev.data.frame);
    });
    // Forward mouse/keyboard so the host's simulator keeps working while we have focus.
    // Touch input must not scroll/zoom the game page (or get cancelled by iOS).
    lockTouchGestures();
    const fwd = (phase: 'down' | 'move' | 'up') => (e: PointerEvent) =>
      post({
        tg: 1,
        kind: 'pointer',
        id: e.pointerId,
        phase,
        x: e.clientX / innerWidth,
        y: e.clientY / innerHeight,
        pointerType: e.pointerType,
      });
    addEventListener('pointerdown', fwd('down'));
    addEventListener('pointermove', fwd('move'));
    addEventListener('pointerup', fwd('up'));
    addEventListener('pointercancel', fwd('up'));
    addEventListener('keydown', (e) => post({ tg: 1, kind: 'key', code: e.code, down: true }));
    addEventListener('keyup', (e) => post({ tg: 1, kind: 'key', code: e.code, down: false }));
    post({ tg: 1, kind: 'ready' });
  } else {
    const { source, warning } = await createInputFromUrl();
    if (warning) console.warn(warning);
    const tracker = new PlayerTracker();
    source.onPoses((poses, t) => deliver(tracker.update(poses, t, source.aspect)));
    console.info(`[game] standalone mode, input=${source.name}. Add ?input=sim&players=2 to simulate.`);
  }

  return {
    embedded,
    get frame() {
      return frame;
    },
    onFrame: (cb) => void frameCbs.push(cb),
    on: (type, cb) => {
      const list = eventCbs.get(type) ?? [];
      list.push(cb as (e: GameEvent) => void);
      eventCbs.set(type, list);
    },
    reportScores: (scores) => embedded && post({ tg: 1, kind: 'scores', scores }),
    exit: () => (embedded ? post({ tg: 1, kind: 'exit' }) : location.reload()),
  };
}
