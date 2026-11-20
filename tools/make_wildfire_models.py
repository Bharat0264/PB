"""Make web-weight copies of the Wildfire 3D models (the originals are left untouched).

    python tools/make_wildfire_models.py [folder with the .glb files] [output folder]

The originals are ~60-70 MB each (1.9 million triangles, three 4096 px pictures). This keeps the model, its pose and its
paint, but ships far less:

  geometry  attribute-aware vertex clustering: vertices that share both a place and a texture position are merged on a grid,
            so UV seams stay seams and the picture still lines up. The grid is chosen to land near the triangle target.
            Normals are the average of the original normals in each cluster.
  pictures  colour, metal/roughness and normal pictures are resized (area averaging) and stored as WebP.
  file      one mesh, one material, WebP textures (EXT_texture_webp), 16-bit indices when they fit.

Needs numpy, opencv-python and Pillow; reuses the GLB reader/writer from tools/bee_glb.py.
"""
import io
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bee_glb as g  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path(r"C:\Users\cheth\Downloads")

# name in Downloads  ->  (output name, triangle target, colour px, metal/rough px, normal px)
MODELS = {
    "wildfire emblem": ("emblem", 140000, 2048, 1024, 2048),
    "wildfire ember particles": ("embers", 40000, 1024, 512, 1024),
    "brass delivery marker": ("marker", 40000, 1024, 512, 1024),
    "forest route signpost": ("signpost", 40000, 1024, 512, 1024),
    "rustic dispatch crate": ("crate", 40000, 1024, 512, 1024),
    "antique printing press": ("press", 50000, 1024, 512, 1024),
    "red timber logs": ("logs", 40000, 1024, 512, 1024),
    "wildfire cargo truck": ("truck", 50000, 1024, 512, 1024),
}


def cluster(position, normal, uv, index, grid):
    """Merge vertices that fall in the same 3D cell and the same UV cell. Returns new arrays.

    Position and normal belong to the 3D cell alone, so the two sides of a texture seam (same place, different UV) land on the
    same point and stay watertight; only the UV is averaged per (cell, UV cell) cluster."""
    low, high = position.min(0), position.max(0)
    size = max((high - low).max(), 1e-9) / grid
    cell = np.floor((position - low) / size).astype(np.int64)
    ucell = np.floor(uv * grid * .4).astype(np.int64)
    _, cell_id = np.unique(cell, axis=0, return_inverse=True)
    cell_id = cell_id.reshape(-1)
    _, inverse = np.unique(np.column_stack([cell, ucell]), axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    cells, count = cell_id.max() + 1, inverse.max() + 1

    def mean(values, ids, size_):
        weight = np.bincount(ids, minlength=size_).astype(np.float64)
        out = np.zeros((size_, values.shape[1]))
        for axis in range(values.shape[1]):
            out[:, axis] = np.bincount(ids, weights=values[:, axis], minlength=size_)
        return out / weight[:, None]
    cell_position, cell_normal = mean(position, cell_id, cells), mean(normal, cell_id, cells)
    length = np.linalg.norm(cell_normal, axis=1)
    cell_normal = cell_normal / np.maximum(length, 1e-9)[:, None]
    new_uv = mean(uv, inverse, count)
    owner = np.zeros(count, np.int64)                    # which 3D cell each cluster sits in
    owner[inverse] = cell_id
    new_position, new_normal = cell_position[owner], cell_normal[owner]
    tri = inverse[index]
    corner = cell_id[index]                               # same cell = same place = no area
    keep = (corner[:, 0] != corner[:, 1]) & (corner[:, 1] != corner[:, 2]) & (corner[:, 0] != corner[:, 2])
    tri = tri[keep]
    ordered = np.sort(tri, axis=1)
    _, first = np.unique(ordered, axis=0, return_index=True)
    tri = tri[np.sort(first)]
    return new_position, new_normal, new_uv, tri


def decimate(position, normal, uv, index, target):
    low, high = 24, 400
    best = None
    for _ in range(9):
        grid = int((low * high) ** .5)
        result = cluster(position, normal, uv, index, grid)
        tris = len(result[3])
        best = result if best is None or abs(tris - target) < abs(len(best[3]) - target) else best
        if abs(tris - target) / target < .08:
            break
        if tris > target:
            high = grid
        else:
            low = grid
    return best


def compact(position, normal, uv, tri):
    """Drop vertices no triangle uses."""
    used = np.zeros(len(position), bool)
    used[tri.reshape(-1)] = True
    remap = np.cumsum(used) - 1
    return position[used], normal[used], uv[used], remap[tri]


def webp(image, size, quality, lossless=False):
    array = np.asarray(image.convert("RGB"))
    if max(array.shape[:2]) > size:
        array = cv2.resize(array, (size, size), interpolation=cv2.INTER_AREA)
    out = io.BytesIO()
    Image.fromarray(array).save(out, "WEBP", quality=quality, method=6, lossless=lossless)
    return out.getvalue()


def build(source, target, tris, colour_px, mr_px, normal_px):
    doc, binary = g.read_glb(source)
    mesh = g.mesh_arrays(doc, binary)
    material = doc["materials"][0]
    pbr = material["pbrMetallicRoughness"]
    textures = doc["textures"]
    pic = lambda ref: g.image(doc, binary, textures[ref["index"]]["source"])  # noqa: E731
    colour = pic(pbr["baseColorTexture"])
    rough = pic(pbr["metallicRoughnessTexture"])
    normal_map = pic(material["normalTexture"])
    print(f"  source: {len(mesh['index']):,} triangles, pictures {colour.size}")

    position, normal, uv, tri = decimate(mesh["position"], mesh["normal"], mesh["uv"], mesh["index"], tris)
    position, normal, uv, tri = compact(position, normal, uv, tri)
    print(f"  kept:   {len(tri):,} triangles, {len(position):,} vertices")

    chunks, views, accessors = [], [], []

    def add(data, target_buffer=None):
        data = data.tobytes() if hasattr(data, "tobytes") else data
        offset = sum(len(c) for c in chunks)
        chunks.append(data + b"\0" * (-len(data) % 4))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target_buffer:
            view["target"] = target_buffer
        views.append(view)
        return len(views) - 1

    pos32 = position.astype(np.float32)
    wide = len(position) > 65535
    idx = tri.astype(np.uint32 if wide else np.uint16).reshape(-1)
    uv16 = np.clip(np.round(uv * 65535), 0, 65535).astype(np.uint16)
    accessors.append({"bufferView": add(pos32, 34962), "componentType": 5126, "count": len(pos32), "type": "VEC3",
                      "min": pos32.min(0).tolist(), "max": pos32.max(0).tolist()})
    accessors.append({"bufferView": add(normal.astype(np.float32), 34962), "componentType": 5126, "count": len(pos32), "type": "VEC3"})
    accessors.append({"bufferView": add(uv16, 34962), "componentType": 5123, "normalized": True, "count": len(pos32), "type": "VEC2"})
    accessors.append({"bufferView": add(idx, 34963), "componentType": 5125 if wide else 5123, "count": len(idx), "type": "SCALAR"})

    images = []
    for data in (webp(colour, colour_px, 84), webp(rough, mr_px, 80), webp(normal_map, normal_px, 92)):
        images.append({"bufferView": add(data), "mimeType": "image/webp"})
    out = {
        "asset": {"version": "2.0", "generator": "PrintBee tools/make_wildfire_models.py"},
        "extensionsUsed": ["EXT_texture_webp"], "extensionsRequired": ["EXT_texture_webp"],
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": Path(target).stem}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}]}],
        "materials": [{"name": Path(target).stem, "pbrMetallicRoughness": {
            "baseColorTexture": {"index": 0}, "metallicRoughnessTexture": {"index": 1}, "metallicFactor": 1, "roughnessFactor": 1},
            "normalTexture": {"index": 2}}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "textures": [{"sampler": 0, "extensions": {"EXT_texture_webp": {"source": i}}} for i in range(3)],
        "images": images, "accessors": accessors, "bufferViews": views,
    }
    g.write_glb(target, out, b"".join(chunks))
    print(f"  wrote {Path(target).name}: {Path(target).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "models" / "wildfire"
    output.mkdir(parents=True, exist_ok=True)
    only = sys.argv[3:] if len(sys.argv) > 3 else None
    for name, (slug, tris, colour_px, mr_px, normal_px) in MODELS.items():
        if only and slug not in only:
            continue
        print(slug)
        build(source / f"{name} 3d model.glb", output / f"{slug}.glb", tris, colour_px, mr_px, normal_px)
