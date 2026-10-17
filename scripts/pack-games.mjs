// @ts-check
// Builds every game in ./games, installs it into ./data/games (what the server
// serves) and writes a publishable zip to ./build/game-zips/<id>.zip.
//
//   node scripts/pack-games.mjs            build + install all games
//   node scripts/pack-games.mjs slice      just one
//   node scripts/pack-games.mjs --zip-only build zips without installing locally
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../server/zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GAMES_SRC = join(ROOT, 'games');
const INSTALL = join(process.env.DATA_DIR ?? join(ROOT, 'data'), 'games');
const ZIPS = join(ROOT, 'build', 'game-zips');
const VITE = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

const args = process.argv.slice(2);
const zipOnly = args.includes('--zip-only');
const only = args.filter((a) => !a.startsWith('--'));

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

await mkdir(ZIPS, { recursive: true });
await mkdir(INSTALL, { recursive: true });

for (const name of await readdir(GAMES_SRC)) {
  if (only.length && !only.includes(name)) continue;
  const dir = join(GAMES_SRC, name);
  const manifestPath = join(dir, 'manifest.json');
  if (!(await stat(manifestPath).catch(() => null))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  console.log(`\n[pack] building ${manifest.id}`);
  const r = spawnSync(VITE, ['build', '--logLevel', 'warn'], { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[pack] ${manifest.id} failed to build`);
    process.exitCode = 1;
    continue;
  }
  const dist = join(dir, 'dist');
  await cp(manifestPath, join(dist, 'manifest.json'));

  const files = await walk(dist);
  const zip = writeZip(
    await Promise.all(
      files.map(async (f) => ({ name: relative(dist, f).split('\\').join('/'), data: await readFile(f) })),
    ),
  );
  await writeFile(join(ZIPS, `${manifest.id}.zip`), zip);
  console.log(`[pack] zip → build/game-zips/${manifest.id}.zip`);

  if (!zipOnly) {
    const dest = join(INSTALL, manifest.id);
    await rm(dest, { recursive: true, force: true });
    await cp(dist, dest, { recursive: true });
    console.log(`[pack] installed → data/games/${manifest.id}`);
  }
}
