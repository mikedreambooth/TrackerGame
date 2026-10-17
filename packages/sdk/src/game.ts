import { audioDone, setAudioRelay } from './audio-relay';
import { isHostMessage, type GameMessage } from './bridge';
import { createInputFromUrl } from './input';
import { unlockAudio } from './sound';
import { lockTouchGestures } from './touch';
import { PlayerTracker } from './tracker';
import type { Frame, GameEvent } from './types';

/** Everything game.on() can listen for: player events plus pause/resume. */
export type ClientEvent = GameEvent | { type: 'pause' } | { type: 'resume' };
type EventOf<T extends ClientEvent['type']> = Extract<ClientEvent, { type: T }>;

export interface GameOptions {
  /**
   * Pause automatically when everyone has left the camera view (after
   * `pauseAfterMs`), resume when someone comes back. Default true.
   */
  autoPause?: boolean;
  /** Default 2000. */
  pauseAfterMs?: number;
  /**
   * Allow the launcher's "both hands up for 3 s → go home" gesture while this
   * game runs. Turn off for games that need long arms-up poses. Esc still works.
   * Default true. Can be changed later with game.setExitGesture().
   */
  exitGesture?: boolean;
}

export interface GameClient {
  /** True when running inside the launcher; false when opened directly for development. */
  readonly embedded: boolean;
  /** Most recent tracking frame. Read this from your render loop. */
  readonly frame: Frame;
  /** True while auto-paused because nobody is in view. Freeze timers and spawning while set. */
  readonly paused: boolean;
  /** Called for every new tracking frame (camera rate, not render rate). */
  onFrame(cb: (frame: Frame) => void): void;
  on<T extends ClientEvent['type']>(type: T, cb: (e: EventOf<T>) => void): void;
  /** Report scores by slot, e.g. { 0: 12, 1: 9 } — the launcher may show them later. */
  reportScores(scores: Record<number, number>): void;
  /** Enable/disable the launcher's hands-up-to-go-home gesture for this game. */
  setExitGesture(enabled: boolean): void;
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
export async function createGame(opts: GameOptions = {}): Promise<GameClient> {
  const autoPause = opts.autoPause ?? true;
  const pauseAfterMs = opts.pauseAfterMs ?? 2000;
  const embedded = window.parent !== window;
  const frameCbs: ((f: Frame) => void)[] = [];
  const eventCbs = new Map<string, ((e: ClientEvent) => void)[]>();
  let frame: Frame = { t: 0, aspect: 4 / 3, players: [], events: [] };
  let paused = false;
  let emptySince = 0;
  let hadPlayers = false;

  const emit = (e: ClientEvent) => {
    for (const cb of eventCbs.get(e.type) ?? []) cb(e);
  };

  const deliver = (f: Frame) => {
    frame = f;
    if (f.players.length) {
      hadPlayers = true;
      emptySince = 0;
      if (paused) {
        paused = false;
        emit({ type: 'resume' });
      }
    } else if (autoPause && hadPlayers) {
      emptySince ||= f.t;
      if (!paused && f.t - emptySince > pauseAfterMs) {
        paused = true;
        emit({ type: 'pause' });
      }
    }
    for (const cb of frameCbs) cb(f);
    for (const e of f.events) emit(e);
  };

  const post = (m: GameMessage) => window.parent.postMessage(m, '*');

  if (embedded) {
    addEventListener('message', (ev) => {
      if (ev.source !== window.parent || !isHostMessage(ev.data)) return;
      if (ev.data.kind === 'frame') deliver(ev.data.frame);
      else if (ev.data.kind === 'audioDone') audioDone(ev.data.id);
    });
    // The launcher plays our sounds and speech (it's the frame that gets the touches).
    setAudioRelay((cmd) => post({ tg: 1, kind: 'audio', cmd }));
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
    if (opts.exitGesture === false) post({ tg: 1, kind: 'config', exitGesture: false });
  } else {
    unlockAudio();
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
    get paused() {
      return paused;
    },
    onFrame: (cb) => void frameCbs.push(cb),
    on: (type, cb) => {
      const list = eventCbs.get(type) ?? [];
      list.push(cb as (e: ClientEvent) => void);
      eventCbs.set(type, list);
    },
    reportScores: (scores) => embedded && post({ tg: 1, kind: 'scores', scores }),
    setExitGesture: (enabled) => embedded && post({ tg: 1, kind: 'config', exitGesture: enabled }),
    exit: () => (embedded ? post({ tg: 1, kind: 'exit' }) : location.reload()),
  };
}
