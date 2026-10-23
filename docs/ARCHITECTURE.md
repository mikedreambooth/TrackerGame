# Architecture

## Layers

| Layer | Where | Notes |
| --- | --- | --- |
| Camera | USB webcam (PS3 Eye now; wider-angle 60 fps camera later) | ~90° FOV needed for 4 kids side by side |
| Pose model | the tracker (`tracker/`, Python: camera → RTMO on OpenVINO), streamed by `packages/sdk/src/sources/websocket.ts` | the simulator (`sources/sim.ts`) for testing |
| Player tracking | `PlayerTracker` (`tracker.ts`) | IDs, seats, One Euro smoothing, velocities, gestures |
| Host | `apps/launcher` | Owns the camera; dashboard; runs games in an iframe and streams frames to them |
| Games | `games/*` | Static web bundles; only depend on `@trackergame/sdk` |
| Build | `scripts/build.mjs` | Builds everything into one static site in `dist/` + `games/catalog.json` + service worker |
| Preview server | `server/server.mjs` | Optional zero-dependency static server for `dist/` (local preview / fully offline box) |
| Native tracker | `tracker/` (Python, own venv) | Optional: camera → RTMO on OpenVINO → poses over `ws://127.0.0.1:8765`. Run with `npm run tracker` |

## Coordinates

All keypoints are normalised 0..1 in **mirrored** camera space: (0,0) top-left
of the screen, and moving your right hand to your right moves it right on screen.
Keypoints follow the COCO-17 order (`KP` in `types.ts`) so any model can feed
the system. Velocities (`vx`, `vy`) are in normalised units per second
(x as a fraction of frame width, y of frame height).

`screenMapper(aspect, w, h)` maps to pixels fitting the camera's height to the
screen's, preserving body proportions.

## Why an iframe per game

- A broken game can't take down the launcher; going home is just unloading the iframe.
- Games are independent bundles: any framework, publish/remove without rebuilding the launcher.
- The camera is opened once, by the host. Games receive ~30–60 small JSON frames/s via `postMessage`.

## Static site layout

```
dist/
  index.html, debug.html, assets/     launcher
  games/catalog.json                  enabled games' manifests, in display order
  games/<id>/                         each game (its own Vite build, base './')
  sw.js                               generated offline cache
```

All URLs are relative, so `dist/` works at a domain root or under a sub-path.
The service worker precaches everything except rarely-used large files
(full model, non-SIMD wasm), which are cached on first use. Each build gets a
new cache version; the launcher reloads onto it only when nobody is playing.

## Host ↔ game protocol (`bridge.ts`)

Host → game: `init`, `frame`, `tap`, `audioDone`, and `people` (camera cut-outs, only while the game draws them) / `peopleOn` (the G state).
Game → host: `ready`, `exit`, `scores`, `config` (exit gesture, feet, layout, `people: 'overlay' | 'game' | 'off'`), `audio`, and forwarded `pointer`/`key` events (so the simulator keeps working while the iframe has focus).

## Tracking notes

- All tracking runs in the tracker (`tracker/tracker.py`); the browser does none (in-browser MediaPipe was removed: its cost grew with every player and it struggled when kids overlapped). The model gives no IDs; `PlayerTracker` assigns them by nearest-centre matching.
- Tracker: RTMO-s (single pass, constant cost, Apache-2.0) on OpenVINO, feeding the same `PlayerTracker` via `WebSocketSource`. RTMO's input is fixed at 640×640, so a 640×480 frame is letterboxed (no resize). One frame in flight by default: two only helped on an idle GPU.
- PS3 Eye without a kernel driver (Windows): `tracker/ps3eye.py` (libusb) programs the OV534/OV7720 directly. It needs many/large queued bulk reads or the camera's buffer overflows (on WinUSB: 8 × 1 MB).
- Gestures and held poses live in `PlayerTracker.detectGestures`. Thresholds are scaled by body size (shoulder width / torso length) so they work for small kids and adults alike. See docs/SDK.md for the list.

## Gestures used by the system

- **Select** (launcher): raise a hand → body-relative cursor; hold 1.2 s over a tile.
- **Go home** (any game): both hands above the head for 3 s. Games should avoid needing a long two-hands-up hold.

## Ideas / next steps

- Native tracker process (Python + ONNX Runtime) for 4 players.
- Wider-angle 60 fps camera; 3D-printed case for mini PC + camera.
- More games: dodge/jump, whack-a-mole, copy-the-pose, balloon pop, dance.
- Parent settings: play-time limits, per-game visibility schedule.
