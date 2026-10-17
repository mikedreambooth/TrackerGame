// @ts-check
// During `vite dev`, serves the shared folders the static site expects at its root:
//   /vendor/*  → ./vendor        (MediaPipe wasm + models, from fetch-assets.mjs)
//   /games/*   → ./dist/games    (built games + catalog.json, from build.mjs --games)
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOUNTS = [
  ['/vendor/', join(ROOT, 'vendor')],
  ['/games/', join(ROOT, 'dist', 'games')],
];
/** @type {Record<string, string>} */
const TYPES = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function devStaticPlugin() {
  return {
    name: 'playbox-dev-static',
    /** @param {{ middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }} server */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        const mount = MOUNTS.find(([prefix]) => url.startsWith(prefix));
        if (!mount) return next();
        const [prefix, dir] = mount;
        let file = normalize(join(dir, url.slice(prefix.length)));
        if (!file.startsWith(dir + sep)) return next();
        try {
          if (statSync(file).isDirectory()) file = join(file, 'index.html');
          statSync(file);
        } catch {
          res.statusCode = 404;
          return res.end(
            prefix === '/games/'
              ? 'Game not built — run `npm run build:games`'
              : 'Vendor file missing — run `node scripts/fetch-assets.mjs`',
          );
        }
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}
