// @ts-check
/**
 * Runs the shared fixtures (tracker/tests/fixtures) through the SDK's PoseTracker
 * (packages/sdk/src/tracker.ts, the simulator's stand-in for the tracker), checks each
 * fixture's expectations, and compares every frame with tracker/players.py's output in
 * tracker/tests/out/ (written by test_players.py; run that first) so the two stay in step.
 *
 *   node tracker/tests/test-players.mjs
 *
 * Bundles the TypeScript with esbuild (installed with Vite). Exits 1 on any failure.
 */
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const bundle = await build({
  stdin: { contents: "export { PoseTracker } from './packages/sdk/src/tracker.ts';", resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { PoseTracker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

/** @param {any} obj @param {string} path */
const get = (obj, path) => path.split('.').reduce((o, p) => (o == null ? o : Array.isArray(o) ? o[Number(p)] : o[p]), obj);
/** @param {any} e @param {any} want */
const matches = (e, want) => (typeof want === 'string' ? e.type === want : Object.entries(want).every(([k, v]) => e[k] === v));

/** @param {any} fx @param {any[]} outs */
function check(fx, outs) {
  const errors = [];
  const exp = fx.expect;
  const events = outs.flatMap((o) => o.events);
  let i = 0;
  for (const want of exp.events ?? []) {
    while (i < events.length && !matches(events[i], want)) i++;
    if (i === events.length) {
      errors.push(`missing event ${JSON.stringify(want)} (events: ${events.map((e) => `${e.type}#${e.id}`).join(' ')})`);
      break;
    }
    i++;
  }
  for (const bad of exp.none ?? []) {
    const hit = events.find((e) => matches(e, bad));
    if (hit) errors.push(`unexpected ${JSON.stringify(hit)}`);
  }
  for (const c of exp.checks ?? []) {
    const out = outs.find((o) => o.t >= c.t);
    if (!out) {
      errors.push(`no frame at t=${c.t}`);
      continue;
    }
    if ('count' in c) {
      if (out.players.length !== c.count) errors.push(`t=${out.t}: ${out.players.length} players, want ${c.count}`);
      continue;
    }
    const p = out.players.find((/** @type {any} */ p) => p.id === c.id);
    if (!p) {
      errors.push(`t=${out.t}: no player ${c.id}`);
      continue;
    }
    const v = get(p, c.path);
    let ok = true;
    if ('eq' in c && v !== c.eq) ok = false;
    if ('gt' in c && !(typeof v === 'number' && v > c.gt)) ok = false;
    if ('lt' in c && !(typeof v === 'number' && v < c.lt)) ok = false;
    if (!ok) errors.push(`t=${out.t}: ${c.path} = ${JSON.stringify(v)}, want ${JSON.stringify({ eq: c.eq, gt: c.gt, lt: c.lt })}`);
  }
  return errors;
}

/**
 * Compare with the Python output. Python rounds (positions 4 places, the rest 3), and the SDK
 * sends depth too (kp entries 6-7), so numbers match within a small tolerance.
 * @param {any} a SDK value @param {any} b Python value @param {string} path @param {string[]} diffs
 */
function compare(a, b, path, diffs) {
  if (diffs.length > 5) return;
  if (typeof b === 'number' && typeof a === 'number') {
    if (Math.abs(a - b) > 2e-3 + 2e-3 * Math.abs(b)) diffs.push(`${path}: sdk ${a} vs py ${b}`);
  } else if (Array.isArray(b) && Array.isArray(a)) {
    if (a.length < b.length) diffs.push(`${path}: length ${a.length} vs ${b.length}`);
    else b.forEach((v, i) => compare(a[i], v, `${path}.${i}`, diffs));
  } else if (b && typeof b === 'object' && a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === 'v' || k === 'aspect' || k === 'detections') continue;
      compare(a[k], b[k], `${path}.${k}`, diffs);
    }
  } else if (a !== b) diffs.push(`${path}: sdk ${JSON.stringify(a)} vs py ${JSON.stringify(b)}`);
}

let failed = 0;
for (const file of readdirSync(join(here, 'fixtures')).filter((f) => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'));
  const tracker = new PoseTracker({ smoothing: true });
  const outs = fx.frames.map((/** @type {any} */ f) => {
    const poses = f.poses.map((/** @type {number[][]} */ p) => p.map(([x, y, score]) => ({ x, y, score })));
    const o = tracker.update(poses, f.t, fx.aspect);
    return { t: f.t, players: o.players, events: o.events };
  });
  const errors = check(fx, outs);
  const pyFile = join(here, 'out', `py-${fx.name}.json`);
  if (existsSync(pyFile)) {
    const py = JSON.parse(readFileSync(pyFile, 'utf8'));
    const diffs = [];
    if (py.length !== outs.length) diffs.push(`${outs.length} frames vs ${py.length}`);
    else outs.forEach((o, i) => compare(o, py[i], `t=${o.t}`, diffs));
    for (const d of diffs.slice(0, 5)) errors.push(`differs from Python: ${d}`);
  } else errors.push('no Python output to compare (run test_players.py first)');
  if (errors.length) failed++;
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${fx.name}: ${fx.about}`);
  for (const e of errors) console.log(`       ${e}`);
}
console.log(failed ? '\nFAILED' : '\nall passed (and the same as Python)');
process.exit(failed ? 1 : 0);
