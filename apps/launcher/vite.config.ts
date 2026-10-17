import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
// @ts-ignore — plain JS helper shared with the games
import { vendorPlugin } from '../../scripts/vite-vendor-plugin.mjs';

export default defineConfig({
  plugins: [vendorPlugin()],
  server: {
    port: 5173,
    // The Node server (npm start / npm run dev) owns the game catalog and files.
    proxy: {
      '/api': 'http://localhost:8080',
      '/games': 'http://localhost:8080',
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        admin: resolve(here, 'admin.html'),
        debug: resolve(here, 'debug.html'),
      },
    },
  },
});
