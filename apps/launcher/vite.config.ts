import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
// @ts-ignore — plain JS helper shared with the games
import { devStaticPlugin } from '../../scripts/vite-dev-plugin.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

// base './' keeps every URL relative, so the built site works at a domain root
// or under a sub-path (e.g. GitHub Pages /TrackerGame/).
export default defineConfig({
  base: './',
  plugins: [devStaticPlugin()],
  server: { port: 5173 },
  // The natural-voice worker uses dynamic imports, which need ES-module workers.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@mintplex-labs/piper-tts-web'] },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        debug: resolve(here, 'debug.html'),
      },
    },
  },
});
