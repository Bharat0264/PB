"""bee_hq.glb: the improved bee must be the same bee (same vertices and silhouette), better made, and the original must be untouched."""
import re
import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np

root = Path(__file__).parent
sys.path.insert(0, str(root / "tools"))
import bee_glb as g
import inspect_bee


class BeeHq(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old_doc, cls.old_bin = g.read_glb(root / "buzz-bee.glb")
        cls.new_doc, cls.new_bin = g.read_glb(root / "bee_hq.glb")
        cls.old = g.mesh_arrays(cls.old_doc, cls.old_bin)
        cls.new = g.mesh_arrays(cls.new_doc, cls.new_bin)

    def test_same_vertices_same_silhouette_same_uvs(self):
        np.testing.assert_allclose(self.new["position"], self.old["position"], atol=1e-6)
        np.testing.assert_allclose(self.new["uv"], self.old["uv"], atol=1e-6)
        self.assertEqual(self.new["index"].shape, self.old["index"].shape)           # no triangle added or lost: no subdivision, nothing remodelled

    def test_every_triangle_is_in_exactly_one_piece(self):
        key = lambda idx: {tuple(sorted(t)) for t in idx.tolist()}
        self.assertEqual(key(self.new["index"]), key(self.old["index"]))

    def test_four_named_pieces_that_share_the_vertices(self):
        primitives = self.new_doc["meshes"][0]["primitives"]
        self.assertEqual([self.new_doc["materials"][p["material"]]["name"] for p in primitives], ["body", "eyes", "wings", "bubble"])
        self.assertEqual(len({p["attributes"]["POSITION"] for p in primitives}), 1)
        counts = {self.new_doc["materials"][p["material"]]["name"]: self.new_doc["accessors"][p["indices"]]["count"] // 3 for p in primitives}
        self.assertGreater(counts["wings"], 2000)
        self.assertGreater(counts["bubble"], 500)
        self.assertGreater(counts["eyes"], 100)

    def test_normals_are_unit_and_fewer_faces_are_wound_backwards(self):
        length = np.linalg.norm(self.new["normal"], axis=1)
        self.assertLess(abs(length - 1).max(), 1e-3)
        before, after = inspect_bee.analyse(root / "buzz-bee.glb"), inspect_bee.analyse(root / "bee_hq.glb")
        self.assertLess(after["flipped_faces"], before["flipped_faces"])
        self.assertLess(after["vertices_whose_normal_differs_from_smooth_over_20deg"], before["vertices_whose_normal_differs_from_smooth_over_20deg"])

    def test_textures_are_2048_webp_and_the_normal_map_is_a_normal_map(self):
        self.assertEqual(self.new_doc["extensionsRequired"], ["EXT_texture_webp"])
        self.assertEqual([x["mimeType"] for x in self.new_doc["images"]], ["image/webp", "image/webp"])
        for index in (0, 1):
            self.assertEqual(g.image(self.new_doc, self.new_bin, index).size, (2048, 2048))
        n = np.asarray(g.image(self.new_doc, self.new_bin, 1).convert("RGB").resize((256, 256))).astype(float) / 255 * 2 - 1
        self.assertGreater(np.linalg.norm(n, axis=2).mean(), 0.97)                   # still unit vectors after enlarging
        self.assertGreater(n[..., 2].mean(), 0.9)                                     # and still mostly pointing out

    def test_colours_are_the_flat_palette(self):
        """Honey yellow, ink and the other palette colours fill their parts evenly: no baked highlights, no grey blotches."""
        pic = np.asarray(g.image(self.new_doc, self.new_bin, 0).convert("RGB").resize((512, 512))).astype(float)
        def share(colour, tolerance=14):
            return float((np.abs(pic - np.array(colour)).max(axis=2) < tolerance).mean())
        self.assertGreater(share((245, 197, 66)), 0.08)              # honey yellow
        self.assertGreater(share((42, 33, 18)), 0.03)                # ink
        self.assertGreater(share((245, 160, 75)), 0.0005)            # cheeks and tongue
        self.assertGreater(share((255, 248, 232)), 0.02)             # wings
        used = np.abs(pic - pic.mean(axis=2, keepdims=True)).max(axis=2)
        palette = sum(share(c) for c in ((245, 197, 66), (42, 33, 18), (245, 160, 75), (255, 248, 232), (255, 255, 255)))
        self.assertGreater(palette, 0.45)                            # most of the picture is flat palette colour

    def test_the_original_model_is_untouched(self):
        committed = subprocess.run(["git", "show", "HEAD:buzz-bee.glb"], cwd=root, capture_output=True)
        if committed.returncode:
            self.skipTest("not in a git checkout")
        self.assertEqual((root / "buzz-bee.glb").read_bytes(), committed.stdout)

    def test_the_inspection_tool_reports_the_problems_it_found(self):
        report = inspect_bee.analyse(root / "buzz-bee.glb")
        found = " ".join(inspect_bee.problems(report))
        self.assertIn("flipped_faces", found)
        self.assertIn("512x512", found)
        self.assertIn("one material", found)


class BeeLook(unittest.TestCase):
    js = (root / "buzz-bee3d.js").read_text(encoding="utf-8")

    def test_every_look_value_is_in_one_config_object(self):
        config = self.js[self.js.index("export const BEE_LOOK"):self.js.index("const TONE_MAPPING")]
        for name in ("body", "eyes", "wings", "bubble"):
            self.assertIn(f"    {name}: {{", config)
        for number in ("clearcoat", "roughness", "transmission", "thickness", "ior", "sheen", "toneMapping", "environment", "anisotropy"):
            self.assertIn(number, config)
        scattered = re.findall(r"(?:roughness|clearcoat|transmission|ior|sheen)\s*:\s*[0-9.]+", self.js[self.js.index("const TONE_MAPPING"):])
        self.assertEqual(scattered, [])                                                # no look number outside BEE_LOOK (apart from the old-model fallback)

    def test_the_values_follow_the_brief(self):
        body = self.js[self.js.index("    body: {"):self.js.index("    eyes: {")]
        self.assertIn("clearcoat: 0,", body)
        self.assertIn("sheen: 0,", body)
        self.assertRegex(body, r"roughness: 0\.[67][0-9]?,")
        wings = self.js[self.js.index("    wings: {"):self.js.index("    bubble: {")]
        for needle in ("transmission:", "thickness:", "ior: 1.4", "doubleSided: true"):
            self.assertIn(needle, wings)
        self.assertIn("ACESFilmic", self.js)
        self.assertIn("toneMapping: 'Neutral'", self.js)         # Neutral keeps the palette colours; ACES turned the honey yellow lemon
        self.assertIn("SRGBColorSpace", self.js)
        self.assertIn("getMaxAnisotropy", self.js)
        self.assertIn("antialias: true", self.js)

    def test_the_improved_model_is_loaded_with_the_original_as_fallback(self):
        self.assertIn("const MODEL = '/bee_hq.glb", self.js)
        self.assertIn("FALLBACK_MODEL", self.js)
        self.assertIn('"/bee_hq.glb"', (root / "server.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
