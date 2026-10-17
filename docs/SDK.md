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

| `GameClient` | |
| --- | --- |
| `frame` | Latest tracking frame (see below). Read it from your render loop. |
| `paused` | True while auto-paused. Freeze timers, spawning and physics. |
| `on(type, cb)` | Events: all gestures below, plus `pause` and `resume`. |
| `onFrame(cb)` | Every tracking frame (camera rate, ~30–60/s). |
| `reportScores({ slot: points })` | Tell the launcher the final scores. |
| `setExitGesture(enabled)` | Change the exit-gesture setting while running. |
| `exit()` | Back to the launcher. |
| `embedded` | True inside the launcher, false when developing the game on its own. |

## Players — `game.frame.players`

Up to 4, each:

| Field | |
| --- | --- |
| `id` | Stable while this person stays in view. |
| `slot` 0–3, `color` | Their seat and colour. Use `playerName(slot)` → "Red", "Blue", "Yellow", "Green". |
| `keypoints[17]` | Index with `KP.nose`, `KP.leftWrist`, `KP.rightAnkle`… Each has `x`, `y` (0–1, mirrored), `vx`, `vy` (per second), `score` (confidence). |
| `center`, `bbox`, `shoulderWidth` | Position and size. Scale your thresholds by `shoulderWidth` so they work for kids and adults, near or far. |
| `pose` | What they're holding right now (see below). |

`game.frame.aspect` is the camera's width/height. Use `screenMapper(aspect, w, h).map(point)`
to convert a keypoint to canvas pixels.

## Gestures

**Events** — `game.on(type, e => …)`, every event has `playerId` and `slot`:

| Event | Extra | Fires when |
| --- | --- | --- |
| `join` / `leave` | | Someone steps in / out of view. |
| `jump` | | Body moves up quickly. |
| `handsUp` | | Both hands go above the head. |
| `crouch` | | They squat down. |
| `lean` | `direction: 'left' \| 'right'` | Torso tilts past ~15°. |
| `armsOut` | | Both arms out to the sides (T-pose). |
| `clap` | | Hands come together quickly in front. |
| `punch` | `hand` | An arm shoots out at shoulder height. Side-on/diagonal punches read best; straight at the camera barely changes in 2D. |
| `kick` | `foot` | A foot is raised quickly. |
| `pause` / `resume` | | Auto-pause (see options). |

**Held poses** — `player.pose`, read every frame:

| Field | |
| --- | --- |
| `handsUp`, `crouching`, `armsOut` | booleans |
| `lean` | `-1` left, `0` upright, `1` right |
| `run` | Running-on-the-spot effort: ~0 still, ~3–4 jogging, 8+ sprinting. |

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
- `say(text, { interrupt, rate, pitch, volume, lang })` — text-to-speech with the
  browser's built-in voices; resolves when finished. `stopSpeaking()`, `speechAvailable()`.
  On the Linux box `setup-kiosk.sh` installs `speech-dispatcher` + `espeak-ng` so
  Chromium has a voice. (A more natural offline voice, e.g. Piper, could slot in behind `say()` later.)

## Assets

```ts
const assets = await loadAssets(
  { images: { hero: 'img/hero.png' }, sounds: { pop: 'sfx/pop.mp3' } },
  (done, total) => drawLoading(done / total),
);
ctx.drawImage(assets.images.hero, x, y);
const stopMusic = assets.play('music', { loop: true, volume: 0.4 });
```

Put files in the game's `public/` folder (paths relative to the game), or `import url from './pop.mp3'`.
They're cached for offline play like everything else.

## Testing without a camera

`npm run dev -w games/<id>` then open with `?input=sim&players=2`. On-screen buttons and keys:
Hands up (H), Jump (Space), and under **Moves**: Crouch (C), Lean (← →), T-pose (T), Clap (X),
Punch (P), Kick (K), Run (R). Mouse/finger moves the right hand; a second finger the left.
