"""Air Painting artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

The paint pot is generated once, filled with white paint; tint_pots() then recolours the
paint for every pot in the game so each pot shows exactly the colour it paints.

    tracker/.venv/Scripts/python games/paint/art/generate.py [names] [--cut]
"""

import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, run  # noqa: E402

STYLE = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich saturated colours, cheerful and playful, suitable for young children. "
)
THING = "A single object on its own, centered, filling about 80% of the image, nothing else in the picture. " + ISOLATED

ART = {
    "pot": STYLE + "A small round open paint tin with no lid, seen from the front and a little above so the "
    "flat surface of the paint inside shows as a wide oval. The tin is filled right to the brim with smooth "
    "pure bright white paint and one thick white drip runs down the front. The tin itself is shiny dark "
    "navy-blue metal with a thin silver rim, floating in the air (no ground, no shadow), on a plain "
    "bright orange background. " + THING,
    "glitter": STYLE + "A small round open paint tin with no lid, seen from the front and a little above, "
    "filled to the brim with sparkling golden glitter paint, with little twinkling stars and sparkles "
    "popping out of it. The tin is shiny dark navy-blue metal with a thin silver rim, floating in the air "
    "(no ground, no shadow), on a plain light-grey background. " + THING,
    "eraser": STYLE + "A chunky rounded pink rubber eraser, lying at a jaunty angle, "
    "floating in the air (no ground, no shadow), on a plain light-blue background. " + THING,
    "brush": STYLE + "A single artist's paintbrush pointing diagonally from the bottom-right corner to the "
    "top-left corner: a glossy red wooden handle, a shiny silver ferrule and a soft pointed tuft of clean "
    "white bristles at the top-left end, floating in the air (no ground, no shadow), on a plain dark "
    "teal-green background. " + THING,
    "background": STYLE + "Inside a bright cheerful children's art studio on a sunny day: warm wooden "
    "floor, cream walls, a big window with sunshine, shelves crowded with colourful paint pots, jars of "
    "brushes and crayons, children's paintings pinned on the walls, a wooden easel, a potted plant and "
    "colourful paint splats. Soft warm light. Keep the middle of the picture fairly plain (a big sheet "
    "of paper covers it). No text. Widescreen 16:9.",
}

# Must match POTS in src/main.ts.
COLOURS = ["e63946", "ff9f1c", "ffd60a", "2a9d3a", "3a86ff", "7209b7", "ff70a6", "8d5524", "1b1030"]


def tint_pots() -> None:
    """pot.png (white paint) -> pot-<hex>.png for each colour, plus pot-rainbow.png."""
    out = HERE.parent / "public" / "art"
    pot = cv2.imread(str(out / "pot.png"), cv2.IMREAD_UNCHANGED)
    bgr = pot[:, :, :3].astype(np.float32) / 255
    hsv = cv2.cvtColor(pot[:, :, :3], cv2.COLOR_BGR2HSV)
    # White paint: bright and unsaturated. Opening drops the thin silver rim; keep the
    # sizeable blobs (paint surface and drip), then grow them back within the bright pixels.
    bright = ((hsv[:, :, 1] < 40) & (hsv[:, :, 2] > 175) & (pot[:, :, 3] > 128)).astype(np.uint8)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    paint = cv2.morphologyEx(bright, cv2.MORPH_OPEN, ker)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(paint)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    cy = cents[big][1]
    # The surface, plus the drip below it (not glints on the rim).
    keep = [i for i in range(1, n) if i == big or (stats[i, cv2.CC_STAT_AREA] > 40 and cents[i][1] > cy)]
    paint = np.isin(labels, keep).astype(np.uint8)
    paint = cv2.dilate(paint, np.ones((3, 3), np.uint8), iterations=3) & bright
    mask = cv2.GaussianBlur(paint.astype(np.float32), (3, 3), 0)[:, :, None]
    shade = bgr.mean(axis=2, keepdims=True)  # the white paint's shading, 0..1
    h, w = pot.shape[:2]
    for name in COLOURS + ["rainbow"]:
        if name == "rainbow":
            hue = np.tile(np.linspace(0, 150, w, dtype=np.float32), (h, 1))
            hsv_c = np.dstack([hue, np.full((h, w), 230, np.float32), np.full((h, w), 255, np.float32)]).astype(np.uint8)
            col = cv2.cvtColor(hsv_c, cv2.COLOR_HSV2BGR).astype(np.float32) / 255
        else:
            rgb = [int(name[i : i + 2], 16) / 255 for i in (0, 2, 4)]
            col = np.array(rgb[::-1], np.float32)[None, None, :]
        # The paint's own shading tints the colour; its brightest highlights stay light.
        lit = np.clip(col * np.minimum(shade * 1.15, 1.0) + np.maximum(shade - 0.9, 0) * 4 * (1 - col), 0, 1)
        res = bgr * (1 - mask) + lit * mask
        img = np.dstack([(res * 255).astype(np.uint8), pot[:, :, 3]])
        cv2.imwrite(str(out / f"pot-{name}.png"), img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f"[art] tinted {len(COLOURS) + 1} pots -> {out}", flush=True)


if __name__ == "__main__":
    run(ART, HERE, {"pot": 192, "glitter": 192, "eraser": 192, "brush": 256})
    names = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not names or "pot" in names:
        tint_pots()
