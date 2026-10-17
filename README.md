# PlayBox (TrackerGame)

A home-made, camera-based motion games console for the living room. One camera,
up to four players, no controllers — your body is the input. Inspired by
Nex Playground, built as a Christmas present.

```
camera ─▶ pose tracker ─▶ PlayerTracker (IDs, smoothing, gestures) ─▶ launcher ─▶ game (iframe)
```

- **Everything in the browser is TypeScript**: SDK, launcher, games.
- **Games are plain web bundles** (Canvas 2D, PixiJS, three.js — your choice) that talk to the launcher through `@trackergame/sdk`.
- **The server is tiny and dependency-free** (`server/server.mjs`): it serves the launcher, the installed games and an admin page for publishing/removing games.
- **Works offline.** Camera frames never leave the box.

## Quick start (laptop or dev machine)

```bash
npm install        # also downloads the MediaPipe model into ./vendor
npm run dev        # server + launcher with hot reload
```

| URL | What |
| --- | --- |
| http://localhost:5173 | Launcher (uses the webcam) |
| http://localhost:5173/?input=sim&players=2 | Launcher with **fake players** — no camera needed |
| http://localhost:5173/debug.html | Tracker debug: camera feed, skeletons, IDs, fps, camera picker |
| http://localhost:5173/admin.html | Publish / hide / remove games |

**Simulator controls:** player 1's right hand follows the mouse (hold the button for both hands), `Space` jumps, `H` raises both hands, `1`–`4` toggle players in and out of view.

**In the launcher:** raise a hand, a cursor appears; hold it over a game for ~1 s to start it. In a game, **hold both hands above your head for 3 s** to go home (or press `Esc`).

### Choosing the camera

Open `/debug.html` and pick from the camera menu — the choice is added to the URL as `?camera=<id>`. Other URL options: `&model=full` (more accurate, slower), `&input=ws` (native tracker, see below).

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
import { createGame, screenMapper, fitCanvas, KP } from '@trackergame/sdk';

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

Develop it on its own with `npm run dev -w games/my-game` (add `?input=sim` to fake players). The SDK gives you:

- `game.frame.players` — up to 4 players with stable `id`, seat `slot` (0–3), `color`, 17 smoothed keypoints with velocity, `center`, `shoulderWidth`, `bbox`.
- Events: `join`, `leave`, `jump`, `handsUp`.
- Helpers: `screenMapper` (camera → screen pixels), `drawSkeleton`, `handCursor`, `fitCanvas`, `blip`/`noise` sound effects.
- `game.reportScores({0: 12, 1: 9})`, `game.exit()`.

## Publishing and removing games

```bash
npm run build:games          # build all games → installed in ./data/games + zips in ./build/game-zips
npm run build:games slice    # just one
```

To put a game on the box from another computer: open `http://<box-ip>:8080/admin.html` on your phone or laptop and upload the zip. Same page toggles visibility (hide a game without deleting it) and removes games. Set `ADMIN_PIN=1234` in the server's environment to lock the admin page.

## Installing on the box

On a Debian/Ubuntu machine with auto-login enabled:

```bash
git clone <this repo> ~/TrackerGame && cd ~/TrackerGame
./deploy/setup-kiosk.sh
```

This installs Node and Chromium, builds everything, runs the server as a systemd service, opens Chromium full-screen on login (camera permission pre-approved), keeps the screen awake and ignores the laptop lid closing.

## Upgrading tracking for 4 players

MediaPipe in the browser is fine for 1–2 players. For 4, run a native single-pass model (YOLO-pose or RTMO via ONNX Runtime/OpenVINO) as a separate process that sends poses over WebSocket, and start the launcher with `?input=ws`. The wire format is documented in `packages/sdk/src/sources/websocket.ts`. Games don't change.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design notes.
