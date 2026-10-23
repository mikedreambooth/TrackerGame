"""Rainbow Kart's launcher icon: pixel art drawn at 40 x 30 and scaled up 10x (400 x 300).

    tracker/.venv/Scripts/python.exe games/kart/art/icon.py
"""

from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
W, H = 40, 30
RAINBOW = ["#ff3b5c", "#ff8c1a", "#ffd51a", "#4be04b", "#1ad4ff", "#3b6bff", "#9b4bff", "#ff4bd8"]


def bgr(hex_: str) -> tuple[int, int, int]:
    r, g, b = (int(hex_[i : i + 2], 16) for i in (1, 3, 5))
    return b, g, r


img = np.zeros((H, W, 3), np.uint8)
img[:] = bgr("#05030f")
rng = np.random.default_rng(4)
for _ in range(14):
    img[rng.integers(0, 12), rng.integers(0, W)] = (255, 220, 230)

# The road, running away to a vanishing point, its rainbow bands narrowing with distance.
horizon, vx = 9, 22
for y in range(horizon, H):
    k = (y - horizon) / (H - horizon)
    half = 2 + k * 30
    for x in range(W):
        u = (x - (vx - half)) / (2 * half)
        if 0 <= u < 1:
            img[y, x] = bgr(RAINBOW[int(u * 8)])
        elif -0.06 <= u < 0 or 1 <= u < 1.06:
            img[y, x] = (255, 255, 255)  # the walls' rails

# The kart, from behind.
red, dark, white = bgr("#ff4d6d"), (40, 30, 30), (255, 255, 255)
img[23:27, 13:27] = red
img[23, 13:27] = bgr("#ff9aae")
img[23:27, 19:21] = white  # racing stripe
img[20:23, 17:23] = bgr("#c23050")  # driver
img[16:20, 17:23] = red  # helmet
img[16, 17:23] = bgr("#ff9aae")
img[21, 11:29] = red  # spoiler
img[22, 12:14] = img[22, 26:28] = dark
for x0 in (10, 27):  # back wheels
    img[24:29, x0 : x0 + 3] = dark
    img[25, x0 : x0 + 3] = (70, 60, 60)
img[27, 17:19] = img[27, 21:23] = (170, 170, 180)  # exhausts

out = cv2.resize(img, (W * 10, H * 10), interpolation=cv2.INTER_NEAREST)
cv2.imwrite(str(HERE.parent / "public" / "icon.png"), out)
print("wrote", HERE.parent / "public" / "icon.png")
