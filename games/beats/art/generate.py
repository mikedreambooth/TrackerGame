"""Beat Bash artwork, generated with Gemini. See tools/gemini_art.py for how to run it."""

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

ART = {
    "background": STYLE + "A cheerful neon disco concert stage at night seen from the audience: a dark deep purple "
    "and navy stage, rows of colourful spotlights and neon light strips along the top and the far edges, "
    "big loudspeaker stacks at the far left and far right, soft beams of pink, cyan and purple light, "
    "a shiny dark dance floor at the bottom. The middle of the picture is dark and fairly plain (players "
    "and glowing notes are drawn there). Dark overall, moody night lighting. No people, no text. Widescreen 16:9.",
    "discoball": STYLE + "A shiny silver mirror disco ball with sparkling square mirror tiles catching pink and "
    "blue light, a short silver hook on top, floating, no ground, no shadow. " + THING,
    "speaker": STYLE + "A chunky cartoon loudspeaker cabinet seen from the front: a glossy purple box with one big "
    "woofer cone and one small round tweeter above it, gold trim, standing upright, floating, no ground, no shadow, "
    "on a plain light grey background. " + THING,
    "star": STYLE + "A single shiny golden five-pointed star with soft rounded points and a happy glossy shine, "
    "facing the viewer, flat-on, floating, no ground, no shadow, on a plain dark blue background. " + THING,
}

if __name__ == "__main__":
    run(ART, HERE, {"discoball": 384, "speaker": 512, "star": 256}, strict={"speaker"})
