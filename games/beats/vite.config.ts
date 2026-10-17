import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
// @ts-ignore — plain JS helper shared by all games
import { devStaticPlugin } from '../../scripts/vite-dev-plugin.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

// Two pages: the game, and the Song Editor (editor.html).
export default defineConfig({
  base: './',
  plugins: [devStaticPlugin()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: resolve(here, 'index.html'), editor: resolve(here, 'editor.html') },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@mintplex-labs/piper-tts-web'] },
});
