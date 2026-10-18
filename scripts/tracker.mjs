// @ts-check
// Runs the native pose tracker (tracker/tracker.py) in its own Python venv.
// First run creates tracker/.venv and installs tracker/requirements.txt; it reinstalls
// whenever that file changes. Extra arguments go to the tracker:
//   npm run tracker -- --model rtmo-m -v
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'tracker');
const VENV = join(DIR, '.venv');
const WIN = process.platform === 'win32';
const PY = join(VENV, WIN ? 'Scripts/python.exe' : 'bin/python');
const REQS = join(DIR, 'requirements.txt');
const STAMP = join(VENV, '.requirements.sha1');

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (!existsSync(PY)) {
  console.log('[tracker] creating tracker/.venv');
  // Windows: the `py` launcher, else `python`. Elsewhere: python3.
  const candidates = WIN ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  const ok = candidates.some(([cmd, pre]) => {
    try {
      return run(/** @type {string} */ (cmd), [.../** @type {string[]} */ (pre), '-m', 'venv', VENV]) === 0;
    } catch {
      return false;
    }
  });
  if (!ok) {
    console.error('[tracker] Python 3.10+ is needed (python.org, or `sudo apt install python3-venv`).');
    process.exit(1);
  }
}

const want = createHash('sha1').update(readFileSync(REQS)).digest('hex');
if (!existsSync(STAMP) || readFileSync(STAMP, 'utf8') !== want) {
  console.log('[tracker] installing Python packages (first run, ~200 MB)…');
  if (run(PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', REQS]) !== 0) process.exit(1);
  writeFileSync(STAMP, want);
}

// On Windows the venv's python.exe is a stub that starts the real interpreter as a child,
// so killing it (or us) would orphan the tracker, holding the port and the camera. Instead
// Python watches its stdin: when we exit, however we exit, the pipe closes and it stops.
const child = spawn(PY, ['-u', join(DIR, 'tracker.py'), '--exit-with-stdin', ...process.argv.slice(2)], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.on('error', (e) => {
  console.error(`[tracker] ${e.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));

// Ctrl+C reaches Python directly (same console); we just wait for it to finish cleaning up.
// Other signals: ask it to stop. A second request, or no exit within 8 s, kills the tree.
let stopping = false;
function stop() {
  if (stopping) return kill();
  stopping = true;
  child.stdin?.end();
  setTimeout(kill, 8000).unref();
}
function kill() {
  if (child.exitCode !== null || !child.pid) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}
for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])) process.on(sig, stop);
