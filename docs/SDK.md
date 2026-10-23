# Game SDK reference (`@trackergame/sdk`)

Everything a game needs: tracked players, gestures, a ready-made round flow,
hand-controlled buttons, a shared look, sound, speech and assets.

```ts
import { createGame, RoundFlow, KP, say } from '@trackergame/sdk';

const game = await createGame();
const flow = new RoundFlow(game, { title: 'My Game', seconds: 60 });

function loop(now: number) {
  flow.update(now);
  if (flow.playing) {
    for (const p of game.frame.players) {
      const hand = p.keypoints[KP.rightWrist];
      // ...game logic, flow.addScore(p.slot)
    }
  }
  // ...draw world, then:
  flow.drawOverlay(ctx, w, h);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

Look at `games/slice` (round-based game in ~350 lines), `games/mirror` (free play,
reacts to every gesture) and `games/sports` (multi-event day with speech).

---

## `createGame(options?)` → `GameClient`

| Option | Default | |
| --- | --- | --- |
| `autoPause` | `true` | Pause when everyone leaves the camera view, resume when someone returns. |
| `pauseAfterMs` | `2000` | How long the room must be empty before pausing. |
| `exitGesture` | `true` | Allow "both hands up for 3 s → go home". Turn off if your game needs long arms-up poses (Esc still works). |
| `feet` | `true` | Allow the footprint guides under each player (see below; they're off unless the viewer turns them on with F). |
| `layout` | `'spread'` | How players are placed on screen — see "Player layout" below. |
| `baseline` | tracker's | Where players' feet are drawn (fraction of the screen height from the top). Default: the tracker's `--baseline` (0.95). See "Baseline" below. |
| `normalise` | `true` | Draw every player the same height on screen. `false`: their real relative sizes (a child stays smaller than an adult). |
| `playerHeight` | `0.62` | Standing height when normalised, as a fraction of the screen height. |
| `people` | `'overlay'` | The camera cut-outs (see "Camera overlay"): `'overlay'` (the launcher draws them over everything until the game calls `drawPeople()`), `'game'` (the game draws them from the start) or `false` / `'off'` (none: avatar games). |

| `GameClient` | |
| --- | --- |
| `frame` | Latest tracking frame (see below). Read it from your render loop. |
| `paused` | True while auto-paused. Freeze timers, spawning and physics. |
| `on(type, cb)` | Events: all gestures below, plus `pause` and `resume`. |
| `onFrame(cb)` | Every tracking frame (camera rate, ~30–60/s). |
| `reportScores({ slot: points })` | Tell the launcher the final scores. |
| `setExitGesture(enabled)` | Change the exit-gesture setting while running. |
| `setFeet(on)` | Show/hide the footprint guides while running. |
| `setLayout(layout)` | Change the player layout while running. |
| `setBaseline(y, slot?)` | Move where players' feet go: everyone, or one player slot. `null` = back to the default. |
| `setNormalise(on, height?)` | Same height for everyone (optionally at `height`), or real relative sizes. |
| `drawPeople(ctx, w, h, opts?)` | Draw the camera cut-outs onto your canvas (see "Camera overlay"). Call every frame after your background/world, before text, HUD, menus and cursors. |
| `peopleVisible` | True while `drawPeople()` would draw (people not off and G on). |
| `setPeople(mode)` | `'game'`, `'overlay'` or `'off'` while running. |
| `segmentation()` | The latest fresh people cut-outs (`Segmentation`), for games that draw people their own way (e.g. on 3D cards, as Block Dash does) instead of with `drawPeople()`. Each `Cutout` is un-mirrored camera space; match it to a player by `player` (their id, when the tracker provides it) or by `anchor`. Needs `people: 'game'` (the launcher forwards cut-outs but doesn't draw them) and G on; `null` otherwise or without segmentation. |
| `setTouchPassthrough(on)` | In simulator mode, let taps/clicks reach the game page itself (e.g. a YouTube video's Skip button) instead of moving the simulated hands. |
| `exit()` | Back to the launcher. |
| `embedded` | True inside the launcher, false when developing the game on its own. |

## Players — `game.frame.players`

Up to 4, each:

| Field | |
| --- | --- |
| `id` | Stable while this person stays in view, never shared by two people at once. When someone leaves, the next person to join takes over their `id` and `slot` (lowest free reserved slot first), so per-player state keyed by either carries on: same colour, same score. A brand-new id is made only when nobody's place is waiting. `leave`/`join` events still fire, so reset anything personal (calibration) on `join`. |
| `slot` 0–3, `color` | Their seat and colour. Use `playerName(slot)` → "Red", "Blue", "Yellow", "Green". |
| `keypoints[17]` | Index with `KP.nose`, `KP.leftWrist`, `KP.rightAnkle`… Each has `x`, `y` (0–1, mirrored), `vx`, `vy` (per second), `score` (confidence), and rough depth `z`/`vz` (smaller/negative = towards the camera; 0 when the model has no depth). |
| `center`, `bbox`, `shoulderWidth` | Position and size. Scale your thresholds by `shoulderWidth` so they work for kids and adults, near or far. |
| `armLength` | Estimated shoulder→elbow→wrist length in camera-**height** units (x distances × `frame.aspect`; divide by the aspect for a sideways distance in x units). The longest seen recently, relative to the torso so it stays right as people move nearer or further; slowly forgotten (30 s), clamped to 0.95–1.4 torso lengths, 1.1 until an arm has been seen straight. |
| `cursor` | Where they point, in screen fractions, or `null` — see `handCursor` below. |
| `pose` | What they're holding right now (see below). |
| `cursorHand` | `'left'` / `'right'`: which hand is pointing (`cursor`), or `null`. |
| `jump` | `{ airborne, height, rise, airTime, peak }`: in the air from take-off (`jump` event) until back down (`land`); `height` is how high right now and `peak` the highest point of this jump (or the last one, once landed), in torso lengths (~0.3 a hop, 1+ a big jump); `rise` the same in camera-height fractions; `airTime` seconds since take-off. Measured from the body centre's standing height (which follows them slowly while on the ground). |
| `motion` | `{ vx, vy, dx, speed, drift }`: body-centre velocity (normalised units/s), `dx` the horizontal move since the last frame (+ = screen-right), `speed` in torso lengths/s (means the same near or far), `drift: { x, y }` how far they are from where they usually stand, in torso lengths ("home" follows them over ~4 s, so a dodge reads clearly, then fades if they stay). Camera space. |
| `facing` | `'front'`, `'side'` (shoulders narrow for their torso) or `'back'` (no face seen). Changes after 4 frames in a row. |
| `distance` | `'far'` (feet high in the picture: step closer), `'ok'` or `'close'` (feet out of the bottom: step back), using `FEET` thresholds with hysteresis; held while airborne. |
| `torso`, `height` | Torso length (aspect-corrected) and estimated standing height, both in camera-height fractions. |
| `confidence` | Mean keypoint confidence this frame, 0..1. |
| `raw`, `transform` | Where the camera really sees them (`keypoints`, `center`, `bbox`, `shoulderWidth`, `armLength`) before the layout moved them, and the layout's `{ scale, x, y }` (laid-out = raw × scale + (x, y)). |

`game.frame.aspect` is the camera's width/height. Use `screenMapper(aspect, w, h).map(point)`
to convert a keypoint to canvas pixels. By default the camera's full height fits the screen's,
so heads and feet are never cut off (pass `'cover'` or `'contain'` as a 4th argument to change that).

`slot` (and so colour) is fixed for the whole game. On the launcher's home screen players
are numbered left to right as they stand, so P1 is whoever is on the left when the game starts.

## Gestures

**Events** — `game.on(type, e => …)`, every event has `playerId` and `slot`:

| Event | Extra | Fires when |
| --- | --- | --- |
| `join` / `leave` | | Someone steps in / out of view. |
| `jump` | | Take-off: the body centre rises fast (not just after standing up from a crouch). |
| `land` | `airTime` (s), `height` (peak, torso lengths) | Back down after a jump. |
| `handsUp` | | Both hands go above the head. |
| `crouch` | | They squat down. |
| `lean` | `direction: 'left' \| 'right'` | Torso tilts past ~15°. |
| `armsOut` | | Both arms out to the sides (T-pose). |
| `clap` | | Hands come together quickly at chest height (not up by the face — that's a boxing guard). |
| `punch` | `hand`, `speed` (shoulder widths/s) | An arm shoots out at shoulder height — sideways, diagonally, or straight at the camera (detected from depth when the model provides it, as MediaPipe does). |
| `kick` | `foot` | A foot is raised quickly. |
| `pause` / `resume` | | Auto-pause (see options). |

**Held poses** — `player.pose`, read every frame:

| Field | |
| --- | --- |
| `handsUp`, `crouching`, `armsOut` | booleans |
| `lean` | `-1` left, `0` upright, `1` right |
| `run` | Running-on-the-spot effort: ~0 still, ~3–4 jogging, 8+ sprinting. |
| `crouchDepth` | 0 standing … 1 deep squat (`crouching` from ~0.5). |
| `leanAngle` | Torso tilt in radians, + = to screen-right (`lean` flips past ±0.26, back to 0 under 0.17). |
| `handsTogether` | Wrists within half a shoulder width (praying, holding a bat). |
| `balance` | Standing on one foot: `'left'` / `'right'` = the raised foot, or `null`. |

**Where this comes from.** With a camera, the tracker (`tracker/players.py`) does all of it — ids,
One Euro smoothing, body measures, gestures, jump state, hand cursors — and sends each player
ready-made (protocol v2, see `ServerFrame` in `protocol.ts`). The browser only seats players (`slot`,
`color`; the home screen numbers them left to right) and lays them out. In the simulator (and with
an older tracker that only sends raw poses) the SDK's `PoseTracker` (`tracker.ts`) does the same
work in the browser, with the same rules and numbers: `tracker/tests/` runs shared fixtures through
both and checks they agree. The new fields (`jump`, `motion`, `facing`, …) are optional in the types
for players built by hand, but both sources always fill them.

`PlayerTracker` is the browser end: `update(poses, t, aspect)` tracks raw poses here,
`fromServer(serverFrame, t)` takes the tracker's players; `trackSource(source, tracker, cb)` wires
an `InputSource` to whichever it sends. Tuning: `JUMP` (`tracker.ts`) and `JUMP`, `FACING`, `FEET`,
`CURSOR` at the top of `tracker/players.py` (keep the two in step and re-run the tests).

Left/right are the player's own sides, which — because the view is mirrored — are also screen left/right.

## `RoundFlow` — lobby → countdown → play → results

```ts
const flow = new RoundFlow(game, { title: 'Fruit Swipe', seconds: 60 });
flow.on('start', resetWorld);
flow.on('end', () => {});
```

| | |
| --- | --- |
| Options | `title`, `subtitle` ("Raise both hands to start!"), `seconds` (60; `0` = untimed, call `flow.end()`), `countdown` (3), `resultsMinMs` (2500). |
| `update(now)` / `drawOverlay(ctx, w, h)` | Call every frame; draw the overlay after your world. |
| `playing` | True only while playing and not paused — gate all game logic on it. |
| `addScore(slot, points)` | Negative points allowed; never drops below 0. |
| `scores`, `state`, `elapsed`, `remaining` | |
| `start()`, `end()` | Start a round / finish early. |

Start: both hands up, or hold a hand on the **Start** button. Results: **Play again** /
**Home** buttons, or both hands up. Scores are reported to the launcher automatically.

## `DwellMenu` — buttons you press by holding a hand over them

By default the cursor is body-relative (`handCursor(player)`), so every corner is reachable without walking:

- Only a hand raised above that player's hips (by 0.15 torso lengths; it lets go back at hip height) gives a cursor.
- Up/down: from just above the hips (bottom of the screen) to the shoulders minus 0.9 × arm length (top, about a hand straight up).
- Sideways: centred on their own shoulders, spanning how far their arm reaches sideways at that height (0.9 × the arm's reach on its circle round the shoulder, at least 0.55 × arm length, plus half the shoulders). A small child and a tall adult reach every corner the same way.
- Worked out in the tracker from that player's own keypoints only, lightly smoothed. It keeps the same hand until the other one is 0.3 torso lengths higher. Wrists that look like someone else's are ignored: more than 1.5 arm lengths from the shoulders, or 0.6× nearer another player's shoulders than their own. A dropout under 250 ms keeps the cursor. Thresholds live in `CURSOR` (`cursor.ts`).

 Pass your own as the third argument — e.g. the hand's real screen position, as Air Painting does: `new DwellMenu(buttons, 1300, (p) => ({ x, y }))`.

Buttons can also be tapped or clicked (phone, tablet, a mouse on the box) — including in simulator mode, where a quick tap presses a button and a drag moves the pretend hand.

```ts
const menu = new DwellMenu([
  { id: 'easy', label: 'Easy', x: 0.35, y: 0.6, w: 0.22, h: 0.14 },
  { id: 'hard', label: 'Hard', x: 0.65, y: 0.6, w: 0.22, h: 0.14, color: '#e63946' },
]);
// every frame:
const picked = menu.update(game.frame.players, now); // id once, after ~1.2 s hold
menu.draw(ctx, w, h);
```

Positions are fractions of the screen (`x`, `y` = centre). Every player's raised hand
gets a cursor with a fill-up ring.

## Look & feel — `ui`

`theme`, `drawText(ctx, text, x, y, size, color?, { align, stroke })`, `drawTitle`,
`drawCountdown`, `drawTimerBar`, `drawScoreChips`, `drawResults`, `drawPaused`,
`playerColor(slot)`, `playerName(slot)`. Also `fitCanvas` (sharp canvas at any size),
`drawSkeleton`, `handCursor`.

## Sound & speech

- `blip(freq, ms, type, volume, slideTo?)`, `noise(ms, volume)` — synth effects, no files.
- `say(text, { interrupt, rate, pitch, volume, lang })` — text-to-speech; resolves when finished.
  Lines queue in order unless `interrupt: true`. `stopSpeaking()`, `speechAvailable()`.
- `prepareSpeech(lines)` — synthesize lines ahead of time so they play instantly (do this for
  fixed commentary like "On your marks", "Get set", "Go!").

**Voices.** The launcher downloads a natural-sounding neural voice ([Piper](https://github.com/rhasspy/piper),
`en_GB-jenny_dioco-medium`, ~60 MB) once in the background, keeps it on the device and runs it in a
worker. Until it's ready — or if it can't load — `say()` uses the browser's built-in voice (on the
Linux box: `speech-dispatcher` + `espeak-ng`, installed by `setup-kiosk.sh`). Add `?voice=browser` to
the launcher URL to keep the built-in voice, or `?voice=en_GB-cori-medium` (any Piper voice id) to
pick another. The debug page shows the voice status and has a **Test voice** button.

**How audio plays:** inside the launcher, a game's sounds and speech are played by the
launcher (games send it commands), because browsers like iOS Safari only allow audio after a
touch in the same frame — and touches go to the launcher. The first tap/click/key unlocks audio,
and on iOS 17+ the page is marked as media playback so the silent switch doesn't mute it. Game
code doesn't change: `blip`, `noise`, `say` and `assets.play` route automatically.

## Assets

```ts
const assets = await loadAssets(
  { images: { hero: 'img/hero.png' }, sounds: { pop: 'sfx/pop.mp3' } },
  (done, total) => drawLoading(done / total),
);
ctx.drawImage(assets.images.hero, x, y);
const stopMusic = assets.play('music', { loop: true, volume: 0.4 });
```

For music that game events must stay in time with, use `playMusic`: it resolves `started` with the
`performance.now()` time the audio actually began (after the launcher's audio relay), so
`songTime = offset + (now - startedAt) / 1000`.

```ts
const m = playMusic('music/song.mp3', { offset: 12 }); // start 12 s in
const startedAt = await m.started;
m.stop();
```

Put files in the game's `public/` folder (paths relative to the game), or `import url from './pop.mp3'`.
They're cached for offline play like everything else.

## Testing without a camera

`npm run dev -w games/<id>` then open with `?input=sim&players=2`. On-screen buttons and keys:
Hands up (H), Jump (Space), and under **Moves**: Crouch (C), Lean (← →), T-pose (T), Clap (X),
Punch (P), Kick (K), Run (R), Guard (G), Jab at the camera (J), Far (B: player 1 steps far back),
Close (N: steps right up to the camera). Mouse/finger moves the right hand; a second finger the left.

## Player layout

The player positions games get are laid out, not raw: each player is scaled and moved as a whole
(uniform scale + shift, so gestures and shapes don't change) by a `PlayerLayout` after the
tracker. Pick one with `createGame({ layout })` or `game.setLayout()`; `?layout=<mode>` in the URL
overrides it (launcher or standalone game) for testing.

| Layout | |
| --- | --- |
| `'spread'` (default) | Everyone the same standing height with their feet on the baseline (below), each in an equal lane of the whole screen, left to right as they stand (order changes only when people clearly swap places). Where someone stands across the room maps into their lane, so moving sideways still moves them (alone: across the whole screen). Never overlap; lanes glide when someone joins or leaves. |
| `'normalised'` | Same height and baseline, but each stays where the camera sees them left to right. |
| `'free'` (or `'camera'`) | Each player's actual position and size, as the camera sees them: for games where players roam the whole picture (baseline and `normalise` don't apply). The debug page uses it. |
| `{ mode: 'custom', slots: [{ x, baseline?, height? }, …] }` | A place per slot in screen fractions (e.g. facing sides for a duel); slots without one are spread over the rest. |

Height comes from the torso (grows quickly, shrinks slowly, so bending or crouching doesn't
shrink anyone); a player's own floor follows their feet down quickly and up slowly, so jumps
still show.
Gestures, `cursor` and the "Step closer" warning work on the real (camera) positions, so they
behave the same in every layout. Use `player.raw` for anything about the real room. Tuning:
`LAYOUT` (`layout.ts`).

### Baseline

The **baseline** is the line players' feet are drawn on by default, as a fraction of the screen
height from the top, padded up a little from the bottom edge. The tracker sets the default
(`npm run tracker -- --baseline 0.95`, announced to the page on connect); without a tracker
(simulator) it's `LAYOUT.baseline` (0.95). A game can override it for everyone
(`createGame({ baseline })`, `game.setBaseline(y)`) or per player (`game.setBaseline(y, slot)`);
the most specific wins (per player > game-wide > layout's own > default), and `null` goes back.
`game.frame.baseline` is the current line, so you can draw your ground there and players stand
on it. Every new game starts on the default again.

### Same height for everyone

`normalise` (default on) draws every player the same height (`playerHeight`, 0.62 of the
screen), so small children and tall adults match. Turn it off (`createGame({ normalise: false })`,
`game.setNormalise(false)`) to keep their real relative sizes; they still stand on the baseline
in their lanes. `game.setNormalise(true, 0.5)` changes the height. The camera layout ignores both.

## Camera overlay

The players cut out of the camera picture (room removed), drawn see-through (55%) over the
page with a soft glow in each player's colour, mirrored and laid out with them, so they can see
themselves in the game. On by default; **G** toggles it (remembered on the device). The cut-outs
come from the tracker (person segmentation, ~8–12 per second, only while a page shows them),
and between them each picture moves with its player's torso so it doesn't lag. Sources without
segmentation (the simulator) show nothing. It lines up with games that draw players with
`screenMapper`'s default; games that draw their own avatars won't match it.

**Behind the UI.** Games draw the people themselves, so they sit behind titles, menus and
HUD while cursors stay on top:

```ts
const game = await createGame();
function loop() {
  drawBackground();
  game.drawPeople(ctx, W, H);   // after the world, before text/menus (pass { fit } if you don't use screenMapper's default)
  drawWorldAndPlayers();
  flow.drawOverlay(ctx, W, H);  // titles, buttons, then cursors last
}
```

The first `drawPeople()` call tells the launcher (bridge config `people: 'game'`) to stop
drawing its on-top overlay; it then sends the game each new set of cut-outs (copied
`ImageBitmap`s, transferred) and the G state. Games that never call it keep the old on-top
overlay. Avatar games turn people off with `createGame({ people: false })`. `opts`:
`opacity` (0.55), `glow` (true), `fit`. On the home screen the launcher draws the people and
faint skeletons on a canvas behind the game tiles; cursors, P1/P2 labels and the chooser's
crown stay on the overlay above. The footprint guides still draw over everything.
Code: `drawPeople()` and `CameraGhost` (`ghost.ts`, shared by the launcher, standalone games and
`game.drawPeople()`), `InputSource.segmentation()`.

## Footprint guides

The launcher (and `createGame` when a game runs on its own) draws faint footprint outlines in
each player's colour under their ankles, placed the way `screenMapper`'s default places (laid-out)
players, so they line up with the G camera overlay. When someone stands too far back (judged on
where the camera really sees them), so their lower foot
stays above 78% of the picture's height for 1.2 s (clears below 81%), the footprints flash with a
bouncing arrow and "Step closer". With the camera at TV height that's roughly 3.5 m away: small on
screen, and raised hands barely reach the top of the menus. When the hips are in view but the
ankles aren't (or sit at the very bottom edge), "Step back" shows instead. They're **off by
default**: **F** toggles them (remembered on the device), `?feet=1` / `?feet=0` force them on /
off, and games can opt out with
`createGame({ feet: false })` / `game.setFeet(false)`. Thresholds live in `FEET` (`feet.ts`).
