"""Make bee_hq.glb from buzz-bee.glb (which is left untouched).

    python tools/make_bee_hq.py [buzz-bee.glb] [buzz-bee-clay.webp] [bee_hq.glb]

It improves the existing model; it does not remodel it (same vertices, same silhouette, same pose, same colours):

  geometry   fixes the few faces that are wound backwards, and gives the normals one shared direction across UV seams (the creases where the
             texture is cut) while keeping real hard edges. No subdivision: 19,300 triangles with smooth normals is already round, and
             any subdivision would move the silhouette.
  pieces     the one mesh is split into four parts that share the same vertices (eyes, wings, speech bubble, everything else), so each can have
             its own material. The split is by where a triangle is and what colour its texture is; nothing is moved or recoloured.
  textures   the colour picture (the shipped clay one) and the normal map are cleaned (mild noise removal), enlarged to 2048 px with Lanczos,
             gently sharpened without halos, and stored as WebP. The normal map is re-normalised after enlarging, never sharpened.
             Enlarging adds no new drawing: it makes edges smooth when the bee is shown big or on a high-density screen.
  materials  four named glTF materials that carry only the pictures. Every number (clearcoat, roughness, transmission...) lives in one place,
             BEE_LOOK in buzz-bee3d.js.
  not done   Draco compression: the mesh is only about 300 KB, and Draco would need its decoder shipped with the page. gltf-transform was not
             run because it has to be downloaded from npm; WebP compression is done here instead.

Needs numpy, opencv-python and Pillow.
"""
import io
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import bee_glb as g

TEXTURE_SIZE = 2048                    # 2048 or 4096
SHARPEN = 0.55                         # unsharp amount; the result is clamped to the neighbourhood, so there are no halos
DENOISE = 2.0                          # mild
PIECES = ("body", "eyes", "wings", "bubble")


# ---- geometry ---------------------------------------------------------------------------------------------------

def fix_flipped(position, normal, index):
    """Reverse the winding of faces that point against both their own vertex normals and the shared smooth normal."""
    fn, _ = g.face_normals(position, index)
    own = normal[index].mean(axis=1)
    own /= np.maximum(np.linalg.norm(own, axis=1), 1e-30)[:, None]
    shared = g.smooth_normals(position, index)[index].mean(axis=1)
    shared /= np.maximum(np.linalg.norm(shared, axis=1), 1e-30)[:, None]
    flipped = (np.einsum("ij,ij->i", fn, own) < -0.2) & (np.einsum("ij,ij->i", fn, shared) < 0)
    fixed = index.copy()
    fixed[flipped] = fixed[flipped][:, [0, 2, 1]]
    return fixed, int(flipped.sum())


def seam_normals(position, normal, index, crease_degrees=50):
    """Vertices at the same place (a UV seam) get the same smooth normal, unless the faces around them really meet at a hard edge."""
    ids = g.welded_ids(position)
    fn, area = g.face_normals(position, index)
    count = ids.max() + 1
    mean = np.zeros((count, 3))
    for k in range(3):
        np.add.at(mean, ids[index[:, k]], fn * area[:, None])
    mean /= np.maximum(np.linalg.norm(mean, axis=1), 1e-30)[:, None]
    worst = np.ones(count)
    for k in range(3):
        np.minimum.at(worst, ids[index[:, k]], np.einsum("ij,ij->i", fn, mean[ids[index[:, k]]]))
    smooth = g.smooth_normals(position, index)
    soft = worst[ids] > np.cos(np.radians(crease_degrees))
    shared = (np.bincount(ids)[ids] > 1)
    use = soft & shared
    out = normal.copy()
    out[use] = smooth[use]
    return out, int(use.sum())


def classify(position, uv, index, base):
    """0 body, 1 eyes, 2 wings, 3 bubble. By place and by the picture's colour at each triangle's centre (see the notes at the top)."""
    cen = position[index].mean(axis=1)
    rows = np.clip(uv[index].mean(axis=1)[:, 1] * (base.shape[0] - 1), 0, base.shape[0] - 1).astype(int)
    cols = np.clip(uv[index].mean(axis=1)[:, 0] * (base.shape[1] - 1), 0, base.shape[1] - 1).astype(int)
    c = base[rows, cols].astype(float) / 255
    value, low = c.max(axis=1), c.min(axis=1)
    sat = (value - low) / np.maximum(value, 1e-6)
    cream = (value > 0.62) & (sat < 0.30)
    soft = (value > 0.45) & (sat < 0.45)
    cls = np.zeros(len(index), int)
    cls[cream & (cen[:, 2] < -0.02)] = 2                                                         # cream and behind the body: wings
    cls[soft & (cen[:, 2] >= 0.0) & (cen[:, 1] < 0.47) & (cen[:, 0] > -0.02)] = 3                # pale, in front, low, to the right: the bubble
    for side in (-1, 1):                                                                         # the two eyes: an oval on the front of the face
        d = np.hypot((cen[:, 0] - side * 0.11) / 0.05, (cen[:, 1] - 0.585) / 0.063)
        cls[(d < 1) & (cen[:, 2] > 0.2)] = 1
    # The wings are two separate, mostly pale pieces out to the sides and behind. Pale paint highlights on the head, headphones and antennae
    # are NOT wings (they used to be drawn with the see-through glassy wing material, which showed as white blotches), so a pale triangle only
    # stays a wing if the whole texture island it belongs to is pale, it sits well out to the side, and it is behind the body.
    parent = np.arange(len(position))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a_, b_, c_ in index:
        for u, v in ((a_, b_), (b_, c_)):
            ru, rv = find(u), find(v)
            if ru != rv:
                parent[ru] = rv
    _, island = np.unique([find(i) for i in index[:, 0]], return_inverse=True)
    for part in range(island.max() + 1):
        mine = island == part
        if not (cls[mine] == 2).any():
            continue
        pure = (cls[mine] == 2).mean()
        out_wide = np.abs(cen[mine][:, 0]).mean() > 0.14
        behind = cen[mine][:, 2].mean() < -0.18
        if not (pure >= 0.85 and out_wide and behind):
            cls[mine & (cls == 2)] = 0
    ids = g.welded_ids(position)                                                                 # fill: the dots inside the bubble, the veins in the wings
    for _ in range(3):
        votes = np.zeros((ids.max() + 1, 4))
        for k in range(3):
            np.add.at(votes, (ids[index[:, k]], cls), 1)
        share = votes[ids[index]].sum(axis=1)
        for part in (3, 2):
            fraction = share[:, part] / np.maximum(share.sum(axis=1), 1)
            cls[(cls == 0) & (fraction > 0.85)] = part
    return cls


# ---- textures ---------------------------------------------------------------------------------------------------

def enlarge_colour(img, size=TEXTURE_SIZE):
    rgb = np.asarray(img.convert("RGB"))
    clean = cv2.fastNlMeansDenoisingColored(rgb, None, DENOISE, DENOISE, 5, 15)
    big = cv2.resize(clean, (size, size), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
    blur = cv2.GaussianBlur(big, (0, 0), 1.6)
    sharp = big + SHARPEN * (big - blur)
    kernel = np.ones((5, 5), np.uint8)
    top = cv2.dilate(big, kernel) + 4                                   # never brighter or darker than the neighbourhood: no halo
    bottom = cv2.erode(big, kernel) - 4
    return Image.fromarray(np.clip(np.minimum(np.maximum(sharp, bottom), top), 0, 255).astype(np.uint8))


HONEY, INK, ORANGE, WHITE, CREAM = (245, 197, 66), (42, 33, 18), (245, 160, 75), (255, 255, 255), (255, 248, 232)


def uv_classes(uv, index, cls, size):
    """Paint every triangle's class into the picture's own space (class number + 1; 0 = not used by any triangle)."""
    label = np.zeros((size, size), np.uint8)
    for k in range(len(index)):
        pts = np.round(uv[index[k]] * (size - 1)).astype(np.int32)
        cv2.fillConvexPoly(label, pts, int(cls[k]) + 1)
    return cv2.dilate(label, np.ones((5, 5), np.uint8))                      # a little past each chart's edge, so mip-mapping never shows the old colours


def nearest_fill(labels, known):
    """For every pixel not `known`, the label of the nearest known pixel."""
    _, nearest = cv2.distanceTransformWithLabels((~known).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(known)
    lookup = np.zeros(nearest.max() + 1, labels.dtype)
    lookup[nearest[ys, xs]] = labels[ys, xs]
    return lookup[nearest]


def solid_colours(img, classes):
    """Clean, evenly filled colour: the painted-in highlights, shading and speckle of the original picture are replaced by flat palette colours.
    body: honey yellow / ink (dark brown-black) / soft orange cheeks and tongue; bubble: white with ink dots; wings: cream; eyes: left as drawn.
    Each flat area is decided at 2048 px and its edge is softened by about 1 px, so the edges stay crisp and round."""
    rgb = np.asarray(img.convert("RGB")).astype(np.float32) / 255
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)                                   # hue 0-360, saturation and value 0-1
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    out = rgb.copy()

    def paint(region, parts):
        """parts: list of (confident mask, colour). Everything unsure inside `region` takes the colour of the nearest sure pixel."""
        sure = np.zeros(region.shape, bool)
        which = np.zeros(region.shape, np.uint8)
        for number, (mask, _) in enumerate(parts, 1):
            take = mask & region & ~sure
            which[take] = number
            sure |= take
        if not sure.any():
            return
        which = np.where(region, nearest_fill(which, sure), 0)
        for number, (_, colour) in enumerate(parts, 1):
            weight = cv2.GaussianBlur(((which == number) & region).astype(np.float32), (0, 0), 1.1)
            out[...] = np.where(((which == number) & region)[..., None] | (weight[..., None] > 0) & region[..., None],
                                out * (1 - weight[..., None]) + np.array(colour, np.float32) / 255 * weight[..., None], out)

    body = classes == 1
    dark = val < 0.36
    orange = (hue < 33) & (sat > 0.42) & (val > 0.62)
    yellow = (hue >= 33) & (hue < 70) & (sat > 0.40) & (val > 0.55)
    paint(body, [(dark, INK), (yellow, HONEY), (orange, ORANGE)])
    bubble = classes == 4
    paint(bubble, [(val < 0.42, INK), (val > 0.72, WHITE)])
    paint(classes == 3, [(np.ones(val.shape, bool), CREAM)])
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8))


def bake_from_source(position, normal, uv, index, source_path, size=TEXTURE_SIZE, neighbours=10):
    """Colour picture from the high-resolution original (1.9 million triangles, 4096 px picture; same shape and place as this model).
    For every texel of THIS model's picture: find where that texel sits on the surface, find the nearest points of the original (that face the
    same way, so a wing never borrows the body behind it) and take their colour. The result is the original's own clean, painted colours
    at this model's 19k triangles, with no guessing and no recolouring."""
    from scipy.spatial import cKDTree
    doc, binary = g.read_glb(source_path)
    attrs = doc["meshes"][0]["primitives"][0]["attributes"]
    spos = g.accessor(doc, binary, attrs["POSITION"]).astype(np.float64)
    snor = g.accessor(doc, binary, attrs["NORMAL"]).astype(np.float64)
    suv = g.accessor(doc, binary, attrs["TEXCOORD_0"]).astype(np.float64)
    picture = np.asarray(g.image(doc, binary, doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]).convert("RGB"))
    h, w = picture.shape[:2]
    # the colour of every vertex of the original, read from its picture (bilinear)
    fx, fy = suv[:, 0] * (w - 1), suv[:, 1] * (h - 1)
    x0, y0 = np.clip(np.floor(fx).astype(int), 0, w - 2), np.clip(np.floor(fy).astype(int), 0, h - 2)
    tx, ty = (fx - x0)[:, None], (fy - y0)[:, None]
    pic = picture.astype(np.float32)
    vertex_colour = ((pic[y0, x0] * (1 - tx) + pic[y0, x0 + 1] * tx) * (1 - ty) + (pic[y0 + 1, x0] * (1 - tx) + pic[y0 + 1, x0 + 1] * tx) * ty)
    tree = cKDTree(spos)

    # where every texel of this model's picture sits on the surface (position and normal, by barycentric weights)
    xs, ys, tri_of = [], [], []
    wa, wb, wc = [], [], []
    pix = uv * (size - 1)
    for k in range(len(index)):
        p = pix[index[k]]
        x0, y0 = np.floor(p.min(axis=0)).astype(int) - 1
        x1, y1 = np.ceil(p.max(axis=0)).astype(int) + 1
        gx, gy = np.meshgrid(np.arange(max(x0, 0), min(x1, size - 1) + 1), np.arange(max(y0, 0), min(y1, size - 1) + 1))
        gx, gy = gx.ravel(), gy.ravel()
        d = (p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) + (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1])
        if abs(d) < 1e-9:
            continue
        a_ = ((p[1, 1] - p[2, 1]) * (gx - p[2, 0]) + (p[2, 0] - p[1, 0]) * (gy - p[2, 1])) / d
        b_ = ((p[2, 1] - p[0, 1]) * (gx - p[2, 0]) + (p[0, 0] - p[2, 0]) * (gy - p[2, 1])) / d
        c_ = 1 - a_ - b_
        inside = (a_ >= -0.02) & (b_ >= -0.02) & (c_ >= -0.02)
        xs.append(gx[inside]); ys.append(gy[inside]); tri_of.append(np.full(inside.sum(), k))
        wa.append(a_[inside]); wb.append(b_[inside]); wc.append(c_[inside])
    xs, ys, tri_of = np.concatenate(xs), np.concatenate(ys), np.concatenate(tri_of)
    wa, wb, wc = np.concatenate(wa)[:, None], np.concatenate(wb)[:, None], np.concatenate(wc)[:, None]
    corners = index[tri_of]
    point = wa * position[corners[:, 0]] + wb * position[corners[:, 1]] + wc * position[corners[:, 2]]
    facing = wa * normal[corners[:, 0]] + wb * normal[corners[:, 1]] + wc * normal[corners[:, 2]]
    facing /= np.maximum(np.linalg.norm(facing, axis=1, keepdims=True), 1e-9)

    colour = np.zeros((len(point), 3), np.float32)
    for start in range(0, len(point), 400000):
        chunk = slice(start, start + 400000)
        dist, near = tree.query(point[chunk], k=neighbours)
        same_way = np.einsum("nkj,nj->nk", snor[near], facing[chunk]) > 0.35
        rank = np.where(same_way, dist, np.inf)                      # nearest neighbour that faces the same way (else just the nearest)
        pick = np.where(np.isfinite(rank.min(axis=1)), rank.argmin(axis=1), 0)
        chosen = near[np.arange(len(near)), pick]
        close = np.take_along_axis(dist, pick[:, None], 1)[:, 0]
        weight = 1 / (1 + (dist / np.maximum(close[:, None], 1e-6) - 1) * 6)       # blend in near-equal neighbours so the colour is smooth, not blocky
        weight = np.where(same_way | ~same_way.any(axis=1, keepdims=True), weight, 0)
        colour[chunk] = (vertex_colour[near] * weight[..., None]).sum(axis=1) / np.maximum(weight.sum(axis=1, keepdims=True), 1e-9)
    out = np.zeros((size, size, 3), np.float32)
    covered = np.zeros((size, size), bool)
    out[ys, xs] = colour
    covered[ys, xs] = True
    # a few pixels of the same colours past every chart's edge, so mip-mapping and filtering never pull in grey
    _, nearest = cv2.distanceTransformWithLabels((~covered).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    fy, fx = np.nonzero(covered)
    lookup_y = np.zeros(nearest.max() + 1, int); lookup_x = np.zeros(nearest.max() + 1, int)
    lookup_y[nearest[fy, fx]] = fy; lookup_x[nearest[fy, fx]] = fx
    out = out[lookup_y[nearest], lookup_x[nearest]]
    print(f"baked colours from {source_path}: {len(point):,} texels from {len(spos):,} source vertices")
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8))


def enlarge_normal(img, size=TEXTURE_SIZE):
    n = np.asarray(img.convert("RGB")).astype(np.float32) / 255 * 2 - 1
    big = cv2.resize(n, (size, size), interpolation=cv2.INTER_CUBIC)
    big /= np.maximum(np.linalg.norm(big, axis=2, keepdims=True), 1e-6)
    return Image.fromarray(np.clip((big * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8))


def webp(img, quality):
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=quality, method=6)
    return out.getvalue()


# ---- writing -----------------------------------------------------------------------------------------------------

def build(source, clay_path, target, original=None):
    doc, binary = g.read_glb(source)
    m = g.mesh_arrays(doc, binary)
    position, normal, uv, index = m["position"], m["normal"], m["uv"], m["index"]
    base_for_classes = np.asarray(Image.open(clay_path).convert("RGB").resize((512, 512)))
    index, flipped = fix_flipped(position, normal, index)
    normal, seamed = seam_normals(position, normal, index)
    normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-30)[:, None]
    cls = classify(position, uv, index, base_for_classes)
    material_index = {name: i for i, name in enumerate(PIECES)}

    if original:                                            # the high-resolution original is there: bake its clean painted colours
        colour = bake_from_source(position, normal, uv, index, original)
    else:                                                   # otherwise: the enlarged old picture, repainted as flat palette colours
        colour = enlarge_colour(Image.open(clay_path))
        colour = solid_colours(colour, uv_classes(uv, index, cls, TEXTURE_SIZE))
    original = {i: g.image(doc, binary, i) for i in range(len(doc["images"]))}
    normal_source = doc["textures"][doc["materials"][0]["normalTexture"]["index"]]["source"]
    normal_map = enlarge_normal(original[normal_source])
    pictures = [webp(colour, 90), webp(normal_map, 92)]

    chunks, views, accessors = [], [], []

    def add(data, target_kind=None):
        pad = -sum(len(c) for c in chunks) % 4
        if pad:
            chunks.append(b"\0" * pad)
        views.append({"buffer": 0, "byteOffset": sum(len(c) for c in chunks), "byteLength": len(data), **({"target": target_kind} if target_kind else {})})
        chunks.append(bytes(data))
        return len(views) - 1

    def accessor(view, kind, component, count, **extra):
        accessors.append({"bufferView": view, "componentType": component, "count": count, "type": kind, **extra})
        return len(accessors) - 1

    pos32 = position.astype(np.float32)
    a_pos = accessor(add(pos32.tobytes(), 34962), "VEC3", 5126, len(pos32), min=pos32.min(axis=0).tolist(), max=pos32.max(axis=0).tolist())
    a_nrm = accessor(add(normal.astype(np.float32).tobytes(), 34962), "VEC3", 5126, len(normal))
    a_uv = accessor(add(uv.astype(np.float32).tobytes(), 34962), "VEC2", 5126, len(uv))
    primitives = []
    for name in PIECES:
        triangles = index[cls == material_index[name]]
        if not len(triangles):
            continue
        a_idx = accessor(add(triangles.astype(np.uint16).tobytes(), 34963), "SCALAR", 5123, triangles.size)
        primitives.append({"attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv}, "indices": a_idx, "material": material_index[name], "mode": 4})
    image_views = [add(p) for p in pictures]

    out = {
        "asset": {"version": "2.0", "generator": "tools/make_bee_hq.py", "copyright": "Made from buzz-bee.glb"},
        "extensionsUsed": ["EXT_texture_webp"], "extensionsRequired": ["EXT_texture_webp"],
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": "bee", "mesh": 0}],
        "meshes": [{"name": "bee", "primitives": primitives}],
        "materials": [{"name": name, "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.5}, "normalTexture": {"index": 1}}
                      for name in PIECES],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "textures": [{"sampler": 0, "extensions": {"EXT_texture_webp": {"source": i}}} for i in range(2)],
        "images": [{"bufferView": v, "mimeType": "image/webp", "name": n} for v, n in zip(image_views, ("colour", "normal"))],
        "accessors": accessors, "bufferViews": views,
    }
    g.write_glb(target, out, b"".join(chunks))
    counts = {name: int((cls == material_index[name]).sum()) for name in PIECES}
    print(f"flipped faces fixed: {flipped}; vertices given a shared seam normal: {seamed}; triangles per piece: {counts}")
    print(f"textures: colour and normal {TEXTURE_SIZE}x{TEXTURE_SIZE} WebP ({len(pictures[0]) // 1024} KB and {len(pictures[1]) // 1024} KB); wrote {target} ({Path(target).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    root = Path(__file__).parent.parent
    args = [a for a in sys.argv[1:] if not a.startswith("--source=")]
    original = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--source=")), None)
    build(args[0] if args else root / "buzz-bee.glb", args[1] if len(args) > 1 else root / "buzz-bee-clay.webp", args[2] if len(args) > 2 else root / "bee_hq.glb", original)
