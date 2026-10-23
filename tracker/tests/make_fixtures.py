"""Writes the shared player-tracking fixtures (tracker/tests/fixtures/*.json).

Each fixture is a scripted sequence of raw poses (what the pose model would report: COCO-17,
UN-mirrored camera space, with scores) and what tracking must make of it (wire v2 packets):
  "events": these must happen, in this order (fields given must match; others may come between)
  "none":   events that must not happen (a type, or fields to match)
  "checks": at the first frame at or after "t": player "id"'s field "path" (dots; numbers index
            arrays) is "eq" / "gt" / "lt" a value; or "count" players. Both implementations run them:
    tracker/.venv/Scripts/python tracker/tests/test_players.py   (tracker/players.py)
    node tracker/tests/test-players.mjs                           (the SDK's PoseTracker)
and the SDK test also compares its output frame by frame with the Python one.

Run: python tracker/tests/make_fixtures.py  (no dependencies)
"""

from __future__ import annotations

import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fixtures"
ASPECT = 4 / 3
DT = 33  # ms per frame (~30 fps)
T0 = 1000

# A standing person, in body units (1 ~ standing height), x to the player's/screen's right
# (mirrored view), y down, origin at the hips. Like the simulator's template.
TEMPLATE = [
    (0, -0.42),  # nose
    (-0.03, -0.45),  # left eye
    (0.03, -0.45),  # right eye
    (-0.06, -0.43),  # left ear
    (0.06, -0.43),  # right ear
    (-0.13, -0.28),  # left shoulder
    (0.13, -0.28),  # right shoulder
    (-0.18, -0.1),  # left elbow
    (0.18, -0.1),  # right elbow
    (-0.2, 0.06),  # left wrist
    (0.2, 0.06),  # right wrist
    (-0.09, 0.05),  # left hip
    (0.09, 0.05),  # right hip
    (-0.1, 0.3),  # left knee
    (0.1, 0.3),  # right knee
    (-0.1, 0.55),  # left ankle
    (0.1, 0.55),  # right ankle
]


def lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * max(0.0, min(1.0, u))


def ramp(t: float, start: float, ms: float) -> float:
    """0 before start, rising to 1 over ms."""
    return max(0.0, min(1.0, (t - start) / ms))


class Body:
    """One person: position (screen x of the hips, y of the feet), size, and a pose."""

    def __init__(self, x: float = 0.5, feet: float = 0.92, height: float = 0.7):
        self.x, self.feet, self.height = x, feet, height
        self.pts = [list(p) for p in TEMPLATE]
        self.scores = [0.9] * 17
        self.lift = 0.0  # whole body up (camera fraction), for jumps

    def set(self, i: int, x: float, y: float) -> None:
        self.pts[i] = [x, y]

    def raw(self) -> list:
        H = self.height
        oy = self.feet - 0.55 * H - self.lift
        out = []
        for (px, py), s in zip(self.pts, self.scores):
            sx = self.x + px * H / ASPECT
            sy = oy + py * H
            if sy > 1 or sy < 0:
                s = 0.05  # out of the picture
            out.append([round(1 - sx, 3), round(sy, 3), round(s, 2)])  # un-mirror
        return out


def crouch(b: Body, amt: float) -> None:
    drop = 0.25 * amt
    for j in range(13):
        b.pts[j][1] += drop
    b.pts[13] = [b.pts[13][0] - 0.08 * amt, b.pts[13][1] + drop * 0.4]
    b.pts[14] = [b.pts[14][0] + 0.08 * amt, b.pts[14][1] + drop * 0.4]


def lean(b: Body, angle: float) -> None:
    hx = (b.pts[11][0] + b.pts[12][0]) / 2
    hy = (b.pts[11][1] + b.pts[12][1]) / 2
    for j in range(11):
        dx, dy = b.pts[j][0] - hx, b.pts[j][1] - hy
        b.pts[j] = [hx + dx * math.cos(angle) - dy * math.sin(angle), hy + dx * math.sin(angle) + dy * math.cos(angle)]


def frames(ms: int):
    t = T0
    while t < T0 + ms:
        yield t
        t += DT


def fixture(name: str, about: str, ms: int, people, expect: dict) -> None:
    """people(t) -> list of Body (or None for nobody) in that frame."""
    seq = [{"t": t, "poses": [b.raw() for b in people(t) if b is not None]} for t in frames(ms)]
    OUT.mkdir(exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps({"name": name, "about": about, "aspect": ASPECT, "frames": seq, "expect": expect}, separators=(",", ":")))
    print(f"{name}: {len(seq)} frames")


def main() -> None:
    S = T0 + 1500  # when the action starts (after joining and settling)

    # --- join, two players, leave, the leaver's id goes to the next to join ---
    def join_leave(t):
        a = Body(0.3) if t < T0 + 2500 else None
        b = Body(0.7)
        c = Body(0.35) if t >= T0 + 3600 else None
        return [a, b, c]

    fixture("join_leave", "two join (ids 1, 2); 1 leaves; a newcomer takes id 1", 5000, join_leave, {
        "events": [{"type": "join", "id": 1}, {"type": "join", "id": 2}, {"type": "leave", "id": 1}, {"type": "join", "id": 1}],
        "none": ["jump", "crouch", "punch", "kick", "clap"],
        "checks": [
            {"t": T0 + 2000, "count": 2},
            {"t": T0 + 3300, "count": 1},
            {"t": T0 + 4800, "count": 2},
            {"t": T0 + 2000, "id": 1, "path": "distance", "eq": "ok"},
            {"t": T0 + 2000, "id": 1, "path": "facing", "eq": "front"},
            {"t": T0 + 2000, "id": 1, "path": "body.height", "gt": 0.6, "lt": 0.8},
            {"t": T0 + 2000, "id": 1, "path": "center.0", "gt": 0.25, "lt": 0.35},
        ],
    })

    # --- jump: up and down on a parabola, then stand ---
    def jump(t):
        b = Body()
        u = (t - S) / 450
        if 0 <= u <= 1:
            b.lift = 4 * u * (1 - u) * 0.15
        return [b]

    fixture("jump", "one jump (0.15 of the picture, 450 ms): jump, airborne, land", 3000, jump, {
        "events": [{"type": "join", "id": 1}, {"type": "jump", "id": 1}, {"type": "land", "id": 1}],
        "none": ["crouch", "kick", "punch"],
        "checks": [
            {"t": S - 100, "id": 1, "path": "jump.airborne", "eq": False},
            {"t": S + 230, "id": 1, "path": "jump.airborne", "eq": True},
            {"t": S + 230, "id": 1, "path": "jump.height", "gt": 0.3},
            {"t": S + 230, "id": 1, "path": "jump.rise", "gt": 0.06},
            {"t": S + 230, "id": 1, "path": "distance", "eq": "ok"},
            {"t": S + 1200, "id": 1, "path": "jump.airborne", "eq": False},
            {"t": S + 1200, "id": 1, "path": "jump.peak", "gt": 0.4},
        ],
    })

    # --- crouch down, hold, stand up (not a jump) ---
    def crouching(t):
        b = Body()
        amt = ramp(t, S, 300) if t < S + 1200 else 1 - ramp(t, S + 1200, 300)
        crouch(b, amt)
        return [b]

    fixture("crouch", "crouch for a second and stand up again: no jump", 4500, crouching, {
        "events": [{"type": "join", "id": 1}, {"type": "crouch", "id": 1}],
        "none": ["jump", "land", "kick"],
        "checks": [
            {"t": S + 800, "id": 1, "path": "pose.crouching", "eq": True},
            {"t": S + 800, "id": 1, "path": "pose.crouchDepth", "gt": 0.6},
            {"t": S - 100, "id": 1, "path": "pose.crouchDepth", "lt": 0.1},
            {"t": S + 2400, "id": 1, "path": "pose.crouching", "eq": False},
        ],
    })

    # --- a step to the right ---
    def step(t):
        return [Body(lerp(0.4, 0.55, ramp(t, S, 300)))]

    fixture("step", "step 0.15 of the picture to the right in 300 ms", 3000, step, {
        "events": [{"type": "join", "id": 1}],
        "none": ["jump", "crouch", "lean"],
        "checks": [
            {"t": S + 165, "id": 1, "path": "motion.dx", "gt": 0.005},
            {"t": S + 165, "id": 1, "path": "motion.vx", "gt": 0.2},
            {"t": S + 165, "id": 1, "path": "motion.speed", "gt": 1},
            {"t": S + 600, "id": 1, "path": "motion.drift.0", "gt": 0.5},
            {"t": S - 100, "id": 1, "path": "motion.drift.0", "lt": 0.05, "gt": -0.05},
            {"t": S + 1400, "id": 1, "path": "motion.dx", "lt": 0.002},
        ],
    })

    # --- punch with the right hand: from guard to straight out sideways, fast ---
    def punch(t):
        b = Body()
        u = ramp(t, S, 100) if t < S + 600 else 1 - ramp(t, S + 600, 300)
        b.set(10, lerp(0.12, 0.6, u), -0.25)
        b.set(8, lerp(0.2, 0.37, u), lerp(-0.12, -0.27, u))
        return [b]

    fixture("punch", "a right punch out to the side", 3000, punch, {
        "events": [{"type": "join", "id": 1}, {"type": "punch", "id": 1, "hand": "right"}],
        "none": ["clap", "kick", "jump"],
        "checks": [],
    })

    # --- clap ---
    def clap(t):
        b = Body()
        u = ramp(t, S, 150)
        b.set(9, lerp(-0.3, -0.015, u), -0.1)
        b.set(10, lerp(0.3, 0.015, u), -0.1)
        return [b]

    fixture("clap", "hands from apart to together at chest height, and held", 2500, clap, {
        "events": [{"type": "join", "id": 1}, {"type": "clap", "id": 1}],
        "none": ["punch", "jump"],
        "checks": [
            {"t": S + 500, "id": 1, "path": "pose.handsTogether", "eq": True},
            {"t": S - 100, "id": 1, "path": "pose.handsTogether", "eq": False},
        ],
    })

    # --- right hand up (cursor), then both up (handsUp) ---
    def hands(t):
        b = Body()
        if t >= S:
            b.set(10, 0.22, -0.32)
            b.set(8, 0.2, -0.3)
        if t >= S + 1000:
            b.set(10, 0.1, -0.62)
            b.set(9, -0.1, -0.62)
            b.set(7, -0.15, -0.45)
            b.set(8, 0.15, -0.45)
        return [b]

    fixture("hands", "right hand raised (cursor), then both hands above the head", 3500, hands, {
        "events": [{"type": "join", "id": 1}, {"type": "handsUp", "id": 1}],
        "none": ["punch", "clap"],
        "checks": [
            {"t": S - 100, "id": 1, "path": "cursor", "eq": None},
            {"t": S + 600, "id": 1, "path": "cursor.hand", "eq": "right"},
            {"t": S + 600, "id": 1, "path": "cursor.x", "gt": 0.5},
            {"t": S + 600, "id": 1, "path": "cursor.y", "lt": 0.7},
            {"t": S + 1600, "id": 1, "path": "pose.handsUp", "eq": True},
        ],
    })

    # --- lean right ---
    def leaning(t):
        b = Body()
        lean(b, 0.45 * ramp(t, S, 300))
        return [b]

    fixture("lean", "lean 25 degrees to screen-right", 2500, leaning, {
        "events": [{"type": "join", "id": 1}, {"type": "lean", "id": 1, "direction": "right"}],
        "none": ["jump", "crouch"],
        "checks": [
            {"t": S + 600, "id": 1, "path": "pose.lean", "eq": 1},
            {"t": S + 600, "id": 1, "path": "pose.leanAngle", "gt": 0.3},
        ],
    })

    # --- kick and balance ---
    def kick(t):
        b = Body()
        u = ramp(t, S, 120) if t < S + 400 else 1 - ramp(t, S + 400, 200)
        b.set(16, lerp(0.1, 0.22, u), lerp(0.55, 0.2, u))
        b.set(14, lerp(0.1, 0.2, u), lerp(0.3, 0.12, u))
        # Then stand on the right foot: the left foot raised slowly and held.
        v = ramp(t, S + 1200, 800)
        b.set(15, -0.1, lerp(0.55, 0.38, v))
        b.set(13, lerp(-0.1, -0.14, v), lerp(0.3, 0.24, v))
        return [b]

    fixture("kick_balance", "a fast right kick, then the left foot raised slowly and held", 3800, kick, {
        "events": [{"type": "join", "id": 1}, {"type": "kick", "id": 1, "foot": "right"}],
        "none": ["jump", "crouch", {"type": "kick", "foot": "left"}],
        "checks": [
            {"t": S - 100, "id": 1, "path": "pose.balance", "eq": None},
            {"t": S + 2200, "id": 1, "path": "pose.balance", "eq": "left"},
        ],
    })

    # --- distance: far back, then right up close, and turning round ---
    def distance(t):
        if t < S + 1000:
            b = Body(feet=0.92)
        elif t < S + 2000:
            b = Body(feet=0.66, height=0.4)
        else:
            b = Body(feet=1.15, height=0.95)
        if t >= S + 3000:  # turned away: no face, ears seen
            b.feet, b.height = 0.92, 0.7
            for i in (0, 1, 2):
                b.scores[i] = 0.1
        return [b]

    fixture("distance_facing", "ok, then far back, then too close; then turned round", 5500, distance, {
        "events": [{"type": "join", "id": 1}],
        "none": ["kick", "punch"],
        "checks": [
            {"t": S + 900, "id": 1, "path": "distance", "eq": "ok"},
            {"t": S + 1900, "id": 1, "path": "distance", "eq": "far"},
            {"t": S + 2900, "id": 1, "path": "distance", "eq": "close"},
            {"t": S + 2900, "id": 1, "path": "facing", "eq": "front"},
            {"t": S + 3400, "id": 1, "path": "facing", "eq": "back"},
        ],
    })

    # --- side-on: shoulders narrow ---
    def side(t):
        b = Body()
        u = ramp(t, S, 300)
        for i, x in ((5, -0.13), (6, 0.13), (11, -0.09), (12, 0.09), (7, -0.18), (8, 0.18), (9, -0.2), (10, 0.2)):
            b.pts[i][0] = lerp(x, x * 0.25, u)
        return [b]

    fixture("side", "turns side-on to the camera", 2500, side, {
        "events": [{"type": "join", "id": 1}],
        "none": ["kick", "punch", "clap"],
        "checks": [
            {"t": S - 100, "id": 1, "path": "facing", "eq": "front"},
            {"t": S + 700, "id": 1, "path": "facing", "eq": "side"},
        ],
    })


if __name__ == "__main__":
    main()
