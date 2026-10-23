# CLAUDE.md

Camera-based motion games console (PlayBox). npm workspaces monorepo.

- `packages/sdk` — TypeScript SDK shared by launcher and games (tracker, input sources, bridge, draw helpers). Exports TS source directly; Vite compiles it.
- `apps/launcher` — host app (dashboard + debug page). Vite.
- `games/*` — one Vite project per game, each with `manifest.json` (`"enabled": false` hides it).
- `scripts/build.mjs` — builds the whole thing as a static site into `dist/` (catalog.json + service worker).
- `server/` and `scripts/` — plain Node ESM with `// @ts-check`, zero runtime deps. Keep it that way.
- `tracker/` — the pose tracker; all tracking runs here, none in the browser (Python in its own venv `tracker/.venv`, `npm run tracker`): camera → RTMO on OpenVINO → poses over `ws://127.0.0.1:8765`. Python deps live only in `tracker/requirements.txt`.

The launcher and games are a static site (keep every URL relative, `base: './'`); tracking comes from the tracker over a local WebSocket.

Commands: `npm run dev`, `npm run build`, `npm run build:games [id]`, `npm start` (serve dist), `npm run tracker`, `npm run typecheck`.

Conventions:
- Keypoints are COCO-17, normalised, mirrored (see `packages/sdk/src/types.ts`).
- Games must only depend on `@trackergame/sdk` and must work standalone (`createGame()` handles both modes).
- Test without a camera with `?input=sim&players=N`.
