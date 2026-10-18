// @ts-check
// Puts MediaPipe's wasm runtime + pose models in ./vendor/mediapipe so the box
// works fully offline. Runs automatically after `npm install`.
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'vendor', 'mediapipe');
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const MODELS = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
};

const exists = (/** @type {string} */ p) =>
  stat(p).then(
    () => true,
    () => false,
  );

await mkdir(OUT, { recursive: true });

if (await exists(WASM_SRC)) {
  await cp(WASM_SRC, join(OUT, 'wasm'), { recursive: true });
  console.log('[assets] MediaPipe wasm copied');
} else {
  console.warn('[assets] @mediapipe/tasks-vision not installed yet — skipping wasm');
}

for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(OUT, name);
  if (await exists(dest)) continue;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`[assets] downloaded ${name}`);
  } catch (e) {
    console.warn(`[assets] could not download ${name} (${/** @type {Error} */ (e).message}). Camera input needs it; re-run "node scripts/fetch-assets.mjs" when online.`);
  }
}

// Beat Bash music: Kevin MacLeod tracks (incompetech.com, CC BY 4.0 — credited
// in songs.json and in the game). Downloaded, not committed. A song whose file
// is missing is simply hidden in the game.
const MUSIC_OUT = join(ROOT, 'games', 'beats', 'public', 'music');
const MUSIC = {
  'monkeys-spinning-monkeys.mp3': 'Monkeys Spinning Monkeys',
  'fluffing-a-duck.mp3': 'Fluffing a Duck',
  'pixel-peeker-polka-faster.mp3': 'Pixel Peeker Polka - faster',
  'sneaky-snitch.mp3': 'Sneaky Snitch',
  'hyperfun.mp3': 'Hyperfun',
  'run-amok.mp3': 'Run Amok',
};
await mkdir(MUSIC_OUT, { recursive: true });
for (const [name, title] of Object.entries(MUSIC)) {
  const dest = join(MUSIC_OUT, name);
  if (await exists(dest)) continue;
  const urls = [
    `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3`,
    `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${title.replace(/ /g, '%20')}.mp3`,
  ];
  let ok = false;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'PlayBox-asset-fetch' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50_000) throw new Error(`only ${buf.length} bytes`);
      await writeFile(dest, buf);
      console.log(`[assets] downloaded ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
      ok = true;
      break;
    } catch (e) {
      console.warn(`[assets] ${url}: ${/** @type {Error} */ (e).message}`);
    }
  }
  if (!ok) console.warn(`[assets] could not download ${name} — that song will be hidden in Beat Bash`);
}

// Freeze Dance reuses some of the same tracks (each game must work on its own,
// so it gets its own copies).
const FREEZE_OUT = join(ROOT, 'games', 'freeze', 'public', 'music');
await mkdir(FREEZE_OUT, { recursive: true });
for (const name of ['monkeys-spinning-monkeys.mp3', 'fluffing-a-duck.mp3', 'hyperfun.mp3', 'pixel-peeker-polka-faster.mp3']) {
  const from = join(MUSIC_OUT, name);
  const to = join(FREEZE_OUT, name);
  if ((await exists(from)) && !(await exists(to))) await cp(from, to);
}
