"""Sword Duel artwork, generated with Gemini. See tools/gemini_art.py for how to run it."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import run  # noqa: E402

LOOK = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich colours, cheerful and friendly, suitable for young children. "
)

ART = {
    "background": LOOK + "A sunny fairytale castle courtyard for a friendly knights' tournament, seen from the side "
    "at eye level: warm sandstone castle walls with towers and battlements in the distance, colourful red and blue "
    "pennant flags and bunting strung across, a blue sky with fluffy clouds, a few cheering villagers far away on "
    "the walls. A wide flat sandy tiltyard floor fills the bottom third of the picture. Keep the middle and bottom "
    "of the picture fairly plain and uncluttered (two cartoon knights will be drawn standing there). "
    "No people in the foreground, no text. Widescreen 16:9.",
}

if __name__ == "__main__":
    run(ART, HERE)
