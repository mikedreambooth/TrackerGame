"""Runs the shared fixtures (tracker/tests/fixtures) through tracker/players.py.

    tracker/.venv/Scripts/python tracker/tests/test_players.py     (Windows)
    tracker/.venv/bin/python tracker/tests/test_players.py         (Linux)

Checks each fixture's expectations, and writes every output frame to tracker/tests/out/ so
node tracker/tests/test-players.mjs can check the SDK's PoseTracker gives the same. No pytest:
exits 1 on any failure. Also times the per-frame tracking.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from players import PlayerTracker  # noqa: E402

FIXTURES = HERE / "fixtures"
OUT = HERE / "out"


def get(obj, path: str):
    for part in path.split("."):
        if obj is None:
            return None
        obj = obj[int(part)] if isinstance(obj, list) else obj.get(part)
    return obj


def matches(event: dict, want) -> bool:
    if isinstance(want, str):
        return event["type"] == want
    return all(event.get(k) == v for k, v in want.items())


def check(fx: dict, outs: list[dict]) -> list[str]:
    errors = []
    exp = fx["expect"]
    events = [e for o in outs for e in o["events"]]
    i = 0
    for want in exp.get("events", []):
        while i < len(events) and not matches(events[i], want):
            i += 1
        if i == len(events):
            errors.append(f"missing event {want} (events: {[(e['type'], e['id']) for e in events]})")
            break
        i += 1
    for bad in exp.get("none", []):
        hits = [e for e in events if matches(e, bad)]
        if hits:
            errors.append(f"unexpected {hits[0]}")
    for c in exp.get("checks", []):
        out = next((o for o in outs if o["t"] >= c["t"]), None)
        if out is None:
            errors.append(f"no frame at t={c['t']}")
            continue
        if "count" in c:
            if len(out["players"]) != c["count"]:
                errors.append(f"t={out['t']}: {len(out['players'])} players, want {c['count']}")
            continue
        p = next((p for p in out["players"] if p["id"] == c["id"]), None)
        if p is None:
            errors.append(f"t={out['t']}: no player {c['id']}")
            continue
        v = get(p, c["path"])
        ok = True
        if "eq" in c and v != c["eq"]:
            ok = False
        if "gt" in c and not (isinstance(v, (int, float)) and v > c["gt"]):
            ok = False
        if "lt" in c and not (isinstance(v, (int, float)) and v < c["lt"]):
            ok = False
        if not ok:
            want = {k: c[k] for k in ("eq", "gt", "lt") if k in c}
            errors.append(f"t={out['t']}: {c['path']} = {v!r}, want {want}")
    return errors


def main() -> int:
    OUT.mkdir(exist_ok=True)
    failed = 0
    total_ms = 0.0
    total_frames = 0
    for path in sorted(FIXTURES.glob("*.json")):
        fx = json.loads(path.read_text())
        tracker = PlayerTracker()
        outs = []
        for f in fx["frames"]:
            t0 = time.perf_counter()
            out = tracker.update(f["poses"], f["t"], fx["aspect"])
            total_ms += (time.perf_counter() - t0) * 1000
            total_frames += 1
            outs.append({"t": f["t"], **out})
        (OUT / f"py-{fx['name']}.json").write_text(json.dumps(outs, separators=(",", ":")))
        errors = check(fx, outs)
        failed += bool(errors)
        print(f"{'FAIL' if errors else 'ok  '} {fx['name']}: {fx['about']}")
        for e in errors:
            print(f"       {e}")
    print(f"\n{total_frames} frames, {total_ms / max(total_frames, 1):.3f} ms per frame (1-2 players)")
    print("FAILED" if failed else "all passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
