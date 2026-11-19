"""Small stdlib + numpy GLB reader and writer for the Buzz bee, and the mesh analysis used by tools/inspect_bee.py and tools/make_bee_hq.py.

Only what this one model needs: one mesh, one primitive, POSITION / NORMAL / TEXCOORD_0 and uint16 or uint32 indices, textures stored as images in the file.
"""
import io
import json
import struct

import numpy as np
from PIL import Image

JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942
DTYPES = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    data = open(path, "rb").read()
    magic, version, _ = struct.unpack("<4sII", data[:12])
    if magic != b"glTF" or version != 2:
        raise ValueError("not a GLB 2 file")
    pos, doc, binary = 12, None, b""
    while pos < len(data):
        size, kind = struct.unpack("<II", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + size]
        pos += 8 + size
        if kind == JSON_CHUNK:
            doc = json.loads(chunk)
        elif kind == BIN_CHUNK:
            binary = chunk
    return doc, binary


def accessor(doc, binary, index):
    spec = doc["accessors"][index]
    view = doc["bufferViews"][spec["bufferView"]]
    dtype, width = DTYPES[spec["componentType"]], WIDTH[spec["type"]]
    start = view.get("byteOffset", 0) + spec.get("byteOffset", 0)
    stride = view.get("byteStride") or dtype().itemsize * width
    count = spec["count"]
    raw = np.frombuffer(binary, dtype=np.uint8, count=(count - 1) * stride + dtype().itemsize * width, offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(count, dtype().itemsize * width), strides=(stride, 1))
    out = np.ascontiguousarray(rows).view(dtype).reshape(count, width)
    return out[:, 0] if width == 1 else out


def image(doc, binary, index):
    view = doc["bufferViews"][doc["images"][index]["bufferView"]]
    start = view.get("byteOffset", 0)
    return Image.open(io.BytesIO(binary[start:start + view["byteLength"]]))


def mesh_arrays(doc, binary):
    primitives = doc["meshes"][0]["primitives"]
    attrs = primitives[0]["attributes"]               # the pieces of the bee share one set of vertices
    return {"position": accessor(doc, binary, attrs["POSITION"]).astype(np.float64),
            "normal": accessor(doc, binary, attrs["NORMAL"]).astype(np.float64) if "NORMAL" in attrs else None,
            "uv": accessor(doc, binary, attrs["TEXCOORD_0"]).astype(np.float64) if "TEXCOORD_0" in attrs else None,
            "index": np.vstack([accessor(doc, binary, p["indices"]).astype(np.int64).reshape(-1, 3) for p in primitives])}


def write_glb(path, doc, binary):
    """doc must already point at `binary` through buffers[0] (its byteLength is set here)."""
    doc["buffers"] = [{"byteLength": len(binary)}]
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    with open(path, "wb") as out:
        out.write(struct.pack("<4sII", b"glTF", 2, total))
        out.write(struct.pack("<II", len(text), JSON_CHUNK) + text)
        out.write(struct.pack("<II", len(binary), BIN_CHUNK) + binary)


# ---- analysis ------------------------------------------------------------------------------------------------------

def welded_ids(position, decimals=5):
    """Index of the first vertex at each distinct position: vertices that share a place (UV seams) get the same id."""
    keys = np.round(position, decimals)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    return inverse.reshape(-1)


def components(position, index):
    """Connected pieces of the mesh (by position, so UV seams do not split a piece). Returns an array: piece number for every triangle."""
    ids = welded_ids(position)
    parent = np.arange(ids.max() + 1)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b, c in ids[index]:
        for u, v in ((a, b), (b, c)):
            ru, rv = find(u), find(v)
            if ru != rv:
                parent[ru] = rv
    roots = np.array([find(i) for i in ids[index][:, 0]])
    _, labels = np.unique(roots, return_inverse=True)
    return labels


def face_normals(position, index):
    a, b, c = (position[index[:, i]] for i in range(3))
    cross = np.cross(b - a, c - a)
    length = np.linalg.norm(cross, axis=1)
    return cross / np.maximum(length, 1e-30)[:, None], length / 2


def smooth_normals(position, index):
    """Area- and angle-weighted vertex normals, shared across UV seams (vertices at the same place), so there is no visible crease at a seam."""
    ids = welded_ids(position)
    count = ids.max() + 1
    accum = np.zeros((count, 3))
    a, b, c = (position[index[:, i]] for i in range(3))
    cross = np.cross(b - a, c - a)
    for k, (p, q, r) in enumerate(((a, b, c), (b, c, a), (c, a, b))):
        e1, e2 = q - p, r - p
        cos = np.einsum("ij,ij->i", e1, e2) / np.maximum(np.linalg.norm(e1, axis=1) * np.linalg.norm(e2, axis=1), 1e-30)
        angle = np.arccos(np.clip(cos, -1, 1))
        np.add.at(accum, ids[index[:, k]], cross * angle[:, None] / np.maximum(np.linalg.norm(cross, axis=1), 1e-30)[:, None])
    length = np.linalg.norm(accum, axis=1)
    shared = accum / np.maximum(length, 1e-30)[:, None]
    return shared[ids]
