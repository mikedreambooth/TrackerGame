# PlayBox (TrackerGame)

A home-made, camera-based motion games console for the living room. One camera,
up to four players, no controllers — your body is the input. Inspired by
Nex Playground, built as a Christmas present.

```
camera ─▶ tracker (tracker/, on the box) ══WebSocket══▶ PlayerTracker (IDs, smoothing, gestures) ─▶ launcher ─▶ game (iframe)
```

**Tracking runs on the box, the games are a static website.** The pose tracker
(`tracker/`, Python) reads the camera and streams poses to the page over a local
WebSocket; the browser does no tracking. The launcher and games build to a folder of
files (`dist/`) that can be hosted anywhere. The box behind the TV runs the tracker and
opens the site in a full-screen browser. A service worker caches the site, so after the
first load it works offline. Camera video never leaves the box.

- **Everything is TypeScript**, except a few zero-dependency Node build scripts (`.mjs` with `// @ts-check`).
- **Games are plain web bundles** (Canvas 2D, PixiJS, three.js — your choice) that talk to the launcher through `@trackergame/sdk`.

## Quick start

```bash
npm install        # also downloads the games' music
npm run tracker    # the pose tracker (first run sets up its Python venv and model)
npm run dev        # launcher with hot reload
```

| URL | What |
| --- | --- |
| http://localhost:5173 | Launcher (poses from the tracker) |
| http://localhost:5173/?input=sim&players=2 | Launcher with **fake players** — no camera needed |
| http://localhost:5173/debug.html | Tracker debug: camera picture, skeletons, IDs, fps, camera orientation |

**Simulator controls:** on-screen **Hands up** (hold), **Jump** and **Moves** (crouch, lean, T-pose, clap, punch, kick, run) buttons appear in sim mode.
- Mouse: player 1's right hand follows the pointer; hold the button for both hands. Keys: `H` hands up, `Space` jump, `1`–`4` toggle players in and out of view, `B` player 1 steps far back, `N` steps right up close.
- Touch screen: first finger drags the right hand, a second finger the left hand.

**In the launcher:** raise a hand above your waist and a cursor appears; hold it over a game for about a second to start it. The cursor follows your own reach: hand at your waist = bottom of the screen, hand stretched up = top, arm out to the side = that edge, so kids reach everything as easily as grown-ups. With several people, **one player picks the game** (the one with the crown, named in the hint; chosen at random to start with). The others' cursors are dimmed. To hand the choice to someone, the chooser and they hold raised hands together for 5 s while a ring fills over the hands. After a game, the winner picks next. If the chooser walks off, it goes to someone else after 4 s. Taps, clicks and keys still work for anyone. Press **F** for faint **footprint guides** under each player (off by default): they flash "Step closer" when someone stands too far back (feet high in the picture), or show "Step back" when their feet are out of shot. When someone leaves and someone else joins, the newcomer takes over the leaver's number and colour (and score, in games). With more games than fit on screen, hold your hand over the big ◀ ▶ arrows to turn the page (or PageUp/PageDown). In a game, **hold both hands above your head for 3 s** to go home (or press `Esc`). Press **G** (on the home screen or in a game) for a see-through camera picture lined up with the tracked players, to check tracking; press again to hide it. It's remembered on that device.

### The camera

The tracker opens the camera itself: `npm run tracker -- --camera auto` (the default) uses a PS3 Eye if one is plugged in, otherwise webcam #0; `--camera 1` picks another webcam. On `/debug.html`, **Mounted** says which way up the camera is: upside down (180°, the default — for a camera hanging under the TV) or the right way up (0°). The tracker turns the picture before tracking (the page tells it on connect; `npm run tracker -- --rotate 0|180` sets its own default, 180). `?rotate=0|180` in the URL overrides the page's setting. Other URL options: `?ws=ws://host:8765` for a tracker elsewhere, `?input=sim` for the simulator, `?smooth=0` to turn off keypoint smoothing (raw tracker positions, for comparing by feel), `?layout=camera|normalised|spread` to override the player layout.

The PS3 Eye works out of the box on Linux (640×480 at 60 fps). Keep the room well lit — it's noisy in the dark.

**PS3 Eye on Windows:** there's no working webcam driver, so the tracker drives the camera itself over USB (libusb). One-time setup: install the generic WinUSB driver for it — run [Zadig](https://zadig.akeo.ie), *Options → List All Devices*, pick **USB Camera-B4.09.24.1**, choose **WinUSB**, *Install Driver* (the "PS3 Eye Universal Driver" installer does the same). Its microphone stops working, and other apps can't use it as a webcam.

## Games

- **Silly Mirror** — everyone becomes a googly-eyed cartoon that reacts to every gesture.
- **Fruit Swipe** — slice flying fruit with fast hands, avoid bombs. 60-second rounds.
- **Sports Day** — running race (run on the spot), high jump and hurdles, with breathers in between, medals, a podium and a spoken commentator.
- **Boxing** — 1–2 players. Players face the TV, their boxers face each other; whoever stands on the left gets the Red corner. Duck (bob), lean (weave), gloves up (block), punch. Solo players fight a computer boxer that telegraphs its punches. 3 rounds or a knock-out.

- **Beat Bash** — 1–4 players. A Beat Saber-style rhythm game for kids: targets launch from the top of the screen and sweep down to land around your body in time with the music, in your own colour, inside your own part of the screen and within reach of your arms — touch them with your hand (Normal: L ones with your left hand, R with your right; Easy: any hand), both hands up for stars, duck under bars. No failing, just combos and stars. Songs are Kevin MacLeod tracks (incompetech.com, CC BY 4.0, downloaded at build time, beat detected automatically) and YouTube videos.
  - **Adding a YouTube song:** open **Editor** from the song screen (or `games/beats/editor.html`), paste the link, play it and tap Space on the beat ~10 times, check with the clicks, Save. Saving is per device — to put a song on the box for good, press **Copy JSON** and add it to `games/beats/public/songs/songs.json`. Some videos don't allow embedding (the editor says so).
  - **Ads:** YouTube may show ads. The game freezes the targets during ads and buffering and resumes with the song; a grown-up can press Skip with a mouse/remote. YouTube Premium on the box's account removes them.
  - **Timing:** if hits feel late or early, change **Timing** on the song screen (camera delay, default 120 ms).

- **Freeze Dance** — 1–4 players. Dance while the music plays, freeze like a statue when it stops. Points for dancing hard and for every perfect statue; wobblers just miss the bonus (nobody is knocked out). 8 freezes per game.
- **Wall Squeeze** — 1–4 players. A brick wall rushes towards you with a body-shaped hole cut where each player stands. Copy the shape (the voice calls it out — star, aeroplane, muscles, frog squat…) to squeeze through. 10 walls.
- **Snowball Fight** — 1–2 players. Crouch to scoop snow, swing an arm to throw, move to dodge. Two players throw at each other; on your own, elves pop up behind a snow wall and throw back. 60 seconds.
- **Jousting** — 1–2 players. Two armoured knights charge from either side of the lists; run on the spot to gallop. When the lances meet, the faster knight knocks the other off their horse (too close to call: both lances shatter). First to 3. Whoever stands on the left rides from the left; on your own you joust the Black Knight, who rides harder each time you score.
- **Piano** — 1–4 players, free play. Two octaves of piano keys across the top of the screen: raise a hand into a key to play it, keep it there to let the note ring, sweep along for a glissando. Stand on the left for low notes, the right for high. **Play songs** plays Twinkle Twinkle, Mary Had a Little Lamb and Ode to Joy back to back: the next note's keys glow (in every octave) and every other key is greyed out and silent; the song waits for each note. The hands-up exit gesture is off here (reaching for the black keys looks the same); hold a hand on Home, low down, or press Esc.
- **Halloween Heads** — 1–4 players. Pumpkins, skulls, ghosts and vampire heads fall from the night sky; line your head up with one and it snaps on and moves with you for 4 seconds, then fades. Catch another while still wearing one and the old head cracks in two and falls off, for bonus points (more for each crack in a row). 60 seconds.
- **Witches' Brew** — 1–4 players, together. A cauldron bubbles in the middle of a witch's cottage and the recipe scroll shows three ingredients. Frogs, eyeballs, bats, toadstools, spiders and crystals float past (the ones the recipe needs glow): grab one with a hand, then throw it at the cauldron or carry it over and drop it in. Right ones splash in for a point, a full recipe makes the potion (bonus for everyone) and the brew changes colour; wrong ones make the cauldron burp. Throws roughly towards the cauldron are helped in. 90 seconds.
- **Archery** — 1–3 players. A 3D archery range running into the screen; each player is a glowing line archer in their own lane, bow and arrows drawn in their colour. Hold your bow hand up in front of you (left/right of your nose aims left/right, higher shoots further), pull your right hand back to your chin to draw — power builds and a dotted arc reaches down range — then drop it sharply (or pull it away) to shoot — the tracker sees wrists, not fingers, so there's no opening the hand. Boards from 10 to 50 m (gold 10, then 8/6/4/3), rising balloons (3) and a sliding golden target (double), with an arrow cam on long shots. 60 seconds. Uses three.js via `@trackergame/sdk/three`; target, balloon and backdrop art by Gemini.
- **Sword Duel** — 1–2 players. Shield in your left hand, sword in your right: your knight copies your arms, side-on in a castle courtyard (whoever stands on the left takes the left side). Raise the shield for high swings, lower it for low ones, or duck under a high slash. Swing your right hand fast to slash high, slash low or thrust — every swing costs stamina. Two players, or one against a computer knight that warns you HIGH / LOW / THRUST before it strikes. 3 rounds or a knock-out.
- **Air Painting** — 1–4 players, free play. Raise a hand to paint, lower it to stop; touch a paint pot for a new colour (rainbow, sparkle and rubber too). "Idea" asks the voice for something to draw. Fingers paint too on a touch screen.

## Making a game

**Game art with Gemini:** `tools/gemini_art.py` generates Pixar-style cartoon art on Vertex AI (`gemini-2.5-flash-image`), cuts it out of its backdrop and saves it to the game's `public/art/`. A game lists its prompts in `art/generate.py` (see Halloween Heads and Witches' Brew); run it with the tracker's Python, e.g. `tracker/.venv/Scripts/python games/brew/art/generate.py`. It uses your gcloud Application Default Credentials and project (`gcloud auth application-default login`) and stores nothing but the images.

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

This installs Chromium and the pose tracker (as a `playbox-tracker` service), opens the site full-screen on login, keeps the screen awake and ignores the laptop lid closing. Run it **without** a URL to build and serve the site on the box itself too (no internet or hosting needed at all).

## The tracker

All tracking runs in the **tracker** (`tracker/`): a Python process that reads the camera, runs [RTMO](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmo) (one pass finds everyone, so 4 players cost the same as 1; Apache-2.0) on the GPU with OpenVINO, and streams poses to the browser over WebSocket.

```bash
npm run tracker            # first run: creates tracker/.venv, installs packages, downloads the model
npm run tracker -- --help  # options: --model rtmo-m (more accurate), --device CPU, --camera 1, --camera test.mp4, --rotate 0|180, --baseline 0.95 (where players' feet are drawn), -v (stats)
```

**Connecting:** the page connects to `ws://127.0.0.1:8765` (or `?ws=`). If the tracker isn't running yet, the page says it's waiting and connects as soon as it starts, and reconnects if it restarts. `?input=sim` uses the simulator instead.

**On the console:** `./deploy/setup-kiosk.sh` installs the tracker as a `playbox-tracker` service, and the kiosk waits for it before opening the browser. On an Intel Core Ultra laptop (Arc iGPU) `rtmo-s` runs at ~37 fps with ~50 ms latency while the browser shares the GPU (CPU only: ~17 fps).

- Needs Python 3.10+. Camera: `--camera auto` uses the PS3 Eye over USB on Windows (WinUSB setup above), otherwise webcam #0 (on Linux the PS3 Eye is a normal webcam).
- It only listens on `127.0.0.1` and only accepts pages from localhost and the published site (`--allow-origin` adds more), so camera images never leave the box. The debug page gets a small preview image to check alignment.
- **Camera overlay (G):** while a page shows it, the tracker also cuts each person out of the picture with Intel's [instance-segmentation-person-0007](https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/intel/instance-segmentation-person-0007) (Apache-2.0, 18 MB, downloaded on first run) on the CPU, up to 12 times a second, leaving the GPU to pose tracking (measured: pose ~24 → ~22.5 fps while it runs). The site draws only the people, see-through, behind the menus (games call `game.drawPeople()`; avatar games turn them off) with cursors on top; on by default. Options: `--segment-fps` (0 = off), `--segment-device`, `--segment-threads`.
- Testing without a camera: `--camera <picture or video file>` plays it (looped) as the camera.
- A hosted HTTPS page can connect to `ws://localhost`, though newer Chrome versions may ask for local-network permission the first time; if that gets in the way, run the site locally on the box too (`setup-kiosk.sh` with no URL).
- Wire format: `packages/sdk/src/sources/websocket.ts`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design notes.
