"""Jousting artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

    tracker/.venv/Scripts/python games/joust/art/generate.py [names] [--cut]

The knights and horses stay canvas paths (src/draw.ts) so they can gallop and fall;
this is the world around them plus the crest on their shields and caparisons.
"knight" is only used for the launcher icon (public/icon.png), which is composed at
the end; its cut-out is moved back into art/.raw so it doesn't ship.
"""

import shutil
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

ART = {
    "background": STYLE + "A sunny medieval jousting tournament field. The top half of the picture: blue sky "
    "with fluffy clouds, a friendly fairytale castle with round towers and pointy roofs on a green hill "
    "on the right, and on the left a long wooden grandstand with a red and white striped canopy full of "
    "happy cheering cartoon villagers, kings and princesses waving, colourful heraldic banners and "
    "pennants on poles. Everything stands on a line exactly halfway down the picture. The whole bottom "
    "half of the picture is plain flat smooth raked light sand with nothing on it. No text. "
    "Widescreen 16:9.",
    "barrier": STYLE + "A long low wooden jousting tilt fence section seen exactly from the side: a straight "
    "horizontal top rail and a lower rail on short posts, hung with alternating red and blue cloth panels "
    "with gold trim, much wider than it is tall, on a plain flat light green background. " + THING,
    "crest": STYLE + "A heraldic badge: the face of a cute proud golden lion with a big round fluffy golden "
    "mane, seen from the front, smiling, simple bold shape, like a shiny gold emblem. " + THING,
    "knight": STYLE + "A cheerful cartoon knight in shiny armour with a red plume on his helmet, riding a "
    "galloping brown horse with a red and gold cloth, lance pointing forward, side view facing right. "
    + THING,
}

SIZES = {"barrier": 1024, "crest": 256, "knight": 512}
ICON_ONLY = ["knight"]


def crop_to_alpha(name: str) -> None:
    """The cutter makes square images; trim a wide subject to its own bounds."""
    p = HERE.parent / "public" / "art" / f"{name}.png"
    im = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
    ys, xs = np.nonzero(im[:, :, 3] > 8)
    cv2.imwrite(str(p), im[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1], [cv2.IMWRITE_PNG_COMPRESSION, 9])


def make_icon() -> None:
    """400x300 launcher icon: the lists with a charging knight and the lion crest."""
    art = HERE.parent / "public" / "art"
    bg = cv2.imread(str(art / "background.jpg"))
    h, w = bg.shape[:2]
    cw = int(h * 4 / 3)
    x0 = (w - cw) // 2
    icon = cv2.resize(bg[:, x0 : x0 + cw], (400, 300), interpolation=cv2.INTER_AREA).astype(np.float32)

    def paste(path: Path, size: int, cx: int, cy: int) -> None:
        im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        im = cv2.resize(im, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
        x, y = cx - size // 2, cy - size // 2
        xs, ys = max(0, -x), max(0, -y)
        xe, ye = min(size, 400 - x), min(size, 300 - y)
        a = im[ys:ye, xs:xe, 3:4] / 255.0
        dst = icon[y + ys : y + ye, x + xs : x + xe]
        dst[:] = im[ys:ye, xs:xe, :3] * a + dst * (1 - a)

    knight = art / "knight.png"
    if not knight.exists():
        knight = HERE / ".raw" / "knight-cut.png"
    paste(knight, 280, 210, 165)
    paste(art / "crest.png", 90, 350, 60)
    cv2.imwrite(str(HERE.parent / "public" / "icon.png"), icon.astype(np.uint8))
    print("[art] icon -> public/icon.png", flush=True)


if __name__ == "__main__":
    run(ART, HERE, SIZES, strict={"barrier"})
    if (HERE.parent / "public" / "art" / "barrier.png").exists():
        crop_to_alpha("barrier")
    make_icon()
    for name in ICON_ONLY:
        p = HERE.parent / "public" / "art" / f"{name}.png"
        if p.exists():
            shutil.move(str(p), str(HERE / ".raw" / f"{name}-cut.png"))
