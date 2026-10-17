# CLAUDE.md

Camera-based motion games console (PlayBox). npm workspaces monorepo.

- `packages/sdk` — TypeScript SDK shared by launcher and games (tracker, input sources, bridge, draw helpers). Exports TS source directly; Vite compiles it.
- `apps/launcher` — host app (dashboard, admin, debug pages). Vite.
- `games/*` — one Vite project per game, each with `manifest.json`.
- `server/` and `scripts/` — plain Node ESM with `// @ts-check`, zero runtime deps. Keep it that way.

Commands: `npm run dev`, `npm run build`, `npm run build:games [id]`, `npm start`, `npm run typecheck`.

Conventions:
- Keypoints are COCO-17, normalised, mirrored (see `packages/sdk/src/types.ts`).
- Games must only depend on `@trackergame/sdk` and must work standalone (`createGame()` handles both modes).
- Test without a camera with `?input=sim&players=N`.
