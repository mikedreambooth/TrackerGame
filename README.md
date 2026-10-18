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

**Simulator controls:** on-screen **Hands up** (hold), **Jump** and **Moves** (crouch, lean, T-pose, clap, punch, kick, run) buttons appear in sim mode.
- Mouse: player 1's right hand follows the pointer; hold the button for both hands. Keys: `H` hands up, `Space` jump, `1`–`4` toggle players in and out of view.
- Touch screen: first finger drags the right hand, a second finger the left hand.

**In the launcher:** raise a hand and a cursor appears; hold it over a game for about a second to start it. With more games than fit on screen, hold your hand over the big ◀ ▶ arrows to turn the page (or PageUp/PageDown). In a game, **hold both hands above your head for 3 s** to go home (or press `Esc`).

### Choosing the camera

Open `/debug.html` and pick from the camera menu. The choice is remembered on that device and used by the launcher and every game (`?camera=<id>` in the URL overrides it). The menu also has **Native tracker** (see [below](#upgrading-tracking-for-4-players)). Other URL options: `&model=full` (more accurate, slower), `&input=ws` (native tracker). Put the same options in the kiosk URL on the box.

The PS3 Eye works out of the box on Linux (640×480 at 60 fps). Keep the room well lit — it's noisy in the dark.

**PS3 Eye on Windows:** there's no working webcam driver, so the SDK drives the camera itself over WebUSB (Chrome/Edge). One-time setup: install the generic WinUSB driver for it — run [Zadig](https://zadig.akeo.ie), *Options → List All Devices*, pick **USB Camera-B4.09.24.1**, choose **WinUSB**, *Install Driver* (the "PS3 Eye Universal Driver" installer does the same). Then on `/debug.html` choose **Connect PlayStation Eye (USB)…** and allow it. Its microphone stops working, and other apps can't use it as a webcam.

## Games

- **Silly Mirror** — everyone becomes a googly-eyed cartoon that reacts to every gesture.
- **Fruit Swipe** — slice flying fruit with fast hands, avoid bombs. 60-second rounds.
- **Sports Day** — running race (run on the spot), high jump and hurdles, with breathers in between, medals, a podium and a spoken commentator.
- **Boxing** — 1–2 players. Players face the TV, their boxers face each other; whoever stands on the left gets the Red corner. Duck (bob), lean (weave), gloves up (block), punch. Solo players fight a computer boxer that telegraphs its punches. 3 rounds or a knock-out.

- **Beat Bash** — 1–4 players. A Beat Saber-style rhythm game for kids: targets fly in and land around your body in time with the music — touch red ones with your left hand and blue with your right (Easy: any hand), both hands up for gold stars, duck under purple bars. No failing, just combos and stars. Songs are Kevin MacLeod tracks (incompetech.com, CC BY 4.0, downloaded at build time, beat detected automatically) and YouTube videos.
  - **Adding a YouTube song:** open **Editor** from the song screen (or `games/beats/editor.html`), paste the link, play it and tap Space on the beat ~10 times, check with the clicks, Save. Saving is per device — to put a song on the box for good, press **Copy JSON** and add it to `games/beats/public/songs/songs.json`. Some videos don't allow embedding (the editor says so).
  - **Ads:** YouTube may show ads. The game freezes the targets during ads and buffering and resumes with the song; a grown-up can press Skip with a mouse/remote. YouTube Premium on the box's account removes them.
  - **Timing:** if hits feel late or early, change **Timing** on the song screen (camera delay, default 120 ms).

- **Freeze Dance** — 1–4 players. Dance while the music plays, freeze like a statue when it stops. Points for dancing hard and for every perfect statue; wobblers just miss the bonus (nobody is knocked out). 8 freezes per game.
- **Wall Squeeze** — 1–4 players. A brick wall rushes towards you with a body-shaped hole cut where each player stands. Copy the shape (the voice calls it out — star, aeroplane, muscles, frog squat…) to squeeze through. 10 walls.
- **Snowball Fight** — 1–2 players. Crouch to scoop snow, swing an arm to throw, move to dodge. Two players throw at each other; on your own, elves pop up behind a snow wall and throw back. 60 seconds.
- **Jousting** — 1–2 players. Two armoured knights charge from either side of the lists; run on the spot to gallop. When the lances meet, the faster knight knocks the other off their horse (too close to call: both lances shatter). First to 3. Whoever stands on the left rides from the left; on your own you joust the Black Knight, who rides harder each time you score.
- **Air Painting** — 1–4 players, free play. Raise a hand to paint, lower it to stop; touch a paint pot for a new colour (rainbow, sparkle and rubber too). "Idea" asks the voice for something to draw. Fingers paint too on a touch screen.

## Making a game

Copy `games/mirror` (free play) or `games/slice` (round-based) and rename. A game is:

```
games/my-game/
  manifest.json     { "id": "my-game", "title": "My Game", "players": {"min":1,"max":4}, "icon": "icon.svg" }
  index.html
  public/icon.svg   tile artwork (4:3)
  src/main.ts
```

Develop it on its own with full hot reload: `npm run dev -w games/my-game` (add `?input=sim` to fake players). To see it inside the launcher, run `npm run build:games my-game` and refresh.

The SDK gives games tracked players, 10 gestures (jump, hands up, crouch, lean, T-pose, clap, punch, kick, run effort…), a ready-made lobby → countdown → play → results flow, hand-controlled buttons, auto-pause, a shared look, sound effects, text-to-speech and asset loading. **Full reference: [docs/SDK.md](docs/SDK.md).**

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

MediaPipe in the browser is fine for 1–2 players, but its cost grows with every player. For 4, run the **native tracker** (`tracker/`): a Python process that reads the camera, runs [RTMO](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmo) (one pass finds everyone, Apache-2.0) on the GPU with OpenVINO, and streams poses to the browser over WebSocket. Games don't change.

```bash
npm run tracker            # first run: creates tracker/.venv, installs packages, downloads the model
npm run tracker -- --help  # options: --model rtmo-m (more accurate), --device CPU, --camera 1, -v (stats)
```

**Which tracker is used** (unless `?input=` or the debug page's menu says otherwise): a page served from the machine itself (the console in local mode, or `npm run dev`) uses the native tracker when it's running, and MediaPipe otherwise. The hosted site always uses MediaPipe and never probes `localhost`, so visitors get no permission prompt. To force it, pick **Native tracker** on `/debug.html` or add `?input=ws`; the browser then waits for the tracker if it isn't up yet, and reconnects if it restarts.

**On the console:** `./deploy/setup-kiosk.sh` (local mode, no URL) also installs the tracker as a `playbox-tracker` service, and the kiosk waits for it before opening the browser. `NO_TRACKER=1 ./deploy/setup-kiosk.sh` skips it — worth comparing on an old laptop, where in-browser MediaPipe on its GPU may be faster than the tracker on its CPU. The tracker opens the camera itself, so the browser doesn't — close any tab using the PS3 Eye first. On an Intel Core Ultra laptop (Arc iGPU) `rtmo-s` runs at ~37 fps with ~50 ms latency while the browser shares the GPU (CPU only: ~17 fps).

- Needs Python 3.10+. Camera: `--camera auto` uses the PS3 Eye over USB on Windows (same WinUSB setup as above), otherwise webcam #0 (on Linux the PS3 Eye is a normal webcam).
- It only listens on `127.0.0.1` and only accepts pages from localhost and the published site (`--allow-origin` adds more), so camera images never leave the box. The debug page gets a small preview image to check alignment.
- A hosted HTTPS page can connect to `ws://localhost`, though newer Chrome versions may ask for local-network permission the first time; if that gets in the way, run the site locally on the box too (`setup-kiosk.sh` with no URL).
- Wire format: `packages/sdk/src/sources/websocket.ts`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design notes.
