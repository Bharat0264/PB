"""Make buzz-bee-clay.webp: the Buzz bee's colour texture in the soft clay style of the PrintBee logo mascot.

    python tools/make_clay_bee_texture.py ORIGINAL_BASECOLOR.jpg [buzz-bee-clay.webp]

ORIGINAL_BASECOLOR.jpg is the colour picture inside the model (extract it from buzz-bee.glb, it is the first image). The script keeps the
layout of the picture (so it still fits the model) and only changes the colours: brighter lemon-yellow, creamy wings and bubble, warm near-black
stripes, the lighting that was baked into the picture eased, and a gently smoothed, grain-free surface. Needs numpy, opencv-python and Pillow.
"""
import sys

import cv2
import numpy as np
from PIL import Image


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def clay(source_path, output_path):
    rgb = cv2.cvtColor(cv2.imread(source_path), cv2.COLOR_BGR2RGB)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    h, s, v = hsv[..., 0] * 2, hsv[..., 1] / 255, hsv[..., 2] / 255            # hue in degrees

    dark = 1 - smooth(v, 0.33, 0.52)                                           # stripes, antennae, eyes, headset
    # shiny highlights inside a stripe would turn cream; fill them back to dark so the stripes stay solid, with only a soft sheen
    closed = cv2.morphologyEx((dark > 0.5).astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))).astype(np.float32)
    dark = np.maximum(dark, 0.88 * cv2.GaussianBlur(closed, (0, 0), 0.8))
    hue_ok = smooth(h, 2, 14) * (1 - smooth(h, 62, 78))                         # only real yellows and oranges are recoloured as yellow
    yellow = smooth(s, 0.34, 0.58) * smooth(v, 0.5, 0.72) * hue_ok * (1 - dark)
    white = np.clip(1 - dark - yellow, 0, 1)                                    # wings, bubble, filler and soft shaded greys: all become cream

    yh = h + (44 - h) * 0.55                                                    # pull the orange-gold toward the logo's warm yellow (44 degrees)
    ys = np.clip(0.80 + (s - 0.80) * 0.4, 0, 1)
    yv = np.clip(0.86 + 0.14 * v, 0, 1)
    yel = cv2.cvtColor(np.dstack([yh / 2, ys * 255, yv * 255]).astype(np.uint8), cv2.COLOR_HSV2RGB).astype(np.float32) / 255
    cream = np.array([0.965, 0.93, 0.865], np.float32)
    whi = cream[None, None, :] * (0.80 + 0.20 * np.clip(v / 0.95, 0, 1))[..., None]
    brown = np.array([0.085, 0.055, 0.035], np.float32)
    dar = brown[None, None, :] * (0.7 + 0.9 * v / 0.58).clip(0.7, 1.6)[..., None]

    out = np.clip(sum(w[..., None] * c for w, c in ((yellow, yel), (white, whi), (dark, dar))), 0, 1)
    out8 = cv2.bilateralFilter((out * 255).astype(np.uint8), 7, 28, 6)           # a soft clay surface: no painterly grain, edges kept
    Image.fromarray(out8).save(output_path, quality=93, method=6)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    clay(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "buzz-bee-clay.webp")
    print("saved")
