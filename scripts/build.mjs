// @ts-check
// Builds the whole console as a static site in ./dist — host it anywhere
// (Cloudflare Pages, GitHub Pages, any web server) or serve it locally.
//
//   node scripts/build.mjs              everything (clean build)
//   node scripts/build.mjs --games      just the games + catalog (keeps the launcher)
//   node scripts/build.mjs slice        just one game + catalog
//
// Output:
//   dist/index.html, debug.html, assets/   launcher
//   dist/games/<id>/                       each enabled game
//   dist/games/catalog.json                what the launcher shows
//   dist/vendor/mediapipe/                 wasm runtime + pose models
//   dist/sw.js                             offline cache (generated)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const GAMES_SRC = join(ROOT, 'games');
const VENDOR = join(ROOT, 'vendor', 'mediapipe');
const VITE = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const gamesOnly = args.includes('--games') || only.length > 0;

/** Files that are big and rarely needed: cached on first use instead of up front. */
const LAZY = [/pose_landmarker_full\.task$/, /nosimd/, /\.mp3$/];

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** @param {string} cwd @param {string} outDir */
function viteBuild(cwd, outDir) {
  const r = spawnSync(VITE, ['build', '--base', './', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`vite build failed in ${relative(ROOT, cwd)}`);
}

// ---------- launcher ----------
if (!gamesOnly) {
  await rm(DIST, { recursive: true, force: true });
  console.log('[build] launcher');
  viteBuild(join(ROOT, 'apps', 'launcher'), DIST);
}
await mkdir(join(DIST, 'games'), { recursive: true });

// ---------- games ----------
for (const name of (await readdir(GAMES_SRC)).sort()) {
  if (only.length && !only.includes(name)) continue;
  const dir = join(GAMES_SRC, name);
  const manifestPath = join(dir, 'manifest.json');
  if (!(await stat(manifestPath).catch(() => null))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const out = join(DIST, 'games', manifest.id);
  if (manifest.enabled === false) {
    console.log(`[build] ${manifest.id}: hidden (enabled: false) — skipped`);
    await rm(out, { recursive: true, force: true });
    continue;
  }
  console.log(`[build] game ${manifest.id}`);
  viteBuild(dir, out);
  await cp(manifestPath, join(out, 'manifest.json'));
}

// ---------- catalog ----------
const catalog = [];
for (const id of await readdir(join(DIST, 'games'))) {
  const m = await readFile(join(DIST, 'games', id, 'manifest.json'), 'utf8').catch(() => null);
  if (m) catalog.push(JSON.parse(m));
}
catalog.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
await writeFile(join(DIST, 'games', 'catalog.json'), JSON.stringify({ games: catalog }, null, 2));
console.log(`[build] catalog: ${catalog.map((g) => g.id).join(', ') || '(empty)'}`);

// ---------- vendor ----------
if (await stat(VENDOR).catch(() => null)) {
  await cp(VENDOR, join(DIST, 'vendor', 'mediapipe'), { recursive: true });
} else {
  console.warn('[build] vendor/mediapipe missing — camera input will not work. Run: node scripts/fetch-assets.mjs');
}

// ---------- version stamp ----------
// Shown on the debug page so you can tell which build a device is running.
const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
const commit = (process.env.GITHUB_SHA ?? '').slice(0, 7) || git.stdout?.trim() || 'local';
const builtAt = new Date().toISOString();
await writeFile(join(DIST, 'version.json'), JSON.stringify({ commit, builtAt }, null, 2));
console.log(`[build] version ${commit} @ ${builtAt}`);

// ---------- service worker ----------
const files = (await walk(DIST))
  .map((f) => relative(DIST, f).split('\\').join('/'))
  .filter((f) => f !== 'sw.js' && !f.startsWith('.'));
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(f).update(await readFile(join(DIST, f)));
const version = hash.digest('hex').slice(0, 12);
const precache = ['./', ...files.filter((f) => !LAZY.some((re) => re.test(f)))];
const template = await readFile(join(ROOT, 'scripts', 'sw.template.js'), 'utf8');
await writeFile(
  join(DIST, 'sw.js'),
  template.replace('__VERSION__', () => version).replace('__PRECACHE__', () => JSON.stringify(precache)),
);
console.log(`[build] service worker v${version}, ${precache.length} files precached`);
console.log(`[build] done → ${relative(ROOT, DIST)}/`);
