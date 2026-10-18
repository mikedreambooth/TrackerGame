import {
  PlayerTracker,
  SimSource,
  createInputFromUrl,
  detectTaps,
  drawSkeleton,
  fitCanvas,
  handCursor,
  isGameMessage,
  screenMapper,
  KP,
  type Frame,
  type HostMessage,
  type Player,
  blip,
  runAudioCommand,
  startNaturalVoice,
  stopAllGameAudio,
  unlockAudio,
} from '@trackergame/sdk';
import { fetchGames, gameUrl, iconUrl, type GameEntry } from './catalog';

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
  const key = players.map((p) => `${p.id}:${p.slot}`).join(',');
  if (playersEl.dataset.key === key) return;
  playersEl.dataset.key = key;
  playersEl.replaceChildren(
    ...players.map((p) => {
      const d = document.createElement('div');
      d.className = 'chip';
      d.style.background = p.color;
      d.textContent = String(p.slot + 1);
      return d;
    }),
  );
  hintEl.textContent = players.length
    ? 'Raise a hand and hold it over a game'
    : 'Stand in front of the TV and raise a hand to choose a game';
}

// ---------- Game hosting ----------

function launch(g: GameEntry) {
  current = g;
  gameReady = false;
  exitGestureOn = true;
  dwell.clear();
  iframe.src = gameUrl(g);
  iframe.hidden = false;
  homeEl.hidden = true;
  simLayer.hidden = !simInput;
  if (!simInput) iframe.focus(); // in sim mode keys stay with the host simulator
}

function goHome() {
  stopAllGameAudio();
  current = null;
  gameReady = false;
  iframe.src = 'about:blank';
  iframe.hidden = true;
  simLayer.hidden = true;
  homeEl.hidden = false;
  exitEl.hidden = true;
  exitHoldSince = 0;
  loadGames(); // pick up anything published while we were playing
}

function post(m: HostMessage) {
  iframe.contentWindow?.postMessage(m, '*');
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

  addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow || !isGameMessage(ev.data)) return;
    const m = ev.data;
    if (m.kind === 'ready') {
      gameReady = true;
      post({ tg: 1, kind: 'init', inputName: source.name });
    } else if (m.kind === 'exit') goHome();
    else if (m.kind === 'scores') console.info('[scores]', current?.id, m.scores);
    else if (m.kind === 'config') {
      if (m.exitGesture !== undefined) exitGestureOn = m.exitGesture;
      if (m.passTouches !== undefined) simLayer.hidden = !simInput || m.passTouches;
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

  source.onPoses((poses, t) => {
    // On the home screen players are numbered left to right; in a game numbers stay put.
    tracker.slotsByPosition = !current;
    frame = tracker.update(poses, t, source.aspect);
    if (current && gameReady) post({ tg: 1, kind: 'frame', frame });
  });

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
  // Faint skeletons so kids can see they've been "seen".
  const { map } = screenMapper(frame.aspect, w, h);
  for (const p of players) {
    drawSkeleton(ctx, p, map, { alpha: 0.18, lineWidth: 10 });
    // Player number over each head, matching the chips.
    const head = map(p.keypoints[KP.nose]);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = p.color;
    ctx.font = `900 ${Math.round(h / 14)}px Nunito, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`P${p.slot + 1}`, head.x, head.y - h / 14);
    ctx.restore();
  }

  document.querySelectorAll('.tile.hover, .pager.hover').forEach((el) => el.classList.remove('hover'));
  for (const p of players) {
    const c = handCursor(p);
    if (!c) {
      dwell.delete(p.id);
      continue;
    }
    const x = c.x * w;
    const y = c.y * h;

    const target = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.tile, .pager');
    const id = target?.dataset.game ?? (target?.dataset.pager ? `pager:${target.dataset.pager}` : undefined);
    let progress = 0;
    if (target && id && !target.classList.contains('off')) {
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

function drawCursor(x: number, y: number, color: string, progress: number) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
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
