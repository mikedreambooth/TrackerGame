import {
  CameraGhost,
  pressArmed,
  pressHappened,
  FeetOverlay,
  PlayerLayout,
  PlayerTracker,
  SimSource,
  createInputFromUrl,
  detectTaps,
  drawPeople,
  drawSkeleton,
  fitCanvas,
  handCursor,
  isGameMessage,
  screenMapper,
  KP,
  type Frame,
  type HostMessage,
  type Layout,
  type PeopleMode,
  type Player,
  type Segmentation,
  blip,
  runAudioCommand,
  say,
  startNaturalVoice,
  stopAllGameAudio,
  unlockAudio,
} from '@trackergame/sdk';
import { fetchGames, gameUrl, iconUrl, type GameEntry } from './catalog';
import { Chooser, colorName, drawCrown, drawHoldRing } from './chooser';

const DWELL_MS = 1200;
/** Holding a hand over a page arrow is quicker than choosing a game. */
const PAGER_DWELL_MS = 700;
const EXIT_HOLD_MS = 3000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tilesEl = $<HTMLElement>('tiles');
const playersEl = $<HTMLElement>('players');
const hintEl = $<HTMLElement>('hint');
const homeEl = $<HTMLElement>('home');
const iframe = $<HTMLIFrameElement>('game');
const simLayer = $<HTMLElement>('simlayer');
// The simulator layer turns drags into hand movement; quick taps also go to the game as taps (press buttons).
detectTaps(simLayer, (x, y) => iframe.contentWindow?.postMessage({ tg: 1, kind: 'tap', x, y } satisfies HostMessage, '*'));
const overlay = $<HTMLCanvasElement>('overlay');
const exitEl = $<HTMLElement>('exit');
const toastEl = $<HTMLElement>('toast');
const ctx = overlay.getContext('2d')!;
/** Behind the home screen's tiles: the people cut out of the camera picture and faint skeletons. */
const backdrop = $<HTMLCanvasElement>('backdrop');
const bctx = backdrop.getContext('2d')!;
const prevEl = $<HTMLButtonElement>('prev');
const nextEl = $<HTMLButtonElement>('next');
const dotsEl = $<HTMLElement>('dots');

let games: GameEntry[] = [];
let current: GameEntry | null = null;
let gameReady = false;
/** True when the simulator is driving input (no camera). */
let simInput = false;
let frame: Frame = { t: 0, aspect: 4 / 3, players: [], events: [] };
/** Per-player dwell state on the home screen. */
const dwell = new Map<number, { tile: string; since: number }>();
let exitHoldSince = 0;
/** Home-screen paging. */
let page = 0;
let perPage = 6;
/** The running game can turn the hands-up exit gesture off. */
let exitGestureOn = true;
/** Set when a new version of the site has been downloaded in the background. */
let updateReady = false;
let idleSince = 0;
/** Footprint guides under the players (F toggles). */
let feet: FeetOverlay | null = null;
/** The people cut out of the camera picture (G toggles). */
let ghost: CameraGhost | null = null;
/** Who draws the people while the current game runs (see game.drawPeople()). */
let peopleMode: PeopleMode = 'overlay';
/** The cut-outs last forwarded to the game. */
let peopleSent: Segmentation | null = null;
/**
 * Players are laid out (same height, spread across the screen) on the home screen and, unless
 * a game asks otherwise, in games. ?layout=camera|normalised|spread overrides it everywhere.
 */
const HOME_LAYOUT = 'spread';
const GAME_LAYOUT = 'spread';
const urlLayout = new URLSearchParams(location.search).get('layout') as Layout | null;
const layout = new PlayerLayout(urlLayout ?? HOME_LAYOUT);
/** The running game's last reported scores, by slot: the winner picks the next game. */
let lastScores: Record<number, number> | null = null;
/** Only one player at a time chooses on the home screen. */
const chooser = new Chooser((text) => {
  blip(660, 120, 'triangle', 0.15, 990);
  say(text, { interrupt: true });
  playersEl.dataset.key = ''; // refresh the hint
});

function toast(msg: string, ms = 5000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  setTimeout(() => (toastEl.hidden = true), ms);
}

// ---------- Home screen ----------

async function loadGames() {
  layoutPages();
  try {
    games = await fetchGames();
  } catch (e) {
    console.error(e);
    toast('Could not load the game list. In development, run "npm run build:games".');
    games = [];
  }
  renderTiles();
}

/** Work out how many tiles fit on one page at this screen size. */
function layoutPages() {
  const cols = innerWidth < innerHeight ? 2 : 3;
  tilesEl.style.setProperty('--cols', String(cols));
  const gap = innerWidth * 0.025;
  const tileW = (tilesEl.clientWidth - gap * (cols - 1)) / cols;
  const tileH = tileW * 0.75 * 1.08; // + room for the hover zoom and shadow
  const rows = Math.max(1, Math.floor((tilesEl.clientHeight + gap) / (tileH + gap)));
  perPage = cols * rows;
}

/** If the tiles still don't fit (fonts, odd screen shapes), put fewer on each page. */
function shrinkToFit(): boolean {
  const cols = Number(tilesEl.style.getPropertyValue('--cols')) || 3;
  if (tilesEl.scrollHeight > tilesEl.clientHeight + 2 && perPage > cols) {
    perPage -= cols;
    return true;
  }
  return false;
}

function pageCount() {
  return Math.max(1, Math.ceil(games.length / perPage));
}

/** Turn the page (+1 / -1), wrapping round at the ends. */
function turnPage(delta: number) {
  pressHappened(); // the hand that turned the page must move off before turning it again
  const pages = pageCount();
  if (pages <= 1) return;
  page = (page + delta + pages) % pages;
  dwell.clear();
  renderTiles(delta > 0 ? 'slide-next' : 'slide-prev');
  blip(delta > 0 ? 520 : 440, 90, 'triangle', 0.12, delta > 0 ? 700 : 330);
}

function renderTiles(anim?: 'slide-next' | 'slide-prev') {
  tilesEl.replaceChildren();
  if (!games.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No games yet. Add one under games/ and rebuild.';
    tilesEl.append(p);
    return;
  }
  const pages = pageCount();
  page = Math.min(page, pages - 1);
  for (const g of games.slice(page * perPage, (page + 1) * perPage)) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.dataset.game = g.id;
    b.style.background = g.color ?? '';
    const icon = iconUrl(g);
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      b.append(img);
    }
    const label = document.createElement('div');
    label.className = 'label';
    const players = g.players ? `${g.players.min}–${g.players.max} players` : '';
    label.innerHTML = `<div class="title"></div><div class="meta"></div>`;
    label.querySelector('.title')!.textContent = g.title;
    label.querySelector('.meta')!.textContent = players;
    b.append(label);
    b.addEventListener('click', () => launch(g));
    tilesEl.append(b);
  }
  prevEl.classList.toggle('off', pages <= 1);
  nextEl.classList.toggle('off', pages <= 1);
  dotsEl.replaceChildren(
    ...Array.from({ length: pages > 1 ? pages : 0 }, (_, i) => {
      const d = document.createElement('span');
      if (i === page) d.className = 'on';
      return d;
    }),
  );
  if (shrinkToFit()) return renderTiles(anim);
  tilesEl.classList.remove('slide-next', 'slide-prev');
  if (anim) {
    void tilesEl.offsetWidth; // restart the animation
    tilesEl.classList.add(anim);
  }
  (tilesEl.querySelector('.tile') as HTMLElement | null)?.focus();
}

prevEl.addEventListener('click', () => turnPage(-1));
nextEl.addEventListener('click', () => turnPage(1));
addEventListener('resize', () => {
  if (current) return;
  layoutPages();
  renderTiles();
});
addEventListener('keydown', (e) => {
  if (current) return;
  if (e.code === 'PageDown' || e.code === 'BracketRight') turnPage(1);
  if (e.code === 'PageUp' || e.code === 'BracketLeft') turnPage(-1);
});

function renderPlayerChips(players: Player[]) {
  const key = players.map((p) => `${p.id}:${p.slot}`).join(',') + `/${chooser.id}`;
  if (playersEl.dataset.key === key) return;
  playersEl.dataset.key = key;
  playersEl.replaceChildren(
    ...players.map((p) => {
      const d = document.createElement('div');
      d.className = players.length > 1 && chooser.isChooser(p) ? 'chip chooser' : 'chip';
      d.style.background = p.color;
      d.textContent = String(p.slot + 1);
      return d;
    }),
  );
  const picker = players.length > 1 ? players.find((p) => chooser.isChooser(p)) : undefined;
  hintEl.textContent = picker
    ? `${colorName(picker.slot)} picks the game! To pass it on, hold hands up together for 5 seconds`
    : players.length
      ? 'Raise a hand and hold it over a game'
      : 'Stand in front of the TV and raise a hand to choose a game';
}

// ---------- Game hosting ----------

function launch(g: GameEntry) {
  pressHappened();
  current = g;
  gameReady = false;
  exitGestureOn = true;
  lastScores = null;
  if (feet) feet.allowed = true;
  // Nobody draws the people while the game loads; from 'ready' the overlay does, until the game
  // takes them over or turns them off (its config arrives right after 'ready').
  setPeopleMode('overlay');
  if (ghost) ghost.mode = 'elsewhere';
  if (!urlLayout) layout.set(GAME_LAYOUT); // until the game asks for another
  layout.resetGameSettings(); // default baseline and sizes until the game asks otherwise
  dwell.clear();
  iframe.src = gameUrl(g);
  iframe.hidden = false;
  homeEl.hidden = true;
  backdrop.hidden = true;
  simLayer.hidden = !simInput;
  if (!simInput) iframe.focus(); // in sim mode keys stay with the host simulator
}

/** The player in the top-scoring slot of the game just played, if there's a clear winner. */
function gameWinner(): Player | null {
  const entries = Object.entries(lastScores ?? {}).map(([slot, score]) => ({ slot: Number(slot), score }));
  if (entries.length < 2) return null; // a solo game (or vs the computer) has no winner among the players
  const best = Math.max(...entries.map((e) => e.score));
  const top = entries.filter((e) => e.score === best);
  if (top.length !== 1) return null; // a draw
  // Slots still have their in-game numbering here (the home screen renumbers on the next frame).
  return frame.players.find((p) => p.slot === top[0].slot) ?? null;
}

function goHome() {
  pressHappened(); // a hand left over a game's button mustn't start a tile on the home screen
  stopAllGameAudio();
  const winner = current ? gameWinner() : null;
  if (winner) {
    const name = colorName(winner.slot);
    chooser.giveTo(winner, frame.players, `${name} won! ${name} picks the next game.`);
  }
  lastScores = null;
  if (feet) feet.allowed = true;
  if (ghost) ghost.mode = 'elsewhere'; // the home screen draws them behind its tiles
  if (!urlLayout) layout.set(HOME_LAYOUT);
  layout.resetGameSettings();
  current = null;
  gameReady = false;
  iframe.src = 'about:blank';
  iframe.hidden = true;
  simLayer.hidden = true;
  homeEl.hidden = false;
  backdrop.hidden = false;
  exitEl.hidden = true;
  exitHoldSince = 0;
  loadGames(); // pick up anything published while we were playing
}

function post(m: HostMessage, transfer: Transferable[] = []) {
  iframe.contentWindow?.postMessage(m, '*', transfer);
}

function setPeopleMode(m: PeopleMode) {
  peopleMode = m;
  peopleSent = null;
  if (ghost) ghost.mode = m === 'game' ? 'elsewhere' : m;
}

/** While the game draws the people itself, send it each new set of cut-outs (copies it owns). */
function forwardPeople() {
  if (!current || !gameReady || peopleMode !== 'game' || !ghost) return;
  const seg = ghost.segmentation();
  if (!seg || seg === peopleSent) return;
  peopleSent = seg;
  const target = iframe.contentWindow;
  Promise.all(seg.people.map((c) => createImageBitmap(c.image as ImageBitmap)))
    .then((images) => {
      // Dropped if the game changed meanwhile.
      if (iframe.contentWindow !== target || peopleSent !== seg) return images.forEach((i) => i.close());
      const people = seg.people.map((c, i) => ({ ...c, image: images[i] }));
      post({ tg: 1, kind: 'people', people }, images);
    })
    .catch(() => {});
}

// ---------- Main ----------

// ---------- Offline cache & updates ----------

/**
 * The service worker (dist/sw.js, generated by the build) caches the whole site
 * so the box keeps working offline. After a deploy, the new version downloads in
 * the background; we switch to it only when nobody is playing.
 */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) updateReady = true; // first install isn't an update
  });
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000))
    .catch(() => {
      /* no sw.js in dev — that's fine */
    });
}

function maybeApplyUpdate(now: number) {
  if (!updateReady || current) return;
  if (frame.players.length) {
    idleSince = 0;
    return;
  }
  if (!idleSince) idleSince = now;
  if (now - idleSince > 10_000) location.reload();
}

async function main() {
  setupServiceWorker();
  // Games' sounds and speech play here, so the first tap/click/key unlocks them on iOS etc.
  unlockAudio();
  // Natural-sounding commentator voice: downloads once (~60 MB) in the background, then
  // works offline. ?voice=browser keeps the built-in voice; ?voice=<piper voice id> picks another.
  const voice = new URLSearchParams(location.search).get('voice');
  if (voice !== 'browser') startNaturalVoice(voice ?? undefined);
  const { source, warning } = await createInputFromUrl(undefined, (msg) => {
    if (msg !== 'Tracking') toast(msg, 60_000);
    else toastEl.hidden = true;
  });
  if (warning) toast(warning, 8000);
  simInput = source instanceof SimSource;
  const tracker = new PlayerTracker();
  // G: the players cut out of the camera picture, see-through over the home screen and games.
  ghost = new CameraGhost(source, () => frame);
  ghost.mode = current ? 'overlay' : 'elsewhere'; // home: drawn behind the tiles
  ghost.onToggle = (on) => post({ tg: 1, kind: 'peopleOn', on });
  // F: footprint guides under everyone's feet, flashing when someone stands too far back.
  feet = new FeetOverlay(() => frame);

  addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow || !isGameMessage(ev.data)) return;
    const m = ev.data;
    if (m.kind === 'key' && m.code === 'KeyG' && m.down) ghost?.toggle(); // G pressed while the game has focus
    if (m.kind === 'key' && m.code === 'KeyF' && m.down) feet?.toggle();
    if (m.kind === 'ready') {
      gameReady = true;
      setPeopleMode(peopleMode);
      post({ tg: 1, kind: 'init', inputName: source.name });
      post({ tg: 1, kind: 'peopleOn', on: ghost?.on ?? true });
    } else if (m.kind === 'exit') goHome();
    else if (m.kind === 'scores') {
      console.info('[scores]', current?.id, m.scores);
      lastScores = m.scores;
    }
    else if (m.kind === 'config') {
      if (m.exitGesture !== undefined) exitGestureOn = m.exitGesture;
      if (m.passTouches !== undefined) simLayer.hidden = !simInput || m.passTouches;
      if (m.feet !== undefined && feet) feet.allowed = m.feet;
      if (m.layout !== undefined && !urlLayout) layout.set(m.layout);
      if (m.baseline) layout.setBaseline(m.baseline.y, m.baseline.slot);
      if (m.normalise) layout.setNormalise(m.normalise.on, m.normalise.height);
      if (m.people !== undefined) setPeopleMode(m.people);
    }
    else if (m.kind === 'audio') runAudioCommand(m.cmd, (id) => post({ tg: 1, kind: 'audioDone', id }));
    else if (source instanceof SimSource) {
      if (m.kind === 'pointer') {
        source.pointer(m);
      } else if (m.kind === 'key') {
        source.key(m.code, m.down);
        if (m.code === 'Escape' && m.down) goHome();
      }
    }
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && current) goHome();
  });

  // Players tracked by the tracker (or, from the simulator's raw poses, here), then seated and laid out.
  const onTracked = (track: () => Frame) => {
    // On the home screen players are numbered left to right; in a game numbers stay put.
    tracker.slotsByPosition = !current;
    if (source.baseline !== undefined) layout.defaultBaseline = source.baseline; // the tracker's --baseline
    frame = layout.apply(track());
    if (current && gameReady) post({ tg: 1, kind: 'frame', frame });
  };
  source.onPoses((poses, t) => onTracked(() => tracker.update(poses, t, source.aspect)));
  source.onFrame?.((sf, t) => onTracked(() => tracker.fromServer(sf, t)));

  await loadGames();
  // ?game=<id> opens that game straight away (e.g. Beat Bash's editor going back to its songs).
  const params = new URLSearchParams(location.search);
  const wanted = params.get('game');
  if (wanted) {
    params.delete('game');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    const g = games.find((g) => g.id === wanted);
    if (g) launch(g);
  }
  requestAnimationFrame(render);
}

function render(now: number) {
  const { w, h } = fitCanvas(overlay, ctx);
  ctx.clearRect(0, 0, w, h);
  const players = frame.players;
  forwardPeople();

  if (!current) {
    renderPlayerChips(players);
    homeOverlay(players, now, w, h);
    maybeApplyUpdate(now);
  } else {
    exitGesture(players, now, w, h);
  }
  requestAnimationFrame(render);
}

function homeOverlay(players: Player[], now: number, w: number, h: number) {
  chooser.update(players, now, frame.aspect);
  // Behind the tiles: the people cut out of the camera picture and faint skeletons, so kids
  // can see they've been "seen". Cursors, labels and the crown go on the overlay above.
  fitCanvas(backdrop, bctx);
  bctx.clearRect(0, 0, w, h);
  const { map } = screenMapper(frame.aspect, w, h);
  drawPeople(bctx, frame, ghost?.segmentation() ?? null, w, h);
  for (const p of players) drawSkeleton(bctx, p, map, { alpha: 0.18, lineWidth: 10 });
  for (const p of players) {
    // Player number over each head, matching the chips.
    const head = map(p.keypoints[KP.nose]);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = p.color;
    ctx.font = `900 ${Math.round(h / 14)}px Nunito, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`P${p.slot + 1}`, head.x, head.y - h / 14);
    ctx.restore();
    // The crown marks who picks the game.
    if (players.length > 1 && chooser.isChooser(p)) drawCrown(ctx, head.x, head.y - h / 14 - h / 11 + Math.sin(now / 300) * h / 200, h / 13);
  }
  // Passing the choice on: a ring fills over the joined hands.
  const hold = chooser.hold;
  if (hold) {
    const to = players.find((p) => p.id === hold.other);
    const at = map(hold.at);
    if (to) drawHoldRing(ctx, at.x, at.y, h / 16, chooser.holdProgress(now), to.color, now);
  }

  document.querySelectorAll('.tile.hover, .pager.hover').forEach((el) => el.classList.remove('hover'));
  for (const p of players) {
    const c = handCursor(p);
    if (!c) {
      pressArmed(p.id, false, now);
      dwell.delete(p.id);
      continue;
    }
    const x = c.x * w;
    const y = c.y * h;
    // Only the chooser's hand presses things (and not while they're passing the choice on).
    if (players.length > 1 && (!chooser.isChooser(p) || chooser.passing)) {
      dwell.delete(p.id);
      ctx.save();
      ctx.globalAlpha = 0.3;
      drawCursor(x, y, p.color, 0, 0.7);
      ctx.restore();
      continue;
    }

    const target = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.tile, .pager');
    const id = target?.dataset.game ?? (target?.dataset.pager ? `pager:${target.dataset.pager}` : undefined);
    let progress = 0;
    const over = !!(target && id && !target.classList.contains('off'));
    // Debounce: after a press (or a new page), the hand must move off before pressing again.
    if (!pressArmed(p.id, over, now)) {
      dwell.delete(p.id);
      drawCursor(x, y, p.color, 0);
      continue;
    }
    if (target && id && over) {
      target.classList.add('hover');
      const isPager = id.startsWith('pager:');
      const d = dwell.get(p.id);
      if (!d || d.tile !== id) dwell.set(p.id, { tile: id, since: now });
      else progress = (now - d.since) / (isPager ? PAGER_DWELL_MS : DWELL_MS);
      if (progress >= 1) {
        if (isPager) turnPage(Number(target.dataset.pager));
        else {
          const g = games.find((g) => g.id === id);
          if (g) launch(g);
        }
        return;
      }
    } else dwell.delete(p.id);
    drawCursor(x, y, p.color, progress);
  }
}

function drawCursor(x: number, y: number, color: string, progress: number, scale = 1) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x, y, 22 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (progress > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y, 40, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(progress, 1));
    ctx.stroke();
  }
  ctx.restore();
}

/** Any player holding both hands above their head for 3 s returns to the menu. */
function exitGesture(players: Player[], now: number, w: number, h: number) {
  if (!exitGestureOn) {
    exitHoldSince = 0;
    exitEl.hidden = true;
    return;
  }
  const holding = players.some((p) => {
    const k = p.keypoints;
    return (
      k[KP.leftWrist].score > 0.4 &&
      k[KP.rightWrist].score > 0.4 &&
      k[KP.leftWrist].y < k[KP.nose].y - p.shoulderWidth * 0.5 &&
      k[KP.rightWrist].y < k[KP.nose].y - p.shoulderWidth * 0.5
    );
  });
  if (!holding) {
    exitHoldSince = 0;
    exitEl.hidden = true;
    return;
  }
  if (!exitHoldSince) exitHoldSince = now;
  const progress = (now - exitHoldSince) / EXIT_HOLD_MS;
  // Only show the warning after a moment, so quick "hands up" in games doesn't flash it.
  if (progress > 0.25) {
    exitEl.hidden = false;
    exitEl.textContent = `Hold hands up to go home… ${Math.ceil(EXIT_HOLD_MS / 1000 - (now - exitHoldSince) / 1000)}`;
    ctx.fillStyle = 'rgba(255,190,11,0.9)';
    ctx.fillRect(0, h - 12, w * Math.min(progress, 1), 12);
  }
  if (progress >= 1) goHome();
}

main().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${(e as Error).message}`, 20000);
});
