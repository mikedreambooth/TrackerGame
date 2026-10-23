"""Wall Squeeze artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

"bricks" is a full-frame texture (not a cut-out): the game paints the wall with it and
then cuts the body-shaped holes out of it, so it is saved as a plain JPEG.
"""

import os
import sys
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, gcloud, generate, run, trim_bars  # noqa: E402

STYLE = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich saturated colours, cheerful and playful, suitable for young children. "
)
THING = "A single object on its own, centered, filling about 80% of the image, nothing else in the picture. " + ISOLATED

ART = {
    "background": STYLE + "A sunny cartoon fairy-tale kingdom seen from a low camera: a wide straight cobblestone "
    "path starts across the whole bottom of the picture and runs straight ahead into the distance, narrowing to a "
    "point in the exact centre of the picture, where a friendly little castle with round towers and colourful flags "
    "sits on the horizon. Green rolling hills, round trees and flower bushes on both sides, bright blue sky with "
    "fluffy white clouds. The horizon is a little above the middle of the picture. Keep the path and the middle "
    "of the picture fairly plain (players stand there). No people, no text. Widescreen 16:9.",
    "star": STYLE + "A shiny golden cartoon star with five rounded points and a big happy smiling face, sparkling. " + THING,
    "sign": STYLE + "A blank square chalkboard sign seen straight from the front: a plain dark green board with "
    "nothing written on it, in a chunky rounded light wooden frame, floating, no stand, no shadow. " + THING,
}

# Full-frame textures: 16:9, kept whole (no cut-out).
TEXTURES = {
    "bricks": STYLE + "A flat front-on view of a cartoon brick wall that fills the entire picture edge to edge: "
    "neat rows of chunky rounded bricks in warm orange, terracotta and red tones with light cream mortar, "
    "a few bricks slightly lighter or darker, evenly lit, no perspective, no sky, no ground, no plants, "
    "no holes, no other objects, no text. Widescreen 16:9.",
}


def textures(names: list[str], cut_only: bool) -> None:
    raw, out = HERE / ".raw", HERE.parent / "public" / "art"
    raw.mkdir(exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    if not cut_only:
        project = os.environ.get("GOOGLE_CLOUD_PROJECT") or gcloud("config", "get-value", "project")
        token = gcloud("auth", "application-default", "print-access-token")
        for name in names:
            print(f"[art] generating {name}...", flush=True)
            cv2.imwrite(str(raw / f"{name}.png"), generate(TEXTURES[name], token, project, "16:9"))
    for name in names:
        img = trim_bars(cv2.imread(str(raw / f"{name}.png"), cv2.IMREAD_COLOR))
        img = cv2.resize(img, (1280, round(img.shape[0] * 1280 / img.shape[1])), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(out / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
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
        run(ART, HERE, {"star": 256, "sign": 384}, strict={"sign"})
