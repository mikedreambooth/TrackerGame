// @ts-check
// One command for development: the Node server (catalog + games) and the
// launcher's Vite dev server with hot reload. Open http://localhost:5173
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

const installed = await readdir(join(ROOT, 'data', 'games')).catch(() => []);
if (!installed.filter((n) => !n.startsWith('.')).length) {
  console.log('[dev] no games installed yet — building them once');
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack-games.mjs')], { stdio: 'inherit' });
}

/** @param {string} tag @param {string} cmd @param {string[]} args @param {string} cwd */
function run(tag, cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (/** @type {NodeJS.WritableStream} */ out) => (/** @type {Buffer} */ d) =>
    d
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((l) => out.write(`[${tag}] ${l}\n`));
  p.stdout.on('data', pipe(process.stdout));
  p.stderr.on('data', pipe(process.stderr));
  p.on('exit', (code) => {
    console.log(`[${tag}] exited (${code})`);
    process.exit(code ?? 0);
  });
  return p;
}

run('server', process.execPath, ['--watch', join(ROOT, 'server', 'server.mjs')], ROOT);
run('launcher', VITE, ['--host'], join(ROOT, 'apps', 'launcher'));
console.log('\n  Launcher: http://localhost:5173   (?input=sim&players=2 to fake players)');
console.log('  Debug:    http://localhost:5173/debug.html');
console.log('  Admin:    http://localhost:5173/admin.html\n');
