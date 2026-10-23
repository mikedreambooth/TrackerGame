"""Sports Day artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

    tracker/.venv/Scripts/python games/sports/art/generate.py [names] [--cut]

After the images it also composes the launcher icon (public/icon.png) from them.
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
THING = (
    "A single object on its own, centered, filling about 80% of the image, floating, no ground, "
    "no shadow, nothing else in the picture. " + ISOLATED
)

MEDAL = (
    "A shiny round {metal} sports medal hanging from a short folded blue and white ribbon at the top, "
    "a laurel wreath embossed around the rim, a plain smooth empty centre (no numbers, no letters), "
    "seen straight from the front. "
)

ART = {
    "background": STYLE + "A sunny school sports day in a big friendly cartoon athletics stadium, seen from "
    "the middle of the field. The top half of the picture: bright blue sky with a few fluffy clouds, "
    "colourful bunting flags strung across, and a long low grandstand full of happy cheering cartoon "
    "people waving little flags, with a big blank scoreboard and stadium lights. The grandstand's front "
    "wall ends in a straight horizontal line exactly halfway down the picture. The whole bottom half of "
    "the picture is plain flat mown green grass with soft stripes and nothing on it. No text. "
    "Widescreen 16:9.",
    "hurdle": STYLE + "A single athletics hurdle seen from the front and slightly to the side: two thin white "
    "metal legs, one at each end, each standing on a small foot, joined at the top by one wide horizontal "
    "board with bold red and white stripes, on a plain flat dark navy blue background. " + THING,
    "mat": STYLE + "A big soft blue high-jump landing mat, a thick cushioned rectangular block seen from "
    "the front and slightly above, with a yellow trim stripe around the sides. " + THING,
    "medal_gold": STYLE + MEDAL.format(metal="gold") + THING,
    "medal_silver": STYLE + MEDAL.format(metal="silver") + THING,
    "medal_bronze": STYLE + MEDAL.format(metal="bronze") + THING,
    "podium": STYLE + "A winners' podium for three, seen straight from the front: three blocks side by side "
    "touching each other, the tallest in the middle painted gold, a medium one on the left painted silver, "
    "and the lowest one on the right painted bronze, each with flat tops, plain empty fronts with no "
    "numbers or letters, sitting on nothing, on a plain flat light blue background. " + THING,
    "trophy": STYLE + "A classic shiny golden winner's trophy cup: a big round deep bowl with two curly "
    "loop handles on the sides, on a slim stem, standing on a small square black base, a little star "
    "engraved on the bowl. " + THING,
    "star": STYLE + "A single plump shiny golden five-pointed star with a happy sparkle. " + THING,
}

SIZES = {"podium": 512, "medal_gold": 256, "medal_silver": 256, "medal_bronze": 256, "star": 192, "hurdle": 384, "mat": 384, "trophy": 384}


def key_holes(name: str, tol: float = 14) -> None:
    """The cutter fills holes inside a subject (e.g. the gap in a trophy's handle) with the
    backdrop; clear any pixels that are still backdrop-coloured."""
    raw = cv2.imread(str(HERE / ".raw" / f"{name}.png"))
    p = HERE.parent / "public" / "art" / f"{name}.png"
    im = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
    if raw is None or im is None:
        return
    border = np.concatenate([raw[:8].reshape(-1, 3), raw[-8:].reshape(-1, 3), raw[:, :8].reshape(-1, 3), raw[:, -8:].reshape(-1, 3)])
    lab_bg = cv2.cvtColor(border[None].astype(np.uint8), cv2.COLOR_BGR2LAB)[0].astype(np.float32)
    lab = cv2.cvtColor(im[:, :, :3], cv2.COLOR_BGR2LAB).astype(np.float32)
    near = np.full(lab.shape[:2], 1e9, np.float32)
    for c in lab_bg[:: max(1, len(lab_bg) // 64)]:
        near = np.minimum(near, np.linalg.norm(lab - c, axis=2))
    hole = (near < tol).astype(np.uint8)
    hole = cv2.morphologyEx(hole, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    alpha = im[:, :, 3].astype(np.float32) * (1 - cv2.GaussianBlur(hole.astype(np.float32), (5, 5), 0))
    im[:, :, 3] = alpha.astype(np.uint8)
    cv2.imwrite(str(p), im, [cv2.IMWRITE_PNG_COMPRESSION, 9])


def make_icon() -> None:
    """400x300 launcher icon: the stadium with a trophy, a medal and a hurdle."""
    art = HERE.parent / "public" / "art"
    bg = cv2.imread(str(art / "background.jpg"))
    h, w = bg.shape[:2]
    cw = int(h * 4 / 3)
    x0 = (w - cw) // 2
    icon = cv2.resize(bg[:, x0 : x0 + cw], (400, 300), interpolation=cv2.INTER_AREA).astype(np.float32)

    def paste(name: str, size: int, cx: int, cy: int) -> None:
        im = cv2.imread(str(art / f"{name}.png"), cv2.IMREAD_UNCHANGED)
        im = cv2.resize(im, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
        x, y = cx - size // 2, cy - size // 2
        xs, ys = max(0, -x), max(0, -y)
        xe, ye = min(size, 400 - x), min(size, 300 - y)
        a = im[ys:ye, xs:xe, 3:4] / 255.0
        dst = icon[y + ys : y + ye, x + xs : x + xe]
        dst[:] = im[ys:ye, xs:xe, :3] * a + dst * (1 - a)

    paste("hurdle", 170, 300, 225)
    paste("trophy", 210, 175, 160)
    paste("medal_gold", 120, 70, 210)
    cv2.imwrite(str(HERE.parent / "public" / "icon.png"), icon.astype(np.uint8))
    print("[art] icon -> public/icon.png", flush=True)


if __name__ == "__main__":
    run(ART, HERE, SIZES, strict={"podium"})
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or list(ART)
    for name in ("trophy", "medal_bronze"):
        if name in names:
            key_holes(name)
    make_icon()
