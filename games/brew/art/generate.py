"""Witches Brew artwork, generated with Gemini. See tools/gemini_art.py for how to run it."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, STYLE, run  # noqa: E402

THING = "A single object on its own, centered, filling about 80% of the image, nothing else in the picture. " + ISOLATED

ART = {
    "cauldron": STYLE + "A big round black iron witch's cauldron seen from the front and slightly above, "
    "so the wide opening at the top shows a bubbling glowing bright green potion with big bubbles, "
    "on three stubby legs over a small cosy log fire with orange flames. " + THING,
    "frog": STYLE + "A cute chubby green frog sitting, big shiny eyes, wide smile. " + THING,
    "eyeball": STYLE + "A single cute cartoon eyeball with a bright blue iris and a few red veins, glossy. " + THING,
    "bat": STYLE + "A cute little purple bat with wings spread wide, big ears, tiny fangs, happy face. " + THING,
    "toadstool": STYLE + "A bright red toadstool mushroom with white spots on the cap and a cream stalk, "
    "floating in the air (no ground, no shadow), on a plain cool blue-grey background. " + THING,
    "spider": STYLE + "A cute fuzzy black spider with eight bendy legs, big friendly eyes and a little smile. " + THING,
    "crystal": STYLE + "A glowing magic crystal: a cluster of sparkling light-blue gem points, softly glowing. " + THING,
    "background": STYLE + "Inside a cosy witch's cottage at night: stone walls, wooden shelves crowded with "
    "colourful potion bottles and jars, candles, hanging dried herbs, a round window showing a full moon, "
    "a broomstick in the corner and a sleepy black cat on a shelf. Warm candlelight with purple shadows. "
    "Keep the middle and bottom of the picture fairly plain (the cauldron and players go there). No text. "
    "Widescreen 16:9.",
}

if __name__ == "__main__":
    run(ART, HERE, {"cauldron": 768}, strict={"eyeball"})
