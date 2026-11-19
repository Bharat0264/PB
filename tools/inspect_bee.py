"""Inspect the Buzz bee model and print what is in it and what is wrong with it.

    python tools/inspect_bee.py [buzz-bee.glb]

Reports meshes, triangles, materials, texture sizes, and these problems: normals that are not unit length or that disagree with the faces,
flipped faces (a face whose own normal points against its vertex normals), duplicate vertices, degenerate triangles, stretched UVs (how far a
triangle's size in the texture differs from its size on the model), faceted shading (angle between a face and its smooth normal), small textures,
and the separate pieces of the mesh (the wings, the speech bubble, the eyes...) with their colours.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import bee_glb as g


def analyse(path):
    doc, binary = g.read_glb(path)
    m = g.mesh_arrays(doc, binary)
    pos, nrm, uv, idx = m["position"], m["normal"], m["uv"], m["index"]
    fn, area = g.face_normals(pos, idx)
    report = {"file": str(path), "bytes": Path(path).stat().st_size, "meshes": len(doc["meshes"]), "primitives": sum(len(x["primitives"]) for x in doc["meshes"]),
              "vertices": len(pos), "triangles": len(idx), "materials": [x.get("name", "?") for x in doc.get("materials", [])],
              "textures": [(i, g.image(doc, binary, i).size, g.image(doc, binary, i).mode) for i in range(len(doc.get("images", [])))],
              "extensions": doc.get("extensionsUsed", [])}
    report["degenerate_triangles"] = int((area < 1e-12).sum())
    welded = g.welded_ids(pos)
    report["positions_shared_by_several_vertices"] = int(len(pos) - len(np.unique(welded)))
    keys = np.round(np.hstack([pos, nrm if nrm is not None else np.zeros((len(pos), 0)), uv if uv is not None else np.zeros((len(pos), 0))]), 5)
    report["exact_duplicate_vertices"] = int(len(pos) - len(np.unique(keys, axis=0)))
    if nrm is not None:
        length = np.linalg.norm(nrm, axis=1)
        report["normals_not_unit"] = int((abs(length - 1) > 0.02).sum())
        vertex_avg = nrm[idx].mean(axis=1)
        dots = np.einsum("ij,ij->i", fn, vertex_avg / np.maximum(np.linalg.norm(vertex_avg, axis=1), 1e-30)[:, None])
        report["flipped_faces"] = int((dots < -0.2).sum())
        report["faces_off_their_normals_over_60deg"] = int((dots < 0.5).sum())
        smooth = g.smooth_normals(pos, idx)
        seam = np.einsum("ij,ij->i", nrm, smooth)
        report["vertices_whose_normal_differs_from_smooth_over_20deg"] = int((seam < np.cos(np.radians(20))).sum())
        facet = np.einsum("ij,ij->i", fn, smooth[idx].mean(axis=1) / np.maximum(np.linalg.norm(smooth[idx].mean(axis=1), axis=1), 1e-30)[:, None])
        report["facet_angle_mean_deg"] = round(float(np.degrees(np.arccos(np.clip(facet, -1, 1))).mean()), 1)
    if uv is not None:
        d1, d2 = uv[idx[:, 1]] - uv[idx[:, 0]], uv[idx[:, 2]] - uv[idx[:, 0]]
        a2 = 0.5 * abs(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0])
        ok = (area > 1e-12) & (a2 > 1e-12)
        ratio = np.sqrt(a2[ok] / area[ok])                                   # texture size per model size
        median = np.median(ratio)
        report["uv_density_spread_p5_p95"] = (round(float(np.percentile(ratio / median, 5)), 2), round(float(np.percentile(ratio / median, 95)), 2))
        report["uv_stretched_triangles_over_3x"] = int(((ratio / median > 3) | (ratio / median < 1 / 3)).sum())
        report["triangles_with_no_uv_area"] = int((~(a2 > 1e-12)).sum())
        report["uv_outside_0_1"] = int(((uv < -0.001) | (uv > 1.001)).any(axis=1).sum())
    labels = g.components(pos, idx)
    pieces = []
    base = g.image(doc, binary, 0).convert("RGB")
    pix = np.asarray(base)
    for label in range(labels.max() + 1):
        tri = np.where(labels == label)[0]
        verts = np.unique(idx[tri])
        centre = uv[idx[tri]].mean(axis=1)
        rows = np.clip(centre[:, 1] * (base.height - 1), 0, base.height - 1).astype(int)       # glTF's v runs down the picture, like the rows
        cols = np.clip(centre[:, 0] * (base.width - 1), 0, base.width - 1).astype(int)
        colour = pix[rows, cols].mean(axis=0)
        lo, hi = pos[verts].min(axis=0), pos[verts].max(axis=0)
        pieces.append({"triangles": int(len(tri)), "centre": [round(float(x), 2) for x in (lo + hi) / 2], "size": [round(float(x), 2) for x in hi - lo],
                       "colour": [int(x) for x in colour]})
    report["pieces"] = sorted(pieces, key=lambda p: -p["triangles"])
    return report


def problems(report):
    found = []
    for name, limit in (("degenerate_triangles", 0), ("exact_duplicate_vertices", 0), ("normals_not_unit", 0), ("flipped_faces", 0), ("triangles_with_no_uv_area", 0),
                        ("uv_stretched_triangles_over_3x", 0), ("uv_outside_0_1", 0)):
        if report.get(name, 0) > limit:
            found.append(f"{name} = {report[name]}")
    if report.get("vertices_whose_normal_differs_from_smooth_over_20deg", 0) > 0.02 * report["vertices"]:
        found.append(f"vertices_whose_normal_differs_from_smooth_over_20deg = {report['vertices_whose_normal_differs_from_smooth_over_20deg']} (creases at seams / faceted shading)")
    for index, size, _ in report["textures"]:
        if max(size) < 1024:
            found.append(f"texture {index} is only {size[0]}x{size[1]}")
    if len(report["materials"]) == 1:
        found.append("one material for the whole model: eyes, wings, bubble and body cannot get their own material until the mesh is split")
    return found


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent.parent / "buzz-bee.glb")
    result = analyse(path)
    for key, value in result.items():
        if key != "pieces":
            print(f"{key}: {value}")
    print("pieces of the mesh (by connectivity):")
    for piece in result["pieces"][:14]:
        print("  ", piece)
    if len(result["pieces"]) > 14:
        print(f"   ... and {len(result['pieces']) - 14} more tiny ones")
    print("PROBLEMS:", *problems(result), sep="\n  - " if problems(result) else " none")
