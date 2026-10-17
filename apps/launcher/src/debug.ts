/**
 * Tracker debug view: camera feed + skeletons + IDs + fps + event log.
 * First thing to open when trying a new camera or room: /debug.html
 */
import {
  PlayerTracker,
  createInputFromUrl,
  drawSkeleton,
  fitCanvas,
  listCameras,
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
const cams = document.getElementById('cams') as HTMLSelectElement;

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

  // Camera picker.
  for (const c of await listCameras().catch(() => [])) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || c.deviceId.slice(0, 8);
    o.selected = params.get('camera') === c.deviceId;
    cams.append(o);
  }
  cams.onchange = () => {
    if (cams.value) params.set('camera', cams.value);
    else params.delete('camera');
    location.search = params.toString();
  };

  const draw = () => {
    const { w, h } = fitCanvas(canvas, ctx);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const { map } = screenMapper(frame.aspect, w, h);
    const v = source.video;
    if (v && v.readyState >= 2) {
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
      b.textContent = 'Updating…';
      const sw = navigator.serviceWorker;
      const reload = () => location.reload();
      if (!sw) return reload();
      sw.addEventListener('controllerchange', reload);
      setTimeout(reload, 20_000); // fallback
      const reg = await sw.getRegistration();
      if (!reg) return reload();
      await reg.update().catch(reload);
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
