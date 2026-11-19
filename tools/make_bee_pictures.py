"""Make the Buzz bee's still pictures (buzz-bee-<pose>-1x/2x/3x.webp) from three 648 px transparent renders of the 3D bee.

    python tools/make_bee_pictures.py RENDER_DIR [OUT_DIR]

RENDER_DIR holds pose-idle-648.png, pose-wave-648.png and pose-typing-648.png: the page draws them with
    bee.exportPose('idle' | 'wave' | 'typing')    (buzz-bee3d.js, created with {exact: true, pixelRatio: 1})
so all three poses share the same canvas size, camera and anchor, and swapping between them never jumps or clips.

What this script adds: it checks that no pose touches the picture edge; it removes any dark fringe from the soft edge pixels (their colour is
re-taken from the solid pixels just inside, so there is no halo on cream or on dark backgrounds); and it shrinks each pose to 324 px (3x),
216 px (2x) and 108 px (1x) with Lanczos on premultiplied colour, so the edges stay clean. Needs numpy, opencv-python and Pillow.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

POSES = ("idle", "wave", "typing")
SIZES = {"1x": 108, "2x": 216, "3x": 324}          # the launcher shows the bee 108 px wide (96 px on phones)


def defringe(rgba):
    """Replace the colour of every soft edge pixel by the colour of the solid pixels next to it."""
    rgb = rgba[..., :3].astype(np.float32)
    alpha = rgba[..., 3]
    solid = (alpha >= 250).astype(np.float32)
    weight = cv2.GaussianBlur(solid, (0, 0), 3)
    near = cv2.GaussianBlur(rgb * solid[..., None], (0, 0), 3) / np.maximum(weight, 1e-4)[..., None]
    soft = ((alpha > 0) & (alpha < 250))[..., None]
    out = np.where(soft & (weight[..., None] > 0.02), rgb * 0.25 + near * 0.75, rgb)
    return np.dstack([np.clip(out, 0, 255).astype(np.uint8), alpha])


def border_alpha(rgba, band=12):
    """The strongest picture in the outer `band` pixels (12 of 648 is about 2 px at the smallest size): 0 means a clear margin all round."""
    a = rgba[..., 3]
    return int(max(a[:band].max(), a[-band:].max(), a[:, :band].max(), a[:, -band:].max()))


def main(render_dir, out_dir):
    for pose in POSES:
        source = np.array(Image.open(Path(render_dir) / f"pose-{pose}-648.png").convert("RGBA"))
        edge = border_alpha(source)
        ys, xs = np.nonzero(source[..., 3] > 8)
        print(f"{pose}: edge alpha {edge}, bee spans x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()} of {source.shape[1]}")
        if edge:
            raise SystemExit(f"{pose} touches the edge of its picture: make the bee smaller or the canvas bigger")
        clean = Image.fromarray(defringe(source))
        for label, size in SIZES.items():
            target = Path(out_dir) / f"buzz-bee-{pose}-{label}.webp"
            clean.resize((size, size), Image.LANCZOS).save(target, quality=92, alpha_quality=100, method=6)
            print("  ", target.name, size, target.stat().st_size)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ".")
