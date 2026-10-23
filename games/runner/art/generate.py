"""Block Dash artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

    tracker/.venv/Scripts/python.exe games/runner/art/generate.py            # everything
    tracker/.venv/Scripts/python.exe games/runner/art/generate.py brick      # just one
    tracker/.venv/Scripts/python.exe games/runner/art/generate.py --cut      # re-process only

The block faces and ground tiles are full-frame square textures (saved as JPEG, no cut-out):
the game puts them on 3D cubes and on the track. The coin, star and bush are cut out of their
backdrop as transparent PNGs. The players are camera cut-outs on cards, so there's no art for
them. All designs are original (no characters, logos or assets from existing games).
"""

import os
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, gcloud, generate, run, trim_bars  # noqa: E402

STYLE = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich saturated colours, cheerful and playful, suitable for young children. "
)
THING = "A single object on its own, centered, filling about 80% of the image, nothing else in the picture. " + ISOLATED
ORIGINAL = "An original design, not from any existing video game, no logos, no characters. "

ART = {
    "background": STYLE + ORIGINAL + "A bright cheerful cartoon world seen from a little above: a wide band of "
    "big smooth rounded green hills with a few round bushy trees and little round-topped hills with cute dots on "
    "them, behind them a clear bright blue sky with a few big fluffy white clouds. The bottom third of the picture "
    "is plain green grass. No path, no people, no blocks, no text. Widescreen 16:9.",
    "coin": STYLE + ORIGINAL + "A single shiny round gold coin seen straight from the front, thick rim, a simple "
    "embossed star in the middle, sparkling. " + THING,
    "star": STYLE + ORIGINAL + "A magical power-up star made of glossy faceted crystal, five chunky rounded points, "
    "each facet a different bright rainbow colour (red, orange, yellow, green, blue, purple), a bright white sparkle "
    "in the middle, no face, no eyes, crisp clean outline, no glow halo, on a plain dark navy blue background. " + THING,
    "bush": STYLE + "A round fluffy bright green bush made of three puffy bumps, with a few tiny white flowers. " + THING,
}

# Full-frame square textures, kept whole (no cut-out).
TEXTURES = {
    "brick": STYLE + ORIGINAL + "A flat front-on view of a cartoon brick wall surface filling the ENTIRE picture "
    "edge to edge with no border and no background: four rows of chunky rounded warm orange-brown bricks laid in a "
    "staggered running-bond pattern (each row offset by half a brick), two bricks per row, with dark brown grooves "
    "between them, evenly lit, no perspective, nothing else, no text.",
    "qblock": STYLE + ORIGINAL + "A flat front-on view of ONE square face of a glossy golden-yellow mystery block, "
    "filling the entire picture edge to edge: a bevelled rounded square border in deeper orange, four little round "
    "rivets in the corners, and one big bold white question mark with a dark outline in the centre. "
    "Evenly lit, no perspective, nothing else.",
    "grass": STYLE + "A flat top-down view of a lawn of short bright green cartoon grass filling the entire picture "
    "edge to edge, small soft tufts and a few tiny flowers, evenly lit, no shadows, no objects, no text.",
    "path": STYLE + "A flat top-down view of a smooth light sandy dirt path surface filling the entire picture edge "
    "to edge: warm beige and tan with a few small rounded pebbles, evenly lit, no shadows, no grass, no text.",
}


def crop_margin(img: np.ndarray) -> np.ndarray:
    """Drop a plain backdrop margin around a block face (the model rarely fills the frame)."""
    corner = np.median(np.concatenate([img[:4, :4].reshape(-1, 3), img[-4:, -4:].reshape(-1, 3)]), axis=0)
    diff = np.abs(img.astype(np.int16) - corner).max(axis=2) > 40
    ys, xs = np.nonzero(diff)
    if not len(xs):
        return img
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    if (x1 - x0) * (y1 - y0) > 0.95 * img.shape[0] * img.shape[1]:
        return img  # already full-frame (grass, path)
    img = img[y0 : y1 + 1, x0 : x1 + 1].copy()
    # Rounded corners leave backdrop in the corners: paint them in from the face's border.
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    pale = (hsv[:, :, 1] < 90) & (hsv[:, :, 2] > 170)  # backdrop-ish (white/grey), not the orange rim
    outer = np.ones((h, w), bool)
    outer[int(h * 0.12) : int(h * 0.88), int(w * 0.12) : int(w * 0.88)] = False
    mask = cv2.dilate((pale & outer).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool) & outer
    ring = img[outer & ~mask]
    if len(ring):
        img[mask] = np.median(ring, axis=0)
    return img


def textures(names: list[str], cut_only: bool) -> None:
    raw, out = HERE / ".raw", HERE.parent / "public" / "art"
    raw.mkdir(exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    if not cut_only:
        project = os.environ.get("GOOGLE_CLOUD_PROJECT") or gcloud("config", "get-value", "project")
        token = gcloud("auth", "application-default", "print-access-token")
        for name in names:
            print(f"[art] generating {name}...", flush=True)
            cv2.imwrite(str(raw / f"{name}.png"), generate(TEXTURES[name], token, project, "1:1"))
    for name in names:
        img = crop_margin(trim_bars(cv2.imread(str(raw / f"{name}.png"), cv2.IMREAD_COLOR)))
        h, w = img.shape[:2]
        s = min(h, w)
        img = img[(h - s) // 2 : (h + s) // 2, (w - s) // 2 : (w + s) // 2]
        img = cv2.resize(img, (512, 512), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(out / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
        print(f"[art] {name} -> {out}", flush=True)


if __name__ == "__main__":
    asked = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    tex = [n for n in asked if n in TEXTURES] if asked else list(TEXTURES)
    rest = [n for n in asked if n not in TEXTURES]
    if tex:
        textures(tex, "--cut" in flags)
    if rest or not asked:
        sys.argv[1:] = rest + flags
        run(ART, HERE, {"coin": 256, "star": 384, "bush": 384}, strict={"coin"})
