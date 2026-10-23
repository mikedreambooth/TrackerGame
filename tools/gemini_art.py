"""Shared Gemini (Vertex AI) art pipeline for the games' art/generate.py scripts.

Each game lists its prompts and calls run(ART, Path(__file__).parent). Images go to
<game>/public/art: "background" as a 1280px-wide JPEG, everything else cut out of its
backdrop as a transparent square PNG. Raw generations are kept in <game>/art/.raw
(git-ignored) so `--cut` can redo the cut-outs without calling the API again.

    tracker/.venv/Scripts/python games/<game>/art/generate.py            # everything
    tracker/.venv/Scripts/python games/<game>/art/generate.py frog       # just one
    tracker/.venv/Scripts/python games/<game>/art/generate.py --cut      # redo cut-outs only

Run with the tracker's Python (it has OpenCV). Auth: your gcloud Application Default
Credentials (`gcloud auth application-default login`); the project comes from
$GOOGLE_CLOUD_PROJECT or `gcloud config get-value project`. Nothing is stored: a
short-lived access token is fetched for each run and kept in memory.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODEL = "gemini-2.5-flash-image"

# A shared look for every game's art.
STYLE = (
    "3D animated movie style like a Pixar film: soft rounded shapes, warm cinematic lighting, "
    "glossy rich colours, expressive and friendly-spooky, suitable for young children (cute, not scary). "
)
# Ask for a plain backdrop so cut_out() can remove it.
ISOLATED = "Plain flat evenly lit single-colour background, no shadow or floor, no text."


def gcloud(*args: str) -> str:
    exe = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if not exe:
        sys.exit("gcloud not found: install the Google Cloud SDK and run `gcloud auth application-default login`.")
    return subprocess.run([exe, *args], check=True, capture_output=True, text=True).stdout.strip()


def generate(prompt: str, token: str, project: str, aspect: str) -> np.ndarray:
    url = f"https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{MODEL}:generateContent"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        res = json.load(r)
    for part in res["candidates"][0]["content"]["parts"]:
        if "inlineData" in part:
            data = np.frombuffer(base64.b64decode(part["inlineData"]["data"]), np.uint8)
            return cv2.imdecode(data, cv2.IMREAD_COLOR)
    raise RuntimeError(f"no image in the response: {json.dumps(res)[:300]}")


def cut_out(img: np.ndarray, size: int = 512, strict: bool = False) -> np.ndarray:
    """Studio backdrop -> transparent. The model ignores "green screen" and paints soft gradient
    backdrops, so flood-fill from the edges while neighbouring pixels change only gently: the
    fill follows the gradient and stops at the subject's crisp outline (so a white ghost on
    a pale backdrop keeps its body). Anything thin it leaves behind (e.g. the outline of a dark
    cape the fill ate into) is opened away; the subject is the biggest blob left.

    strict: the fill may only cover colours seen on the border, so it can't creep into a
    subject whose edge shades softly towards the backdrop (e.g. an eyeball on orange). Don't
    use it for glowing subjects: their halo isn't a border colour, so it stays."""
    h, w = img.shape[:2]
    src = cv2.GaussianBlur(img, (5, 5), 0)
    filled = np.zeros((h + 2, w + 2), np.uint8)
    if strict:
        # Walls: pixels unlike any border colour can't be filled.
        lab = cv2.cvtColor(src, cv2.COLOR_BGR2LAB).astype(np.float32)
        border = np.concatenate([lab[:4].reshape(-1, 3), lab[-4:].reshape(-1, 3), lab[:, :4].reshape(-1, 3), lab[:, -4:].reshape(-1, 3)])
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, _, palette = cv2.kmeans(border, 12, None, crit, 2, cv2.KMEANS_PP_CENTERS)
        near = np.min(np.linalg.norm(lab[:, :, None, :] - palette[None, None], axis=3), axis=2)
        filled[1:-1, 1:-1][near > 16] = 1
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    tol = (2, 2, 2)
    seeds = [(x, y) for x in range(0, w, 16) for y in (0, h - 1)] + [(x, y) for y in range(0, h, 16) for x in (0, w - 1)]
    for x, y in seeds:
        if not filled[y + 1, x + 1]:
            cv2.floodFill(src, filled, (x, y), 0, tol, tol, flags)
    fg = (filled[1:-1, 1:-1] != 255).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    # Keep the biggest blob, fill holes in it, then soften the edge a little.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg)
    if n > 1:
        fg = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    fg = cv2.drawContours(np.zeros_like(fg), contours, -1, 1, cv2.FILLED)
    fg = cv2.erode(fg, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(fg.astype(np.float32), (5, 5), 0)
    out = np.dstack([img, (alpha * 255).astype(np.uint8)])
    # Crop to the character with a little margin, square.
    ys, xs = np.nonzero(alpha > 0.1)
    cx, cy = (xs.min() + xs.max()) // 2, (ys.min() + ys.max()) // 2
    half = int(max(xs.max() - xs.min(), ys.max() - ys.min()) * 0.53)
    pad = cv2.copyMakeBorder(out, half, half, half, half, cv2.BORDER_CONSTANT, value=(0, 0, 0, 0))
    sq = pad[cy : cy + 2 * half, cx : cx + 2 * half]
    return cv2.resize(sq, (size, size), interpolation=cv2.INTER_AREA)


def trim_bars(img: np.ndarray) -> np.ndarray:
    """The model sometimes letterboxes wide images: drop near-black rows top and bottom."""
    rows = np.nonzero(img.max(axis=(1, 2)) > 24)[0]
    return img[rows.min() : rows.max() + 1] if len(rows) else img


def run(art: dict[str, str], here: Path, sizes: dict[str, int] | None = None, strict: set[str] = frozenset()) -> None:
    """Generate (or with --cut, just re-process) the named images, or all of them.
    `strict` names images to cut out with cut_out(strict=True)."""
    out = here.parent / "public" / "art"
    raw = here / ".raw"
    args = sys.argv[1:]
    cut_only = "--cut" in args
    names = [a for a in args if not a.startswith("--")] or list(art)
    out.mkdir(parents=True, exist_ok=True)
    raw.mkdir(exist_ok=True)
    if not cut_only:
        project = os.environ.get("GOOGLE_CLOUD_PROJECT") or gcloud("config", "get-value", "project")
        token = gcloud("auth", "application-default", "print-access-token")
        for name in names:
            print(f"[art] generating {name}...", flush=True)
            img = generate(art[name], token, project, "16:9" if name == "background" else "1:1")
            cv2.imwrite(str(raw / f"{name}.png"), img)
    for name in names:
        img = cv2.imread(str(raw / f"{name}.png"), cv2.IMREAD_COLOR)
        if img is None:
            sys.exit(f"no raw image for {name}: generate it first")
        if name == "background":
            img = trim_bars(img)
            scale = 1280 / img.shape[1]
            img = cv2.resize(img, (1280, round(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(out / "background.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        else:
            size = (sizes or {}).get(name, 512)
            cv2.imwrite(str(out / f"{name}.png"), cut_out(img, size, name in strict), [cv2.IMWRITE_PNG_COMPRESSION, 9])
        print(f"[art] {name} -> {out}", flush=True)
