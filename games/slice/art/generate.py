"""Fruit Swipe artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

Each fruit has a whole sprite and a "-half" sprite (the cut face); a sliced fruit flies
apart as two cut halves.

    tracker/.venv/Scripts/python games/slice/art/generate.py [names] [--cut]
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, run  # noqa: E402

STYLE = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich saturated colours, cheerful and playful, suitable for young children. "
)
THING = (
    "A single object on its own, centered, filling about 80% of the image, floating in the air "
    "(no ground, no shadow), nothing else in the picture. " + ISOLATED
)
HALF = "cut cleanly in half, seen straight on so the flat juicy cut face fills the view as a round cross-section, "

FRUIT = {
    "watermelon": "A round whole watermelon with glossy dark and light green stripes",
    "orange": "A whole round shiny orange with a small green leaf on top",
    "apple": "A whole shiny red apple with a little brown stalk and a green leaf",
    "lemon": "A whole bright yellow lemon",
    "plum": "A whole round glossy deep purple plum with a tiny stalk",
}
HALVES = {
    "watermelon": "A round watermelon " + HALF + "bright red juicy flesh with black seeds and a green and white rind ring",
    "orange": "A round orange " + HALF + "juicy orange segments radiating from the middle and a thin orange peel ring",
    "apple": "A red apple " + HALF + "creamy white flesh with a little star of brown pips in the middle and a red skin edge",
    "lemon": "A lemon " + HALF + "pale yellow juicy segments radiating from the middle and a bright yellow peel ring",
    "plum": "A plum " + HALF + "juicy golden-orange flesh with a brown stone in the middle and a deep purple skin edge",
}

ART = {
    **{k: STYLE + v + ". " + THING for k, v in FRUIT.items()},
    **{f"{k}-half": STYLE + v + ". " + THING for k, v in HALVES.items()},
    "bomb": STYLE + "A cartoon bomb: a round glossy black ball with a short brass cap on top and a short "
    "curly fuse with a bright little spark at its tip, looking like a toy, not scary. " + THING,
    "background": STYLE + "A sunny fruit orchard at golden hour: rows of leafy fruit trees heavy with oranges, "
    "apples and lemons, a wooden fence, a little red barn far away, wooden crates of fruit at the sides, "
    "a soft blue sky with fluffy clouds. Gentle, slightly muted background colours with soft depth of field. "
    "Keep the middle and lower middle of the picture fairly plain (players and flying fruit go there). "
    "No text. Widescreen 16:9.",
}

if __name__ == "__main__":
    run(ART, HERE, {k: 288 for k in ART}, strict={"apple-half"})
