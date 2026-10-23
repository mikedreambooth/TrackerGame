import { pushTap } from './dwell';
import { audioDone, setAudioRelay } from './audio-relay';
import { isHostMessage, type GameMessage, type PeopleMode } from './bridge';
import { FeetOverlay } from './feet';
import { CameraGhost, PEOPLE_STALE_MS, cameraGhostWanted, drawPeople, type DrawPeopleOptions } from './ghost';
import { createInputFromUrl } from './input';
import { PlayerLayout, type Layout } from './layout';
import { unlockAudio } from './sound';
import { lockTouchGestures } from './touch';
import { PlayerTracker } from './tracker';
import type { Cutout, Frame, GameEvent, Segmentation } from './types';

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
  /**
   * Show the footprint guides under each player (they flash "Step closer" when someone
   * stands too far back). Default true; turn off for games where they'd get in the way.
   * Players can also toggle them with F. Can be changed later with game.setFeet().
   */
  feet?: boolean;
  /**
   * How players are placed on screen: 'spread' (default: everyone the same height, spaced
   * evenly across the screen), 'normalised' (same height, where they stand), 'camera' (as the
   * camera sees them) or a custom place per slot. See PlayerLayout. Change it later with
   * game.setLayout(). ?layout=<mode> in the URL overrides it (for testing).
   */
  layout?: Layout;
  /**
   * The people cut out of the camera picture (native tracker; G toggles them). By default the
   * launcher draws them over the whole page, on top of everything, until the game first calls
   * game.drawPeople() (then the game draws them, behind its menus). false: don't show them at
   * all (games with avatars, or their own mapping of players). 'game': the game draws them
   * from the start. Change it later with game.setPeople().
   */
  people?: boolean | PeopleMode;
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
  /** Show or hide the footprint guides while this game runs. */
  setFeet(on: boolean): void;
  /** Change how players are placed on screen (see GameOptions.layout). */
  setLayout(layout: Layout): void;
  /**
   * Draw the people cut out of the camera picture, see-through with a glow in their player
   * colour, lined up with the players as screenMapper() maps them (pass the same `fit` if the
   * game uses another). Call it every frame after the background/world and before text, HUD,
   * menus and cursors, onto a canvas `w` × `h` (CSS pixels, as fitCanvas() returns). The first
   * call takes over from the launcher's on-top overlay. Draws nothing while the viewer has
   * them off (G), when people are 'off', or without cut-outs (simulator, browser tracker).
   */
  drawPeople(ctx: CanvasRenderingContext2D, w: number, h: number, opts?: DrawPeopleOptions): void;
  /** True while drawPeople() would draw (people not 'off' and G on), even before the first cut-outs. */
  readonly peopleVisible: boolean;
  /** Who draws the people: 'game' (drawPeople), 'overlay' (over the whole page) or 'off'. */
  setPeople(mode: PeopleMode): void;
  /**
   * Let touches/clicks reach this game's page instead of the launcher's
   * simulator layer — e.g. so someone can tap an embedded video's play or skip
   * button. Turn it back off afterwards.
   */
  setTouchPassthrough(on: boolean): void;
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
  let feet: FeetOverlay | null = null;
  const urlLayout = new URLSearchParams(location.search).get('layout') as Layout | null;
  let layout: PlayerLayout | null = null;
  const peopleOpt = opts.people ?? 'overlay';
  let peopleMode: PeopleMode = peopleOpt === true ? 'overlay' : peopleOpt === false ? 'off' : peopleOpt;
  /** G, as the launcher (or our own CameraGhost) last said. */
  let peopleOn = cameraGhostWanted();
  /** Cut-outs the launcher sent (embedded). */
  let people: Segmentation | null = null;
  let ghost: CameraGhost | null = null;

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
      else if (ev.data.kind === 'tap') pushTap(ev.data.x, ev.data.y);
      else if (ev.data.kind === 'people') setPeopleImages(ev.data.people);
      else if (ev.data.kind === 'peopleOn') {
        peopleOn = ev.data.on;
        if (!peopleOn) setPeopleImages(null);
      }
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
    addEventListener('keydown', (e) => !e.repeat && post({ tg: 1, kind: 'key', code: e.code, down: true }));
    addEventListener('keyup', (e) => post({ tg: 1, kind: 'key', code: e.code, down: false }));
    post({ tg: 1, kind: 'ready' });
    if (opts.exitGesture === false) post({ tg: 1, kind: 'config', exitGesture: false });
    if (opts.feet === false) post({ tg: 1, kind: 'config', feet: false });
    if (opts.layout) post({ tg: 1, kind: 'config', layout: opts.layout });
    if (peopleMode !== 'overlay') post({ tg: 1, kind: 'config', people: peopleMode });
  } else {
    unlockAudio();
    const { source, warning } = await createInputFromUrl();
    if (warning) console.warn(warning);
    const tracker = new PlayerTracker();
    layout = new PlayerLayout(urlLayout ?? opts.layout ?? 'spread');
    source.onPoses((poses, t) => deliver(layout!.apply(tracker.update(poses, t, source.aspect))));
    // G: the players cut out of the camera picture (inside the launcher, the launcher shows it).
    ghost = new CameraGhost(source, () => frame);
    ghost.mode = ghostMode(peopleMode);
    ghost.onToggle = (on) => (peopleOn = on);
    // F: footprint guides (inside the launcher, the launcher draws them).
    feet = new FeetOverlay(() => frame);
    feet.allowed = opts.feet !== false;
    console.info(`[game] standalone mode, input=${source.name}. Add ?input=sim&players=2 to simulate.`);
  }

  function setPeopleImages(list: Cutout[] | null) {
    for (const c of people?.people ?? []) (c.image as ImageBitmap).close?.();
    people = list ? { t: performance.now(), people: list } : null;
  }

  function setPeople(mode: PeopleMode) {
    if (mode === peopleMode) return;
    peopleMode = mode;
    if (ghost) ghost.mode = ghostMode(mode);
    if (embedded) post({ tg: 1, kind: 'config', people: mode });
    if (mode !== 'game') setPeopleImages(null);
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
    setFeet: (on) => {
      if (feet) feet.allowed = on;
      if (embedded) post({ tg: 1, kind: 'config', feet: on });
    },
    setLayout: (l) => {
      if (layout && !urlLayout) layout.set(l);
      if (embedded) post({ tg: 1, kind: 'config', layout: l });
    },
    get peopleVisible() {
      return peopleMode !== 'off' && peopleOn;
    },
    drawPeople: (ctx, w, h, o) => {
      if (peopleMode === 'off') return;
      if (peopleMode === 'overlay') setPeople('game'); // we draw them from now on (behind our menus)
      if (!peopleOn) return;
      let seg = ghost ? ghost.segmentation() : people;
      if (seg && performance.now() - seg.t > PEOPLE_STALE_MS) seg = null;
      drawPeople(ctx, frame, seg, w, h, o);
    },
    setPeople,
    setTouchPassthrough: (on) => embedded && post({ tg: 1, kind: 'config', passTouches: on }),
    exit: () => (embedded ? post({ tg: 1, kind: 'exit' }) : location.reload()),
  };
}

function ghostMode(m: PeopleMode) {
  return m === 'game' ? 'elsewhere' : m;
}
