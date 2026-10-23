# Architecture

## Layers

| Layer | Where | Notes |
| --- | --- | --- |
| Camera | USB webcam (PS3 Eye now; wider-angle 60 fps camera later) | ~90° FOV needed for 4 kids side by side |
| Pose model | the tracker (`tracker/`, Python: camera → RTMO on OpenVINO), streamed by `packages/sdk/src/sources/websocket.ts` | the simulator (`sources/sim.ts`) for testing |
| Player tracking | the tracker (`tracker/players.py`); in the browser `PoseTracker` (`tracker.ts`) for the simulator | IDs, One Euro smoothing, velocities, body measures, gestures, jump state, hand cursors |
| Seats | `PlayerTracker` (`tracker.ts`), in the browser | Slots and colours from the tracker's ids (left to right on the home screen) |
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

- All tracking runs in the tracker (`tracker/tracker.py`); the browser does none (in-browser MediaPipe was removed: its cost grew with every player and it struggled when kids overlapped). The model gives no IDs; `tracker/players.py` assigns them by nearest-centre matching.
- **The split.** The tracker is the source of truth with a camera: person tracking with stable ids (confirm frames, leave timeout, a leaver's id goes to the next joiner), One Euro smoothing, body measures (shoulders, torso, arm length, standing height), all gestures and held poses, jump state (airborne / land), motion (velocity, dx, drift), facing, distance (far/ok/close) and the hand cursor. It sends each player ready-made (protocol v2, documented at the top of `tracker.py` and in `protocol.ts`), ~0.2 ms of Python per frame. The browser keeps only per-screen choices: seats and colours (`PlayerTracker.fromServer`, including left-to-right numbering on the home screen and a leaver's slot going to the next joiner), the layout, the chooser and drawing.
- **The simulator has no tracker**, so the SDK's `PoseTracker` is its stand-in: a line-by-line twin of `players.py` that turns raw poses into the same v2 frames, which then go through the same `fromServer`. An older tracker that only sends raw poses (protocol v1) is handled the same way. `tracker/tests/` keeps the twins in agreement: `make_fixtures.py` writes scripted pose sequences with expected events and fields; `test_players.py` (Python) and `test-players.mjs` (TS, also comparing every frame with Python's output) check them. Change one twin, change the other, re-run both.
- Mirroring happens in the tracker (`players.py`, `x → 1 − x`) for v2; raw v1 poses, previews and cut-outs stay in camera space (cut-outs carry their player's id).
- Tracker: RTMO-s (single pass, constant cost, Apache-2.0) on OpenVINO, then `players.py`, streamed by `WebSocketSource`. RTMO's input is fixed at 640×640, so a 640×480 frame is letterboxed (no resize). One frame in flight by default: two only helped on an idle GPU.
- PS3 Eye without a kernel driver (Windows): `tracker/ps3eye.py` (libusb) programs the OV534/OV7720 directly. It needs many/large queued bulk reads or the camera's buffer overflows (on WinUSB: 8 × 1 MB).
- Gestures and held poses live in `players.py` (`_detect`) and its twin `PoseTracker.detect`. Thresholds are scaled by body size (shoulder width / torso length) so they work for small kids and adults alike. See docs/SDK.md for the list.

## Gestures used by the system

- **Select** (launcher): raise a hand → body-relative cursor; hold 1.2 s over a tile.
- **Go home** (any game): both hands above the head for 3 s. Games should avoid needing a long two-hands-up hold.

## Ideas / next steps

- Native tracker process (Python + ONNX Runtime) for 4 players.
- Wider-angle 60 fps camera; 3D-printed case for mini PC + camera.
- More games: dodge/jump, whack-a-mole, copy-the-pose, balloon pop, dance.
- Parent settings: play-time limits, per-game visibility schedule.
