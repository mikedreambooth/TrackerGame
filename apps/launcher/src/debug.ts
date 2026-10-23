/**
 * Tracker debug view: the native tracker's camera picture + skeletons + IDs + fps + event log.
 * First thing to open when trying a new camera or room: /debug.html
 */
import {
  PlayerTracker,
  cameraImage,
  createInputFromUrl,
  drawSkeleton,
  fitCanvas,
  saveRotation,
  savedRotation,
  naturalVoice,
  say,
  screenMapper,
  startNaturalVoice,
  unlockAudio,
  type Frame,
} from '@trackergame/sdk';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const logEl = document.getElementById('log')!;
const rot = document.getElementById('rot') as HTMLSelectElement;

// Which way up the camera is mounted: the tracker turns the picture before tracking.
rot.value = String(savedRotation());
rot.onchange = () => {
  saveRotation(rot.value === '0' ? 0 : 180);
  const params = new URLSearchParams(location.search);
  params.delete('rotate');
  location.search = params.toString(); // restart tracking the new way up
};

let frame: Frame = { t: 0, aspect: 4 / 3, players: [], events: [] };
let rawCount = 0;

// Show anything that goes wrong right on the page (handy on phones with no console).
addEventListener('error', (e) => log(`error: ${e.message}`));
addEventListener('unhandledrejection', (e) => log(`error: ${(e.reason as Error)?.message ?? e.reason}`));

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.get('input') !== 'sim') {
    const simUrl = new URLSearchParams(params);
    simUrl.set('input', 'sim');
    const a = document.createElement('a');
    a.href = `?${simUrl}`;
    a.textContent = 'Use simulator instead';
    a.style.display = 'block';
    statsEl.after(a);
  }
  const started = performance.now();
  const { source, warning } = await createInputFromUrl(params, (msg) => {
    statsEl.textContent = `${msg}\n(${((performance.now() - started) / 1000).toFixed(0)} s)`;
    log(msg);
  });
  if (warning) log(warning);
  const tracker = new PlayerTracker();
  source.onPoses((poses, t) => {
    rawCount = poses.length;
    frame = tracker.update(poses, t, source.aspect);
    for (const e of frame.events) log(`${e.type} id=${e.playerId} slot=${e.slot}`);
  });

  const image = cameraImage(source);
  const draw = () => {
    const { w, h } = fitCanvas(canvas, ctx);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const { map } = screenMapper(frame.aspect, w, h, 'contain'); // show the whole camera view
    // Camera picture: small frames from the tracker, already turned the right way up.
    const v = image();
    if (v) {
      // Draw mirrored, matching the tracker's mirrored coordinates.
      const a = map({ x: 0, y: 0 });
      const b = map({ x: 1, y: 1 });
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.translate(b.x, a.y);
      ctx.scale(-1, 1);
      ctx.drawImage(v, 0, 0, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
    for (const p of frame.players) {
      drawSkeleton(ctx, p, map, { lineWidth: 6 });
      for (const k of p.keypoints) {
        if (k.score < 0.3) continue;
        const s = map(k);
        ctx.fillStyle = '#fff';
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
      }
      const top = map({ x: p.bbox.x, y: p.bbox.y });
      ctx.fillStyle = p.color;
      ctx.font = 'bold 20px ui-monospace, monospace';
      ctx.fillText(`P${p.slot + 1} #${p.id}`, top.x, top.y - 10);
    }
    const s = source.stats?.() ?? { source: source.name };
    statsEl.textContent =
      Object.entries(s)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n') + `\nraw poses: ${rawCount}\nplayers: ${frame.players.length}`;
    requestAnimationFrame(draw);
  };
  draw();
}

function log(msg: string) {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  logEl.prepend(d);
  while (logEl.childElementCount > 20) logEl.lastChild!.remove();
}

interface BuildInfo {
  commit: string;
  builtAt: string;
}

/**
 * Shows the build this device is running (served from the offline cache, so it
 * matches the code in use) and whether a newer one has been deployed.
 */
async function showVersion() {
  const el = document.getElementById('version')!;
  const get = async (init?: RequestInit) => {
    try {
      const r = await fetch('version.json', init);
      return r.ok ? ((await r.json()) as BuildInfo) : null;
    } catch {
      return null;
    }
  };
  const fmt = (b: BuildInfo) =>
    `${b.commit} · ${new Date(b.builtAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
  const running = await get();
  if (!running) {
    el.textContent = 'version: dev (unbuilt)';
    return;
  }
  el.textContent = `version: ${fmt(running)}`;
  const latest = await get({ cache: 'no-store' });
  if (latest && latest.commit !== running.commit) {
    el.textContent = `version: ${fmt(running)} → ${latest.commit} available`;
    const b = document.createElement('button');
    b.textContent = 'Update';
    b.onclick = async () => {
      // Install the new service worker (downloads the new build), then reload onto it.
      const sw = navigator.serviceWorker;
      const reload = () => location.reload();
      const reg = await sw?.getRegistration();
      if (!sw || !reg) return reload();
      b.disabled = true;
      b.textContent = 'Downloading…';
      sw.addEventListener('controllerchange', reload);
      const watch = (w: ServiceWorker | null) => {
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' || w.state === 'activating') b.textContent = 'Installing…';
          if (w.state === 'activated') reload();
          if (w.state === 'redundant') {
            b.disabled = false;
            b.textContent = 'Update failed — try again';
          }
        });
      };
      reg.addEventListener('updatefound', () => watch(reg.installing));
      watch(reg.installing ?? reg.waiting);
      await reg.update().catch(() => {
        b.disabled = false;
        b.textContent = 'Offline? Try again';
      });
      setTimeout(reload, 180_000); // last resort
    };
    el.append(b);
  } else if (latest) {
    el.textContent += ' (latest)';
  }
}

/** Natural voice status + a button to hear it (or the built-in fallback). */
function showVoice() {
  const el = document.getElementById('voice')!;
  const text = document.createElement('span');
  const btn = document.createElement('button');
  btn.textContent = 'Test voice';
  btn.onclick = () => say("Hello! I'm the PlayBox commentator. On your marks, get set, go!", { interrupt: true });
  el.replaceChildren(text, btn);
  unlockAudio();
  const voice = new URLSearchParams(location.search).get('voice');
  if (voice !== 'browser') startNaturalVoice(voice ?? undefined);
  naturalVoice.onStatus((s) => {
    text.textContent =
      s.state === 'ready'
        ? `voice: ${s.voiceId} (natural)`
        : s.state === 'loading'
          ? `voice: ${s.message ?? 'loading…'} — built-in voice until ready`
          : s.state === 'failed'
            ? `voice: built-in (${s.message})`
            : 'voice: built-in';
  });
}

showVersion();
showVoice();
main().catch((e) => (statsEl.textContent = `Error: ${(e as Error).message}`));
