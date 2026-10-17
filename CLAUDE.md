# CLAUDE.md

Camera-based motion games console (PlayBox). npm workspaces monorepo.

- `packages/sdk` — TypeScript SDK shared by launcher and games (tracker, input sources, bridge, draw helpers). Exports TS source directly; Vite compiles it.
- `apps/launcher` — host app (dashboard + debug page). Vite.
- `games/*` — one Vite project per game, each with `manifest.json` (`"enabled": false` hides it).
- `scripts/build.mjs` — builds the whole thing as a static site into `dist/` (catalog.json + service worker).
- `server/` and `scripts/` — plain Node ESM with `// @ts-check`, zero runtime deps. Keep it that way.

The product is a static site: no backend. Keep every URL relative (`base: './'`).

Commands: `npm run dev`, `npm run build`, `npm run build:games [id]`, `npm start` (serve dist), `npm run typecheck`.

Conventions:
- Keypoints are COCO-17, normalised, mirrored (see `packages/sdk/src/types.ts`).
- Games must only depend on `@trackergame/sdk` and must work standalone (`createGame()` handles both modes).
- Test without a camera with `?input=sim&players=N`.
