"""Piano artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

"wood" is a full-frame texture (not a cut-out) for the piano case around the keys,
so it is saved as a plain JPEG.
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
    "background": STYLE + "Inside a cosy little concert hall seen from the audience: rich red velvet stage curtains "
    "drawn back to both sides with golden tassels, warm golden spotlights shining down from above, a polished "
    "wooden stage floor across the bottom, a softly lit wood-panelled back wall with a few little golden music "
    "note decorations, potted plants at the edges of the stage. Keep the middle of the picture fairly plain and "
    "a little darker (players and the keyboard go there). No piano, no instruments, no people, no text. "
    "Widescreen 16:9.",
    "note1": STYLE + "A single shiny golden cartoon musical eighth note (one round note head with a stem and one "
    "curly flag), glossy, upright, on a plain dark purple background. " + THING,
    "note2": STYLE + "A shiny golden cartoon pair of musical notes joined by a beam at the top (two round note "
    "heads with stems), glossy, upright, on a plain dark purple background. " + THING,
    "sparkle": STYLE + "A simple shiny golden four-pointed star, the twinkle shape: four straight tapering points "
    "(up, down, left, right) meeting in the middle, glossy and solid, nothing else around it, no glow, no bubbles, "
    "no extra stars, on a plain dark purple background. " + THING,
}

# Full-frame textures: 16:9, kept whole (no cut-out).
TEXTURES = {
    "wood": "A flat seamless texture photo of glossy polished dark red-brown mahogany wood, as used on a fine "
    "piano: smooth lacquered shine, gentle wood grain running left to right, a soft warm sheen. The whole picture "
    "is the same flat wooden surface, seen straight on, with no edges, no corners, no perspective, no objects, "
    "no keys, no text. "
    "Widescreen 16:9.",
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
        run(ART, HERE, {"note1": 256, "note2": 256, "sparkle": 192})
