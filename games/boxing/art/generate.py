"""Boxing artwork, generated with Gemini. See tools/gemini_art.py for how to run it."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, run  # noqa: E402

STYLE = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich saturated colours, cheerful and playful, suitable for young children. "
)
THING = "A single object on its own, centered, filling about 80% of the image, nothing else in the picture. " + ISOLATED


def glove(colour: str) -> str:
    return (
        STYLE + f"A single shiny {colour} leather boxing glove seen exactly side-on in profile, pointing to the RIGHT: "
        "the rounded padded fist on the right, the white wrist cuff with lacing on the left. Floating, no ground, "
        "no shadow, no hand or arm. " + THING
    )


def head(colour: str) -> str:
    return (
        STYLE + f"The head of a cute cheerful cartoon kid boxer seen exactly side-on in profile, facing to the RIGHT, "
        f"wearing a padded {colour} boxing headguard that covers the top and back of the head and the cheek, "
        "a big friendly eye, a determined happy grin. Just the head, no neck, no body, floating, no shadow. " + THING
    )


ART = {
    "background": STYLE + "Inside a big friendly boxing arena, seen from ringside at eye level. A boxing ring "
    "fills the picture: a flat light blue-grey canvas ring floor across the bottom third, three ring ropes (red, "
    "white and blue) stretched straight across from a red corner post on the far left to a blue corner post on the "
    "far right. Behind it a cheering cartoon crowd in dim stands, colourful banners and flags, and warm golden "
    "spotlights shining down from the roof. Keep the middle and lower middle of the ring plain and uncluttered "
    "(two cartoon boxers will be drawn standing there). No people in the ring, no text. Widescreen 16:9.",
    "glove_red": glove("bright red"),
    "glove_blue": glove("bright blue"),
    "head_red": head("bright red"),
    "head_blue": head("bright blue"),
    "pow": STYLE + "A comic-book impact burst: a big spiky jagged explosion star shape, bright yellow in the "
    "middle fading to orange and red at the spiky tips, with a thick dark outline. Flat, no text, no letters. " + THING,
    "star": STYLE + "A cute glossy golden yellow star with five rounded points, sparkling. Floating, no shadow. " + THING,
    "belt": STYLE + "A shiny champion's boxing belt: a wide red leather strap with a big round gold buckle plate in "
    "the middle set with a red jewel and a gold star, seen from the front, laid out in a gentle curve. "
    "Floating, no shadow, no text, no letters. " + THING,
}

if __name__ == "__main__":
    run(ART, HERE, {"glove_red": 256, "glove_blue": 256, "head_red": 384, "head_blue": 384, "star": 128, "pow": 384, "belt": 512})
