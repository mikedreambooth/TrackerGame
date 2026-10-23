"""Player tracking on the tracker: ids, smoothing, body measures, gestures and hand cursors.

Turns each camera frame's unordered list of detected poses into stable players and one-off
events, and builds the per-player packets sent to the browser (protocol v2, see tracker.py).

This is the twin of the SDK's PoseTracker (packages/sdk/src/tracker.ts), which does the same
in the browser for the simulator: keep the two in step (same rules, same numbers). The shared
fixtures in tracker/tests/ check that they agree:
    tracker/.venv/Scripts/python tracker/tests/test_players.py   (this module)
    node tracker/tests/test-players.mjs                           (the SDK's)

Coordinates: keypoints come in 0..1 in UN-mirrored camera space; everything here (and in the
packets) is MIRRORED (x -> 1 - x), so the screen behaves like a mirror: moving your right hand
to your right moves it right on screen. Thresholds are relative to each player's own size
(shoulder width S, torso length T) so they work for small children and adults, near or far.
Times are ms. Plain Python floats: with up to 4 players this is far cheaper than numpy.
"""

from __future__ import annotations

import math

# COCO-17 keypoint order.
NOSE, L_EYE, R_EYE, L_EAR, R_EAR = 0, 1, 2, 3, 4
L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_WRIST, R_WRIST = 5, 6, 7, 8, 9, 10
L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE = 11, 12, 13, 14, 15, 16
KEYPOINTS = 17

# ---------- tuning (same numbers as packages/sdk/src/tracker.ts) ----------

TRACK = {
    "max_players": 4,
    "confirm_frames": 5,  # frames a new person must be seen for before they join
    "leave_after_ms": 700,  # missing this long -> they've left
    "min_score": 0.35,  # keypoints below this confidence don't count
}

# Arm length as a multiple of the body scale (torso length, or shoulder width if larger).
ARM = {"initial": 1.1, "floor": 0.95, "max": 1.4, "forget_ms": 30_000}

# Body-relative hand cursor (packages/sdk/src/cursor.ts CURSOR).
CURSOR = {
    "min_score": 0.4,
    "raise_on": 0.15,
    "raise_off": 0.0,
    "top_reach": 0.9,
    "side_reach": 0.9,
    "min_side_reach": 0.55,
    "switch_margin": 0.3,
    "other_body_ratio": 0.6,
    "max_reach": 1.5,
}

# Too far / too close (packages/sdk/src/feet.ts FEET), camera-height fractions.
FEET = {"high_y": 0.78, "high_clear_y": 0.81, "edge_y": 0.97, "min_score": 0.3}

JUMP = {
    "takeoff_speed": 2.5,  # body centre rising faster than this many torso lengths/s
    "cooldown_ms": 600,  # between jump events
    "after_crouch_ms": 700,  # standing up from a crouch isn't a jump
    "land_rise": 0.1,  # back down within this many torso lengths of standing height...
    "min_air_ms": 150,  # ...at least this long after take-off
    "max_air_ms": 1500,  # landed anyway after this long
    "stand_tau": 1.0,  # s: how slowly standing height follows the body
}

DRIFT_TAU = 4.0  # s: how slowly a player's "home" spot follows them
HEIGHT_PER_TORSO = 3.2  # standing height ~ this many torso lengths (children and adults)
NOSE_TO_HEIGHT = 1.12  # standing height ~ ankle-to-nose x this
FACING = {"side_ratio": 0.5, "min_front_ratio": 0.6, "frames": 4}

# One Euro settings: (min_cutoff, beta, d_cutoff).
EURO_KEYPOINT = (1.5, 5.0, 1.0)
EURO_CENTRE = (1.0, 5.0, 1.0)
EURO_CURSOR = (1.0, 2.0, 1.0)


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1 / (2 * math.pi * cutoff)
    return 1 / (1 + tau / dt)


class OneEuro:
    """One Euro filter (Casiez et al. 2012): low jitter when still, low lag when moving fast.
    Port of packages/sdk/src/filters.ts. smooth=False passes values through (velocity is
    still estimated)."""

    __slots__ = ("min_cutoff", "beta", "d_cutoff", "smooth", "x", "dx", "last_t")

    def __init__(self, params: tuple[float, float, float], smooth: bool = True):
        self.min_cutoff, self.beta, self.d_cutoff = params
        self.smooth = smooth
        self.x: float | None = None
        self.dx = 0.0
        self.last_t = 0.0

    def filter(self, value: float, t: float) -> float:
        if self.x is None:
            self.x = value
            self.last_t = t
            return value
        dt = max((t - self.last_t) / 1000, 1e-3)
        self.last_t = t
        raw_dx = (value - self.x) / dt
        self.dx += _alpha(self.d_cutoff, dt) * (raw_dx - self.dx)
        if not self.smooth:
            self.x = value
            return value
        cutoff = self.min_cutoff + self.beta * abs(self.dx)
        self.x += _alpha(cutoff, dt) * (value - self.x)
        return self.x

    def reset(self) -> None:
        self.x = None
        self.dx = 0.0


class Keypoint:
    __slots__ = ("x", "y", "score", "vx", "vy")

    def __init__(self) -> None:
        self.x = self.y = self.score = self.vx = self.vy = 0.0


class Track:
    """One person being followed (confirmed = a player)."""

    def __init__(self, c: dict, t: float, smooth: bool):
        self.id = 0  # handed out on joining
        self.confirmed = False
        self.hits = 0
        self.last_seen = t
        self.joined_at = t
        self.det = -1  # index of their detection in this frame's poses (-1: not seen)
        self.fx = [OneEuro(EURO_KEYPOINT, smooth) for _ in range(KEYPOINTS)]
        self.fy = [OneEuro(EURO_KEYPOINT, smooth) for _ in range(KEYPOINTS)]
        self.k = [Keypoint() for _ in range(KEYPOINTS)]
        self.center = c["center"]
        self.cyf = OneEuro(EURO_CENTRE, smooth)  # centre y (shown smoothed, as before)
        self.cxf = OneEuro(EURO_CENTRE, smooth)  # centre x, for horizontal motion only
        self.mx: float | None = None  # smoothed centre x
        self.dx = 0.0
        self.shoulder = c["shoulder"]
        self.torso = c["torso"]
        self.bbox = c["bbox"]
        self.confidence = 0.0
        # Held poses.
        self.hands_up = False
        self.crouching = False
        self.crouch_depth = 0.0
        self.lean = 0
        self.lean_angle = 0.0
        self.arms_out = False
        self.run = 0.0
        self.hands_together = False
        self.balance: str | None = None
        # Body measures.
        self.torso_ac = 0.0  # aspect-corrected torso (camera-height units)
        self.arm_ratio = ARM["initial"]
        self.arm_length = 0.0
        self.arm_at = 0.0
        self.height = 0.0
        # Gesture bookkeeping.
        self.leg_base = 0.0
        self.crouch_ended_at = -1e9
        self.hands_apart_at = -1e9
        self.last_clap = -1e9
        self.ext = {"left": [], "right": []}  # (t, extension) history per arm
        self.last_punch = {"left": -1e9, "right": -1e9}
        self.last_kick = {"left": -1e9, "right": -1e9}
        self.last_jump = 0.0
        self.gt = 0.0  # time of the last gesture pass
        # Jump state.
        self.stand: float | None = None  # standing centre y
        self.airborne = False
        self.air_start = 0.0
        self.peak = 0.0
        self.rise = 0.0
        # Where they usually stand, and which way they face.
        self.home: list[float] | None = None
        self.front_ratio = 0.0
        self.facing = "front"
        self.facing_next = "front"
        self.facing_n = 0
        self.far = False
        self.distance = "ok"
        # Hand cursor.
        self.cursor_hand: int | None = None
        self.cursor_pos: tuple[float, float] | None = None
        self.cfx = OneEuro(EURO_CURSOR, smooth)
        self.cfy = OneEuro(EURO_CURSOR, smooth)
        self.cursor_seen = -1e9

    def filters(self):
        yield from self.fx
        yield from self.fy
        yield from (self.cyf, self.cxf, self.cfx, self.cfy)


def _ok(k: Keypoint, mn: float) -> bool:
    return k.score >= mn


class PlayerTracker:
    """Raw poses per frame -> players with stable ids, smoothed keypoints, measures, held
    poses, hand cursors and events. One instance per camera; call update() every frame."""

    def __init__(self, smoothing: bool = True, max_players: int = TRACK["max_players"]):
        self.tracks: list[Track] = []
        self.next_id = 1
        self.reserved: list[int] = []  # ids of players who left, for the next people to join
        self.smoothing = smoothing
        self.max_players = max_players

    def set_smoothing(self, on: bool) -> None:
        if on == self.smoothing:
            return
        self.smoothing = on
        for tr in self.tracks:
            for f in tr.filters():
                f.smooth = on

    def reset(self) -> None:
        self.tracks = []
        self.reserved = []
        self.next_id = 1

    # ----- per frame -----

    def update(self, poses: list, t: float, aspect: float) -> dict:
        """poses: [[[x, y, score] x 17], ...] un-mirrored. Returns {"players", "events"} (wire v2)."""
        events: list[dict] = []
        cands = []
        for i, p in enumerate(poses):
            if len(p) >= KEYPOINTS:
                c = self._prepare(p, i)
                if c is not None:
                    cands.append(c)

        # Greedy nearest-centre matching. With <= 4 people this is as good as Hungarian.
        pairs = []
        for ti, tr in enumerate(self.tracks):
            gate = max(0.12, tr.shoulder * 2.5)
            for ci, c in enumerate(cands):
                d = math.hypot(tr.center[0] - c["center"][0], tr.center[1] - c["center"][1])
                if d < gate:
                    pairs.append((d, ti, ci))
        pairs.sort(key=lambda p: p[0])
        used_t: set[int] = set()
        used_c: set[int] = set()
        for tr in self.tracks:
            tr.det = -1
        for _, ti, ci in pairs:
            if ti in used_t or ci in used_c:
                continue
            used_t.add(ti)
            used_c.add(ci)
            self._update_track(self.tracks[ti], cands[ci], t)

        # New people.
        for ci, c in enumerate(cands):
            if ci in used_c or len(self.tracks) >= self.max_players:
                continue
            tr = Track(c, t, self.smoothing)
            self.tracks.append(tr)
            self._update_track(tr, c, t)

        # Confirm, measure, detect gestures.
        for tr in self.tracks:
            if not tr.confirmed and tr.hits >= TRACK["confirm_frames"]:
                tr.confirmed = True
                tr.joined_at = t
                self._seat(tr)
                events.append({"type": "join", "id": tr.id})
            if tr.confirmed and tr.last_seen == t:
                self._measure_arm(tr, t, aspect)
                self._detect(tr, t, aspect, events)

        # Leave.
        alive = []
        for tr in self.tracks:
            if t - tr.last_seen <= TRACK["leave_after_ms"]:
                alive.append(tr)
            elif tr.confirmed:
                events.append({"type": "leave", "id": tr.id})
                self.reserved.append(tr.id)
        self.tracks = alive

        live = [tr for tr in self.tracks if tr.confirmed]
        for tr in live:
            self._update_cursor(tr, t, aspect, live)
        live.sort(key=lambda tr: tr.id)
        return {"players": [self._packet(tr, t, aspect) for tr in live], "events": events}

    def ids_by_detection(self, count: int) -> list[int]:
        """Player id for each detection index of the last update (-1: nobody / not joined yet)."""
        ids = [-1] * count
        for tr in self.tracks:
            if tr.confirmed and 0 <= tr.det < count:
                ids[tr.det] = tr.id
        return ids

    def _seat(self, tr: Track) -> None:
        """Someone who left keeps their place: the next person to join takes over their id (the
        lowest waiting first), so games keyed by id carry on. New ids only when none wait."""
        if self.reserved:
            self.reserved.sort()
            tr.id = self.reserved.pop(0)
        else:
            tr.id = self.next_id
            self.next_id += 1

    def _prepare(self, raw: list, det: int) -> dict | None:
        mn = TRACK["min_score"]
        kps = [(1 - p[0], p[1], p[2]) for p in raw[:KEYPOINTS]]  # mirrored
        ls, rs = kps[L_SHOULDER], kps[R_SHOULDER]
        if ls[2] < mn or rs[2] < mn:
            return None  # need shoulders to be useful
        lh, rh = kps[L_HIP], kps[R_HIP]
        sm = ((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2)
        hips = lh[2] >= mn and rh[2] >= mn
        hm = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2) if hips else None
        shoulder = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
        if shoulder < 0.02:
            return None
        torso = math.hypot(sm[0] - hm[0], sm[1] - hm[1]) if hm else shoulder * 1.3
        center = ((sm[0] + hm[0]) / 2, (sm[1] + hm[1]) / 2) if hm else sm
        xs = [k[0] for k in kps if k[2] >= mn]
        ys = [k[1] for k in kps if k[2] >= mn]
        bbox = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        return {"kps": kps, "center": center, "shoulder": shoulder, "torso": torso, "bbox": bbox, "det": det}

    def _update_track(self, tr: Track, c: dict, t: float) -> None:
        tr.hits += 1
        tr.last_seen = t
        tr.det = c["det"]
        tr.shoulder = tr.shoulder * 0.8 + c["shoulder"] * 0.2
        tr.torso = tr.torso * 0.8 + c["torso"] * 0.2
        tr.bbox = c["bbox"]
        cy = tr.cyf.filter(c["center"][1], t)
        tr.center = (c["center"][0], cy)
        mx = tr.cxf.filter(c["center"][0], t)
        tr.dx = 0.0 if tr.mx is None else mx - tr.mx
        tr.mx = mx
        mn = TRACK["min_score"]
        total = 0.0
        for i, (x, y, s) in enumerate(c["kps"]):
            k = tr.k[i]
            if s >= mn:
                k.x = tr.fx[i].filter(x, t)
                k.y = tr.fy[i].filter(y, t)
                k.vx = tr.fx[i].dx
                k.vy = tr.fy[i].dx
                k.score = s
            else:
                # Hold the last position, fade confidence, kill velocity.
                k.score *= 0.8
                k.vx = k.vy = 0.0
            total += s
        tr.confidence = total / KEYPOINTS

    def _measure_arm(self, tr: Track, t: float, aspect: float) -> None:
        """Arm length: the longest shoulder->elbow->wrist seen recently, as a multiple of the body
        scale; slowly forgotten, clamped to human proportions. Also the aspect-corrected torso."""
        k = tr.k
        good = lambda *ids: all(k[i].score >= 0.5 for i in ids)  # noqa: E731
        d = lambda a, b: math.hypot((k[a].x - k[b].x) * aspect, k[a].y - k[b].y)  # noqa: E731
        if not good(L_SHOULDER, R_SHOULDER):
            return
        S = d(L_SHOULDER, R_SHOULDER)
        if good(L_HIP, R_HIP):
            tx = (k[L_SHOULDER].x + k[R_SHOULDER].x - k[L_HIP].x - k[R_HIP].x) / 2
            ty = (k[L_SHOULDER].y + k[R_SHOULDER].y - k[L_HIP].y - k[R_HIP].y) / 2
            T = math.hypot(tx * aspect, ty)
            tr.torso_ac = tr.torso_ac * 0.8 + T * 0.2 if tr.torso_ac else T
        elif not tr.torso_ac:
            tr.torso_ac = 1.4 * S
        B = max(tr.torso_ac, S, 0.02)
        dt = min(t - tr.arm_at, 250) if tr.arm_at else 0
        tr.arm_at = t
        ratio = ARM["floor"] + (tr.arm_ratio - ARM["floor"]) * math.exp(-dt / ARM["forget_ms"])
        for sh, el, wr in ((L_SHOULDER, L_ELBOW, L_WRIST), (R_SHOULDER, R_ELBOW, R_WRIST)):
            if good(sh, el, wr):
                ratio = max(ratio, min(ARM["max"], (d(sh, el) + d(el, wr)) / B))
        tr.arm_ratio = ratio
        tr.arm_length = ratio * B

    def _detect(self, tr: Track, t: float, aspect: float, events: list[dict]) -> None:
        """Held poses and one-off events from the smoothed keypoints."""
        k = tr.k
        mn = TRACK["min_score"]

        def ok(*ids: int) -> bool:
            return all(k[i].score >= mn for i in ids)

        who = tr.id
        S = max(tr.shoulder, 0.02)
        T = max(tr.torso, 0.03)
        TA = tr.torso_ac or T  # aspect-corrected torso, for body-relative distances
        dt = min(max((t - tr.gt) / 1000, 0), 0.5) if tr.gt else 0.0
        tr.gt = t

        def ease(tau: float) -> float:
            return 1 - math.exp(-dt / tau)

        # Hands up: both wrists above the nose.
        if ok(L_WRIST, R_WRIST, NOSE):
            up = k[L_WRIST].y < k[NOSE].y and k[R_WRIST].y < k[NOSE].y
            if up and not tr.hands_up:
                events.append({"type": "handsUp", "id": who})
            tr.hands_up = up

        # Crouch: legs (hip -> standing foot height) much shorter than this player's standing
        # legs. The lower foot, so a kick or standing on one leg isn't a crouch.
        ankles = [i for i in (L_ANKLE, R_ANKLE) if ok(i)]
        if ok(L_HIP, R_HIP) and ankles:
            hip_y = (k[L_HIP].y + k[R_HIP].y) / 2
            ankle_y = max(k[i].y for i in ankles)
            ratio = (ankle_y - hip_y) / T
            if not tr.crouching:
                tr.leg_base = max(tr.leg_base * 0.998, ratio)  # slowly forget
            if not tr.crouching and tr.leg_base > 0 and ratio < tr.leg_base * 0.7:
                tr.crouching = True
                events.append({"type": "crouch", "id": who})
            elif tr.crouching and ratio > tr.leg_base * 0.85:
                tr.crouching = False
                tr.crouch_ended_at = t
            tr.crouch_depth = min(1.0, max(0.0, (1 - ratio / tr.leg_base) / 0.6)) if tr.leg_base > 0 else 0.0

        # Lean: torso tilted more than ~15 degrees from upright (with hysteresis).
        if ok(L_SHOULDER, R_SHOULDER, L_HIP, R_HIP):
            dx = (k[L_SHOULDER].x + k[R_SHOULDER].x - k[L_HIP].x - k[R_HIP].x) / 2
            dy = (k[L_HIP].y + k[R_HIP].y - k[L_SHOULDER].y - k[R_SHOULDER].y) / 2
            angle = math.atan2(dx, max(dy, 1e-3))
            lean = tr.lean
            if angle < -0.26:
                lean = -1
            elif angle > 0.26:
                lean = 1
            elif abs(angle) < 0.17:
                lean = 0
            if lean != 0 and lean != tr.lean:
                events.append({"type": "lean", "id": who, "direction": "left" if lean < 0 else "right"})
            tr.lean = lean
            tr.lean_angle = angle

        # Arms out: both wrists well out to the sides, roughly at shoulder height.
        if ok(L_SHOULDER, R_SHOULDER, L_WRIST, R_WRIST):
            lw, rw, ls, rs = k[L_WRIST], k[R_WRIST], k[L_SHOULDER], k[R_SHOULDER]
            out = lw.x < ls.x - 1.1 * S and rw.x > rs.x + 1.1 * S and abs(lw.y - ls.y) < 0.7 * S and abs(rw.y - rs.y) < 0.7 * S
            if out and not tr.arms_out:
                events.append({"type": "armsOut", "id": who})
            tr.arms_out = out

        # Hands together (held), and clap: wrists apart moments ago, now together in front.
        if ok(L_WRIST, R_WRIST):
            d = math.hypot(k[L_WRIST].x - k[R_WRIST].x, k[L_WRIST].y - k[R_WRIST].y)
            tr.hands_together = d < (0.7 if tr.hands_together else 0.5) * S
            if ok(L_HIP, R_HIP):
                above_hips = max(k[L_WRIST].y, k[R_WRIST].y) < min(k[L_HIP].y, k[R_HIP].y)
                # Claps happen at chest height; hands meeting up by the face is a boxing guard.
                hands_y = (k[L_WRIST].y + k[R_WRIST].y) / 2
                below_face = not ok(NOSE) or hands_y > k[NOSE].y + 0.6 * S
                if d > 1.0 * S:
                    tr.hands_apart_at = t
                elif d < 0.4 * S and above_hips and below_face and t - tr.hands_apart_at < 500 and t - tr.last_clap > 400:
                    tr.last_clap = t
                    events.append({"type": "clap", "id": who})
        else:
            tr.hands_together = False

        # Punch: an arm goes from bent to extended fast, at shoulder height, one arm at a time.
        for side, sh, wr, other in (("left", L_SHOULDER, L_WRIST, R_WRIST), ("right", R_SHOULDER, R_WRIST, L_WRIST)):
            if not ok(sh, wr):
                continue
            hist = tr.ext[side]
            ext = math.hypot(k[sh].x - k[wr].x, k[sh].y - k[wr].y) / S
            hist.append((t, ext))
            while hist and t - hist[0][0] > 300:
                hist.pop(0)
            bent = min(v for _, v in hist)
            speed = math.hypot(k[wr].vx, k[wr].vy)
            shoulder_height = abs(k[wr].y - k[sh].y) < 0.8 * S
            one_arm = math.hypot(k[other].vx, k[other].vy) < 0.5 * speed
            if ext > 1.2 and bent < 0.75 and speed > 3 * S and shoulder_height and one_arm and t - tr.last_punch[side] > 350:
                tr.last_punch[side] = t
                hist.clear()
                events.append({"type": "punch", "id": who, "hand": side, "speed": round(speed / S, 2)})

        # Kick: one ankle raised well above the other, moving up fast.
        for side, ankle, other in (("left", L_ANKLE, R_ANKLE), ("right", R_ANKLE, L_ANKLE)):
            if not ok(ankle, other) or tr.crouching:
                continue
            lift = k[other].y - k[ankle].y
            if lift > 0.5 * T and k[ankle].vy < -2 * T and t - tr.last_kick[side] > 500:
                tr.last_kick[side] = t
                events.append({"type": "kick", "id": who, "foot": side})

        # Run effort: how fast the knees (or, failing that, wrists) pump up and down.
        effort = 0.0
        if ok(L_KNEE, R_KNEE):
            effort = (abs(k[L_KNEE].vy) + abs(k[R_KNEE].vy)) / T
        elif ok(L_WRIST, R_WRIST):
            effort = 0.7 * (abs(k[L_WRIST].vy) + abs(k[R_WRIST].vy)) / T
        tr.run += (effort - tr.run) * 0.08

        # Jump: the body centre moving up fast (not just after standing up from a crouch); then
        # airborne until it's back down near standing height.
        vy = tr.cyf.dx  # negative = up
        cy = tr.center[1]
        if tr.stand is None:
            tr.stand = cy
        elif not tr.airborne and not tr.crouching:
            tr.stand += (cy - tr.stand) * ease(JUMP["stand_tau"])
        rise = tr.stand - cy  # camera-height fraction, up = positive
        if vy < -JUMP["takeoff_speed"] * T and t - tr.last_jump > JUMP["cooldown_ms"] and not tr.crouching and t - tr.crouch_ended_at > JUMP["after_crouch_ms"]:
            tr.last_jump = t
            events.append({"type": "jump", "id": who})
            if not tr.airborne:
                tr.airborne = True
                tr.air_start = t
                tr.peak = 0.0
        if tr.airborne:
            tr.peak = max(tr.peak, rise / T)
            air = t - tr.air_start
            if (air > JUMP["min_air_ms"] and rise < JUMP["land_rise"] * T and vy >= 0) or air > JUMP["max_air_ms"]:
                tr.airborne = False
                events.append({"type": "land", "id": who, "airTime": round(air / 1000, 3), "height": round(tr.peak, 3)})
        tr.rise = max(0.0, rise) if tr.airborne else 0.0

        # Balance: standing on one foot (the other ankle raised), with hysteresis.
        bal = None
        if ok(L_ANKLE, R_ANKLE) and not tr.crouching and not tr.airborne:
            lifts = {"left": k[R_ANKLE].y - k[L_ANKLE].y, "right": k[L_ANKLE].y - k[R_ANKLE].y}
            if tr.balance and lifts[tr.balance] > 0.2 * T:
                bal = tr.balance
            else:
                bal = next((s for s in ("left", "right") if lifts[s] > 0.35 * T), None)
        tr.balance = bal

        # Standing height (camera-height fraction): ankle-to-nose when both are seen standing up,
        # else drifting towards an estimate from the torso.
        ankles = [i for i in (L_ANKLE, R_ANKLE) if k[i].score >= FEET["min_score"]]
        if ankles and ok(NOSE) and not tr.crouching and not tr.airborne:
            h = (max(k[i].y for i in ankles) - k[NOSE].y) * NOSE_TO_HEIGHT
            tr.height = tr.height * 0.9 + h * 0.1 if tr.height else h
        else:
            est = TA * HEIGHT_PER_TORSO
            tr.height = tr.height + (est - tr.height) * 0.02 if tr.height else est

        # Home spot (slowly follows them) for drift.
        mx = tr.mx if tr.mx is not None else tr.center[0]
        if tr.home is None:
            tr.home = [mx, cy]
        elif not tr.airborne:
            e = ease(DRIFT_TAU)
            tr.home[0] += (mx - tr.home[0]) * e
            if not tr.crouching:
                tr.home[1] += (cy - tr.home[1]) * e

        # Facing: front, side-on (shoulders narrow for the torso) or back (no face, shoulders
        # swapped or ears seen). Changes only after a few frames in a row.
        if ok(L_SHOULDER, R_SHOULDER):
            ls, rs = k[L_SHOULDER], k[R_SHOULDER]
            sw = math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y)
            ratio = sw / max(TA, 0.02)
            if ok(L_HIP, R_HIP):
                tr.front_ratio = max(tr.front_ratio * 0.999, ratio)
            face = ok(NOSE) or ok(L_EYE, R_EYE)
            swapped = ls.x - rs.x > 0.2 * S
            if not face and (swapped or ok(L_EAR) or ok(R_EAR)):
                cand = "back"
            elif ratio < FACING["side_ratio"] * max(tr.front_ratio, FACING["min_front_ratio"]):
                cand = "side"
            else:
                cand = "front"
            if cand == tr.facing:
                tr.facing_n = 0
            elif cand == tr.facing_next:
                tr.facing_n += 1
                if tr.facing_n >= FACING["frames"]:
                    tr.facing = cand
                    tr.facing_n = 0
            else:
                tr.facing_next = cand
                tr.facing_n = 1

        # Distance from the camera: feet high in the picture = too far back; feet out of the
        # bottom (hips seen) = too close. Held while airborne (feet go up in a jump).
        if tr.airborne:
            return
        lowest = max((k[i].y for i in ankles), default=None)
        if lowest is not None:
            tr.far = lowest < FEET["high_clear_y"] if tr.far else lowest < FEET["high_y"]
        else:
            tr.far = False
        hips = k[L_HIP].score >= FEET["min_score"] and k[R_HIP].score >= FEET["min_score"]
        close = hips and (lowest is None or lowest > FEET["edge_y"])
        tr.distance = "far" if tr.far else "close" if close else "ok"

    # ----- hand cursor (port of cursor.ts) -----

    def _reach(self, tr: Track, aspect: float):
        k = tr.k
        ls, rs = k[L_SHOULDER], k[R_SHOULDER]
        if ls.score < 0.2 or rs.score < 0.2:
            return None
        shoulder = ((ls.x + rs.x) / 2, (ls.y + rs.y) / 2)
        S = max(math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y), 0.02)
        T = tr.torso_ac if tr.torso_ac else 1.4 * S
        waist = shoulder[1] + T
        lh, rh = k[L_HIP], k[R_HIP]
        if lh.score >= 0.35 and rh.score >= 0.35:
            hip = ((lh.x + rh.x) / 2, (lh.y + rh.y) / 2)
            waist = hip[1]
            if not tr.torso_ac:
                T = max(math.hypot((hip[0] - shoulder[0]) * aspect, hip[1] - shoulder[1]), 0.5 * S)
        T = max(T, 0.02)
        A = tr.arm_length if tr.arm_length > 0 else 1.25 * max(T, S)
        return (aspect, shoulder, waist, S, T, A)

    @staticmethod
    def _raised(r, wx: float, wy: float, active: bool) -> bool:
        return wy < r[2] - (CURSOR["raise_off"] if active else CURSOR["raise_on"]) * r[4]

    @staticmethod
    def _stray(r, wx: float, wy: float, others: list) -> bool:
        aspect, sh = r[0], r[1]
        own = math.hypot((wx - sh[0]) * aspect, wy - sh[1])
        if own > CURSOR["max_reach"] * r[5]:
            return True
        return any(math.hypot((wx - o[0]) * aspect, wy - o[1]) < CURSOR["other_body_ratio"] * own for o in others)

    @staticmethod
    def _to_screen(r, wx: float, wy: float) -> tuple[float, float]:
        aspect, sh, waist, S, T, A = r
        bottom = waist - CURSOR["raise_on"] * T
        top = sh[1] - CURSOR["top_reach"] * A
        y = (wy - top) / max(bottom - top, 1e-3)
        dy = min(abs(wy - sh[1]) / A, 1)
        side = max(CURSOR["min_side_reach"], CURSOR["side_reach"] * math.sqrt(1 - dy * dy))
        half = side * A + S / 2
        x = 0.5 + ((wx - sh[0]) * aspect) / (2 * half)
        return (min(1.0, max(0.0, x)), min(1.0, max(0.0, y)))

    def _update_cursor(self, tr: Track, t: float, aspect: float, live: list[Track]) -> None:
        """Only a hand raised above the hips points; the pointing hand sticks until it drops or
        the other is clearly higher; wrists that look like someone else's are ignored; brief
        dropouts keep the cursor."""
        k = tr.k
        r = self._reach(tr, aspect)
        others = [
            ((o.k[L_SHOULDER].x + o.k[R_SHOULDER].x) / 2, (o.k[L_SHOULDER].y + o.k[R_SHOULDER].y) / 2) for o in live if o is not tr
        ]
        hands = [
            i
            for i in (L_WRIST, R_WRIST)
            if r is not None
            and k[i].score >= CURSOR["min_score"]
            and self._raised(r, k[i].x, k[i].y, i == tr.cursor_hand)
            and not self._stray(r, k[i].x, k[i].y, others)
        ]
        hand = None
        if hands:
            hand = tr.cursor_hand if tr.cursor_hand in hands else min(hands, key=lambda i: (k[i].y, -i))
            for h in hands:
                if h != hand and k[h].y < k[hand].y - CURSOR["switch_margin"] * r[4]:
                    hand = h
        if hand is None or r is None:
            c = tr.cursor_hand
            dropped = c is not None and k[c].score >= CURSOR["min_score"] and r is not None and not self._raised(r, k[c].x, k[c].y, True)
            if dropped or t - tr.cursor_seen > 250:
                tr.cursor_hand = None
                tr.cursor_pos = None
            return
        if tr.cursor_pos is None:
            tr.cfx.reset()
            tr.cfy.reset()
        tr.cursor_hand = hand
        tr.cursor_seen = t
        x, y = self._to_screen(r, k[hand].x, k[hand].y)
        tr.cursor_pos = (tr.cfx.filter(x, t), tr.cfy.filter(y, t))

    # ----- output -----

    def _packet(self, tr: Track, t: float, aspect: float) -> dict:
        r4 = lambda v: round(v, 4)  # noqa: E731
        r3 = lambda v: round(v, 3)  # noqa: E731
        seen = tr.last_seen == t
        TA = max(tr.torso_ac or tr.torso, 0.02)
        vx = tr.cxf.dx if seen else 0.0
        vy = tr.cyf.dx if seen else 0.0
        mx = tr.mx if tr.mx is not None else tr.center[0]
        home = tr.home or [mx, tr.center[1]]
        cur = None
        if tr.cursor_pos is not None:
            cur = {"x": r4(tr.cursor_pos[0]), "y": r4(tr.cursor_pos[1]), "hand": "left" if tr.cursor_hand == L_WRIST else "right"}
        return {
            "id": tr.id,
            "since": round(tr.joined_at, 1),
            "det": tr.det,
            "kp": [[r4(k.x), r4(k.y), r3(k.score), r3(k.vx), r3(k.vy)] for k in tr.k],
            "center": [r4(tr.center[0]), r4(tr.center[1])],
            "bbox": [r4(v) for v in tr.bbox],
            "confidence": r3(tr.confidence),
            "body": {"shoulder": r4(tr.shoulder), "torso": r4(TA), "arm": r4(tr.arm_length), "height": r4(tr.height)},
            "motion": {
                "vx": r3(vx),
                "vy": r3(vy),
                "dx": r4(tr.dx if seen else 0.0),
                "speed": r3(math.hypot(vx * aspect, vy) / TA),
                "drift": [r3((mx - home[0]) * aspect / TA), r3((tr.center[1] - home[1]) / TA)],
            },
            "facing": tr.facing,
            "distance": tr.distance,
            "pose": {
                "handsUp": tr.hands_up,
                "crouching": tr.crouching,
                "crouchDepth": r3(tr.crouch_depth),
                "lean": tr.lean,
                "leanAngle": r3(tr.lean_angle),
                "armsOut": tr.arms_out,
                "run": r3(tr.run),
                "handsTogether": tr.hands_together,
                "balance": tr.balance,
            },
            "jump": {
                "airborne": tr.airborne,
                "height": r3(tr.rise / max(tr.torso, 0.03)),
                "rise": r4(tr.rise),
                "airTime": r3((t - tr.air_start) / 1000 if tr.airborne else 0.0),
                "peak": r3(tr.peak),
            },
            "cursor": cur,
        }
