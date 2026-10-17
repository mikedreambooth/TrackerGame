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
