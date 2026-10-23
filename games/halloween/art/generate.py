"""Halloween Heads artwork, generated with Gemini. See tools/gemini_art.py for how to run it."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tools"))
from gemini_art import ISOLATED, STYLE, run  # noqa: E402

HEAD = (
    "A single character head and neck only, seen straight from the front, looking at the camera, "
    "centered, filling about 85% of the image, nothing else in the picture. "
    + ISOLATED
)

ART = {
    "pumpkin": STYLE + "A carved jack-o'-lantern pumpkin head with a big toothy grin and triangle eyes, "
    "warm candle glow inside, a curly green stem on top. " + HEAD,
    "skull": STYLE + "A cute cartoon skull head with big round dark eye sockets, a cheeky grin with "
    "chunky teeth and a small crack on the forehead, ivory bone colour. " + HEAD,
    "ghost": STYLE + "A friendly round white sheet-ghost head with big black oval eyes and a small "
    "surprised 'oo' mouth, softly glowing, slightly see-through at the edges. " + HEAD,
    "vampire": STYLE + "A cartoon vampire head: pale lavender skin, slicked-back black hair with a "
    "widow's peak, red eyes with a mischievous smile showing two little fangs, and a tall black "
    "cape collar lined with red behind the head. " + HEAD,
    "background": STYLE + "A wide Halloween night scene: a big glowing full moon, a crooked haunted "
    "house on a hill with warm lit windows, bare twisty trees, a little graveyard with friendly "
    "tombstones, carved pumpkins, bats and soft purple fog. Deep purple and blue night sky. "
    "Keep the middle of the picture fairly plain and dark (game characters go there). No text. "
    "Widescreen 16:9.",
}


if __name__ == "__main__":
    run(ART, HERE, strict={"pumpkin"})
