# Architecture

## Layers

| Layer | Where | Notes |
| --- | --- | --- |
| Camera | USB webcam (PS3 Eye now; wider-angle 60 fps camera later) | ~90° FOV needed for 4 kids side by side |
| Pose model | `InputSource` implementations in `packages/sdk/src/sources` | MediaPipe (browser), WebSocket (native tracker), Sim |
| Player tracking | `PlayerTracker` (`tracker.ts`) | IDs, seats, One Euro smoothing, velocities, gestures |
| Host | `apps/launcher` | Owns the camera; dashboard; runs games in an iframe and streams frames to them |
| Games | `games/*` | Static web bundles; only depend on `@trackergame/sdk` |
| Server | `server/server.mjs` | Serves launcher/games, game catalog, admin API. Zero npm deps |

## Coordinates

All keypoints are normalised 0..1 in **mirrored** camera space: (0,0) top-left
of the screen, and moving your right hand to your right moves it right on screen.
Keypoints follow the COCO-17 order (`KP` in `types.ts`) so any model can feed
the system. Velocities (`vx`, `vy`) are in normalised units per second
(x as a fraction of frame width, y of frame height).

`screenMapper(aspect, w, h)` maps to pixels with "cover" fitting, preserving
body proportions.

## Why an iframe per game

- A broken game can't take down the launcher; going home is just unloading the iframe.
- Games are independent bundles: any framework, publish/remove without rebuilding the launcher.
- The camera is opened once, by the host. Games receive ~30–60 small JSON frames/s via `postMessage`.

## Host ↔ game protocol (`bridge.ts`)

Host → game: `init`, `frame`.
Game → host: `ready`, `exit`, `scores`, and forwarded `pointer`/`key` events (so the simulator keeps working while the iframe has focus).

## Tracking notes

- MediaPipe Pose is two-stage (detector + landmarker per person), so cost grows with players and it struggles when kids overlap. It gives no IDs; `PlayerTracker` assigns them by nearest-centre matching.
- Planned upgrade: native YOLO-pose / RTMO (single pass, constant cost) + the same `PlayerTracker`, via `WebSocketSource`.
- Gestures live in `PlayerTracker.detectGestures`. Thresholds are scaled by body size (shoulder width / torso length) so they work for small kids and adults alike.

## Gestures used by the system

- **Select** (launcher): raise a hand → body-relative cursor; hold 1.2 s over a tile.
- **Go home** (any game): both hands above the head for 3 s. Games should avoid needing a long two-hands-up hold.

## Ideas / next steps

- Native tracker process (Python + ONNX Runtime) for 4 players.
- Wider-angle 60 fps camera; 3D-printed case for mini PC + camera.
- More games: dodge/jump, whack-a-mole, copy-the-pose, balloon pop, dance.
- Parent settings: play-time limits, per-game visibility schedule.
- Hosted `catalog.json` sync so games can be published from anywhere.
