# PlayBox (TrackerGame)

A home-made, camera-based motion games console for the living room. One camera,
up to four players, no controllers — your body is the input. Inspired by
Nex Playground, built as a Christmas present.

```
camera ─▶ pose model ─▶ PlayerTracker (IDs, smoothing, gestures) ─▶ launcher ─▶ game (iframe)
```

**It's a static website.** Everything — camera, pose tracking, games — runs in the
browser, so the whole console builds to a folder of files (`dist/`) that can be
hosted anywhere. The box behind the TV just opens the site in a full-screen
browser. A service worker caches it, so after the first load it works offline.
Camera video never leaves the box; the site only serves code.

- **Everything is TypeScript**, except a few zero-dependency Node build scripts (`.mjs` with `// @ts-check`).
- **Games are plain web bundles** (Canvas 2D, PixiJS, three.js — your choice) that talk to the launcher through `@trackergame/sdk`.

## Quick start

```bash
npm install        # also downloads the MediaPipe model into ./vendor
npm run dev        # launcher with hot reload
```

| URL | What |
| --- | --- |
| http://localhost:5173 | Launcher (uses the webcam) |
| http://localhost:5173/?input=sim&players=2 | Launcher with **fake players** — no camera needed |
| http://localhost:5173/debug.html | Tracker debug: camera feed, skeletons, IDs, fps, camera picker |

**Simulator controls:** player 1's right hand follows the mouse (hold the button for both hands), `Space` jumps, `H` raises both hands, `1`–`4` toggle players in and out of view.

**In the launcher:** raise a hand and a cursor appears; hold it over a game for about a second to start it. In a game, **hold both hands above your head for 3 s** to go home (or press `Esc`).

### Choosing the camera

Open `/debug.html` and pick from the camera menu — the choice is added to the URL as `?camera=<id>`. Other URL options: `&model=full` (more accurate, slower), `&input=ws` (native tracker, see below). Put the same options in the kiosk URL on the box.

The PS3 Eye works out of the box on Linux (640×480 at 60 fps). Keep the room well lit — it's noisy in the dark.

## Making a game

Copy `games/mirror` (simplest) and rename. A game is:

```
games/my-game/
  manifest.json     { "id": "my-game", "title": "My Game", "players": {"min":1,"max":4}, "icon": "icon.svg" }
  index.html
  public/icon.svg   tile artwork (4:3)
  src/main.ts
```

```ts
import { createGame, KP } from '@trackergame/sdk';

const game = await createGame();
game.on('jump', (e) => console.log(`player ${e.slot + 1} jumped`));

function loop() {
  for (const p of game.frame.players) {
    const hand = p.keypoints[KP.rightWrist]; // x,y 0..1 (mirrored), vx,vy speed, score
  }
  requestAnimationFrame(loop);
}
loop();
```

Develop it on its own with full hot reload: `npm run dev -w games/my-game` (add `?input=sim` to fake players). To see it inside the launcher, run `npm run build:games my-game` and refresh.

The SDK gives you:

- `game.frame.players` — up to 4 players with stable `id`, seat `slot` (0–3), `color`, 17 smoothed keypoints with velocity, `center`, `shoulderWidth`, `bbox`.
- Events: `join`, `leave`, `jump`, `handsUp`.
- Helpers: `screenMapper` (camera → screen pixels), `drawSkeleton`, `handCursor`, `fitCanvas`, `blip`/`noise` sound effects.
- `game.reportScores({0: 12, 1: 9})`, `game.exit()`.

## Publishing and removing games

Publishing is just git:

- **Add a game:** add its folder under `games/` and push.
- **Hide a game** without deleting it: set `"enabled": false` in its `manifest.json` and push.
- **Remove a game:** delete its folder and push.
- **Order** on the dashboard: `"order"` in the manifest (lower first).

GitHub Actions rebuilds and redeploys on every push to `main` (about a minute). The box picks up the new version in the background and switches to it the next time nobody is in front of the camera.

## Hosting (GitHub Pages)

Every push to `main` is built and published by `.github/workflows/build.yml`.
One-time setup, after making the repo public:

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or run the workflow from the Actions tab).
3. The site is live at **https://mikedreambooth.github.io/TrackerGame/**.

Any other static host works the same way (`npm run build`, publish `dist/`). All paths are relative, so the site works under a sub-path like `/TrackerGame/` or at a domain root. It must be served over **HTTPS** (or `localhost`) for the browser to allow camera access — GitHub Pages is.

To preview a production build locally: `npm run build && npm start` → http://localhost:8080.

## Setting up the box

On a Debian/Ubuntu machine with auto-login enabled:

```bash
git clone https://github.com/mikedreambooth/TrackerGame ~/TrackerGame && cd ~/TrackerGame
./deploy/setup-kiosk.sh https://mikedreambooth.github.io/TrackerGame/
```

This installs Chromium, opens the site full-screen on login with camera access pre-approved, keeps the screen awake and ignores the laptop lid closing. Run it **without** a URL to build and serve the site on the box itself instead (no internet or hosting needed at all).

## Upgrading tracking for 4 players

MediaPipe in the browser is fine for 1–2 players. For 4, run a native single-pass model (YOLO-pose or RTMO via ONNX Runtime/OpenVINO) as a local process on the box that sends poses over WebSocket, and add `?input=ws` to the kiosk URL. A hosted HTTPS page can connect to `ws://localhost`, though newer Chrome versions may ask for local-network permission the first time; if that gets in the way, run the site locally on the box too (`setup-kiosk.sh` with no URL). The wire format is documented in `packages/sdk/src/sources/websocket.ts`. Games don't change.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design notes.
