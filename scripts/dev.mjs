// @ts-check
// Development: builds the games once (if needed), then runs the launcher's Vite
// dev server with hot reload. Open http://localhost:5173
//
// After changing a game, rebuild it with `npm run build:games <id>` and refresh —
// or develop it on its own with `npm run dev -w games/<id>` (full hot reload).
import { spawn, spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITE = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

if (!(await stat(join(ROOT, 'dist', 'games', 'catalog.json')).catch(() => null))) {
  console.log('[dev] games not built yet — building them once');
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--games'], { stdio: 'inherit' });
}

console.log('\n  Launcher: http://localhost:5173   (?input=sim&players=2 to fake players)');
console.log('  Debug:    http://localhost:5173/debug.html\n');
const p = spawn(VITE, ['--host'], { cwd: join(ROOT, 'apps', 'launcher'), stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));
