#!/usr/bin/env node
// @ts-check
// PlayBox server: serves the launcher, the installed games and the admin API.
// Zero dependencies — runs on any Node >= 20.
//
//   PORT=8080 HOST=0.0.0.0 DATA_DIR=./data ADMIN_PIN=1234 node server/server.mjs
//
// Games live in DATA_DIR/games/<id>/ (each with a manifest.json).
// Visibility lives in DATA_DIR/state.json.
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA = process.env.DATA_DIR ?? join(ROOT, 'data');
const GAMES = join(DATA, 'games');
const STATE = join(DATA, 'state.json');
const LAUNCHER = join(ROOT, 'apps', 'launcher', 'dist');
const VENDOR = join(ROOT, 'vendor');
const ADMIN_PIN = process.env.ADMIN_PIN ?? '';
const MAX_UPLOAD = 200 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

await mkdir(GAMES, { recursive: true });

// ---------- state ----------

/** @returns {Promise<{ disabled: string[] }>} */
async function readState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return { disabled: [] };
  }
}
/** @param {{ disabled: string[] }} s */
async function writeState(s) {
  await writeFile(STATE, JSON.stringify(s, null, 2));
}

async function listGames() {
  const state = await readState();
  const out = [];
  for (const id of (await readdir(GAMES)).sort()) {
    if (!ID_RE.test(id)) continue;
    try {
      const m = JSON.parse(await readFile(join(GAMES, id, 'manifest.json'), 'utf8'));
      out.push({ ...m, id, enabled: !state.disabled.includes(id) });
    } catch {
      /* not a game folder */
    }
  }
  return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
}

// ---------- install from zip ----------

/** @param {Buffer} buf */
async function installZip(buf) {
  let entries = readZip(buf).filter((e) => !e.name.startsWith('__MACOSX/') && !e.name.endsWith('.DS_Store'));
  // Allow zips that wrap everything in one top folder.
  if (!entries.some((e) => e.name === 'manifest.json')) {
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    const [top] = tops;
    if (tops.size === 1 && entries.some((e) => e.name === `${top}/manifest.json`)) {
      entries = entries.map((e) => ({ ...e, name: e.name.slice(top.length + 1) }));
    }
  }
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('zip has no manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  if (!ID_RE.test(manifest.id ?? '')) throw new Error('manifest.id must be lowercase letters, digits and dashes');
  if (!manifest.title) throw new Error('manifest.title is required');
  if (!entries.some((e) => e.name === 'index.html')) throw new Error('zip has no index.html');

  const tmp = join(GAMES, `.tmp-${manifest.id}-${Date.now()}`);
  for (const e of entries) {
    const dest = normalize(join(tmp, e.name));
    if (!dest.startsWith(tmp + sep)) throw new Error(`unsafe path in zip: ${e.name}`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, e.data);
  }
  const final = join(GAMES, manifest.id);
  await rm(final, { recursive: true, force: true });
  await rename(tmp, final);
  return manifest.id;
}

// ---------- http ----------

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain', ...headers });
  res.end(isObj ? JSON.stringify(body) : /** @type {string | Buffer} */ (body));
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_UPLOAD) throw new Error('upload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} base
 * @param {string} rel
 */
async function serveFile(res, base, rel) {
  let file = normalize(join(base, rel));
  if (file !== base && !file.startsWith(base + sep)) return send(res, 403, 'forbidden');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    return send(res, 404, 'not found');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    // Games/launcher change when published; vendor assets are big and stable.
    'Cache-Control': base === VENDOR ? 'max-age=86400' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const authed = (/** @type {import('node:http').IncomingMessage} */ req) => !ADMIN_PIN || req.headers['x-admin-pin'] === ADMIN_PIN;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname);
    const m = req.method ?? 'GET';

    if (path === '/api/games' && m === 'GET') return send(res, 200, { games: await listGames() });

    if (path.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'admin PIN required' });
      if (path === '/api/games' && m === 'POST') {
        const id = await installZip(await readBody(req));
        console.log(`[admin] published ${id}`);
        return send(res, 200, { ok: true, id });
      }
      const match = /^\/api\/games\/([^/]+)(\/enabled)?$/.exec(path);
      if (match && ID_RE.test(match[1])) {
        const id = match[1];
        if (match[2] && m === 'PUT') {
          const { enabled } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const s = await readState();
          s.disabled = s.disabled.filter((/** @type {string} */ d) => d !== id);
          if (!enabled) s.disabled.push(id);
          await writeState(s);
          return send(res, 200, { ok: true });
        }
        if (!match[2] && m === 'DELETE') {
          await rm(join(GAMES, id), { recursive: true, force: true });
          console.log(`[admin] removed ${id}`);
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }

    if (path.startsWith('/games/')) return serveFile(res, GAMES, path.slice('/games/'.length));
    if (path.startsWith('/vendor/')) return serveFile(res, VENDOR, path.slice('/vendor/'.length));
    if (!existsSync(LAUNCHER)) {
      return send(res, 503, 'Launcher not built. Run `npm run build` (or use `npm run dev` while developing).');
    }
    return serveFile(res, LAUNCHER, path === '/' ? 'index.html' : path);
  } catch (e) {
    console.error(e);
    send(res, 400, { error: /** @type {Error} */ (e).message });
  }
}).listen(PORT, HOST, () => {
  console.log(`PlayBox server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (admin: /admin.html)`);
});
