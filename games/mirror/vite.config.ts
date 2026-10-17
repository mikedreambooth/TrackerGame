import { defineConfig } from 'vite';
// @ts-ignore — plain JS helper shared by all games
import { devStaticPlugin } from '../../scripts/vite-dev-plugin.mjs';

// base './' so the built game works from /games/<id>/ inside the launcher.
export default defineConfig({
  base: './',
  plugins: [devStaticPlugin()],
  build: { target: 'es2022' },
});
