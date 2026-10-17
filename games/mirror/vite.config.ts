import { defineConfig } from 'vite';
// @ts-ignore — plain JS helper shared by all games
import { vendorPlugin } from '../../scripts/vite-vendor-plugin.mjs';

// base './' so the built game works from /games/<id>/ inside the launcher.
export default defineConfig({
  base: './',
  plugins: [vendorPlugin()],
  build: { target: 'es2022' },
});
