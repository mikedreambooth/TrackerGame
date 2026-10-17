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
  screenMapper,
  type Frame,
} from '@trackergame/sdk';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const logEl = document.getElementById('log')!;
const cams = document.getElementById('cams') as HTMLSelectElement;

let frame: Frame = { t: 0, aspect: 4 / 3, players: [], events: [] };
let rawCount = 0;

async function main() {
  const { source, warning } = await createInputFromUrl();
  if (warning) log(warning);
  const tracker = new PlayerTracker();
  source.onPoses((poses, t) => {
    rawCount = poses.length;
    frame = tracker.update(poses, t, source.aspect);
    for (const e of frame.events) log(`${e.type} id=${e.playerId} slot=${e.slot}`);
  });

  // Camera picker.
  const params = new URLSearchParams(location.search);
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

main().catch((e) => (statsEl.textContent = `Error: ${(e as Error).message}`));
