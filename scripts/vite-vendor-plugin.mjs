// @ts-check
// Serves /vendor/* (MediaPipe wasm + model, fetched by fetch-assets.mjs) from the
// repo root during `vite dev`, so the launcher and standalone games share one copy.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
};

export function vendorPlugin() {
  return {
    name: 'trackergame-vendor',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/vendor/')) return next();
        const file = normalize(join(ROOT, decodeURIComponent(url)));
        if (!file.startsWith(join(ROOT, 'vendor')) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end('vendor file not found — run `npm run postinstall` to fetch MediaPipe assets');
        }
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}
