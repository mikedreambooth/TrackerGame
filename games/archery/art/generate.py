"""Archery artwork, generated with Gemini. See tools/gemini_art.py for how to run it.

The bows, arrows and archers are drawn in 3D as lines in each player's colour (src/main.ts), so
there's no art for them here.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, STYLE, run  # noqa: E402

# The shared style leans spooky; this game is a sunny day out.
SUNNY = "Bright, sunny and cheerful (not spooky at all). "
THING = "A single object on its own, centered, filling about 80% of the image, nothing else in the picture. " + ISOLATED

ART = {
    "target": STYLE + SUNNY + "A round archery target face seen straight on from the front, a perfect circle: "
    "concentric coloured rings, from the outside in: white, black, blue, red, and a gold yellow bullseye in the centre, "
    "with a chunky woven straw rim around the edge. Flat front view, no stand, no legs, no arrows. "
    "On a plain light grey background. " + THING,
    "balloon": STYLE + SUNNY + "A shiny round red party balloon with a little tied knot at the bottom, no string. " + THING,
    "background": STYLE + SUNNY + "A sunny archery range in a green meadow, seen from where the archers stand, looking "
    "down range: a mown grass field stretching away to gentle rolling hills, a little fairytale castle far away on a "
    "hill, colourful bunting flags strung along wooden fences at the sides, a few hay bales, blue sky with fluffy "
    "white clouds. Keep the middle and the lower part of the picture fairly plain open grass (the targets and the "
    "players go there). No targets, no people, no text. Widescreen 16:9.",
}

if __name__ == "__main__":
    run(ART, HERE, {"balloon": 384}, strict={"target"})
