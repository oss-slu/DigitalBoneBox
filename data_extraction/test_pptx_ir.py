"""Tests for pptx_ir.py.

    python3 -m unittest data_extraction/test_pptx_ir.py

The math tests need nothing else. Set PPTX_IR_TEST_DECK to the path of
"Bone Box (Boney Pelvis).pptx" to also run the integration checks against the
real deck (they are skipped otherwise, because the deck is not in the repo).
"""
import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pptx_ir  # noqa: E402


def close(a, b, tol=1e-6):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


class TransformMath(unittest.TestCase):
    def test_plain_frame_maps_box_corners_to_offset(self):
        m = pptx_ir.frame_matrix((100, 200), (300, 50), 0, False, False)
        self.assertTrue(close(pptx_ir.apply(m, 0, 0), (100, 200)))
        self.assertTrue(close(pptx_ir.apply(m, 300, 50), (400, 250)))

    def test_flip_h_with_180_rotation_runs_bottom_left_to_top_right(self):
        # Slide 2, connector 124: rot=10800000 flipH=1. The legacy extractor ignored flipH
        # and drew top-left to bottom-right; PowerPoint draws bottom-left to top-right.
        m = pptx_ir.frame_matrix((4562474, 3679825), (609000, 495300), 180, True, False)
        start = pptx_ir.apply(m, 0, 0)
        end = pptx_ir.apply(m, 609000, 495300)
        self.assertTrue(close(start, (4562474, 3679825 + 495300), 1e-3))
        self.assertTrue(close(end, (4562474 + 609000, 3679825), 1e-3))

    def test_flip_is_applied_before_rotation(self):
        m = pptx_ir.frame_matrix((0, 0), (100, 0), 90, True, False)
        # flip makes the line run right-to-left about the center (50,0); rotating 90 deg clockwise
        # (y down) then points it from bottom to top
        self.assertTrue(close(pptx_ir.apply(m, 0, 0), (50, 50), 1e-9))
        self.assertTrue(close(pptx_ir.apply(m, 100, 0), (50, -50), 1e-9))

    def test_group_child_space_maps_onto_group_frame(self):
        # Slide 18: group off/ext differ from chOff/chExt, so children are scaled and moved.
        group = pptx_ir.frame_matrix((3886201, 1676401), (4571999, 4165207), 0, False, False)
        sx, sy = 4571999 / 3171469, 4165207 / 2648661
        child_space = pptx_ir.mul(group, pptx_ir.mul(pptx_ir.scale(sx, sy), pptx_ir.translate(-2791529, -3269146)))
        child = pptx_ir.mul(child_space, pptx_ir.frame_matrix((2791529, 3269146), (3171469, 2648661), 0, False, False))
        self.assertTrue(close(pptx_ir.apply(child, 0, 0), (3886201, 1676401), 1e-3))
        self.assertTrue(close(pptx_ir.apply(child, 3171469, 2648661), (3886201 + 4571999, 1676401 + 4165207), 1e-3))

    def test_decompose_recovers_frame_and_rotation(self):
        m = pptx_ir.frame_matrix((1000, 2000), (400, 300), -17.5, False, False)
        frame, rot, _, flip_v, skewed = pptx_ir.decompose(m, 400, 300)
        self.assertAlmostEqual(rot, -17.5, places=6)
        self.assertFalse(flip_v)
        self.assertFalse(skewed)
        self.assertTrue(close((frame["x"], frame["y"], frame["width"], frame["height"]), (1000, 2000, 400, 300), 1e-6))

    def test_arc_to_ends_on_the_circle(self):
        # quarter circle of radius 100 starting at angle 0 from (100, 0): center (0,0), ends at (0, 100)
        el = pptx_ir.ET.fromstring('<a:arcTo xmlns:a="%s" wR="100" hR="100" stAng="0" swAng="5400000"/>' % pptx_ir.NS["a"])
        pts = pptx_ir.DeckExtractor.arc_points((100.0, 0.0), el, 1.0, 1.0)
        self.assertTrue(close(pts[-1], (0, 100), 1e-6))
        mid = pts[0]  # control points stay near the circle for a quarter arc
        self.assertLess(abs(math.hypot(*mid) - 100), 15)


class TextWrap(unittest.TestCase):
    def test_greedy_wrap_breaks_at_spaces(self):
        measure = lambda s: len(s) * 6.0  # noqa: E731
        lines = pptx_ir.wrap_paragraph("Anterior Superior Iliac Spine", 61, measure)
        self.assertEqual(lines, ["Anterior", "Superior", "Iliac", "Spine"])
        self.assertEqual(pptx_ir.wrap_paragraph("Iliac Crest", 200, measure), ["Iliac Crest"])

    def test_a_long_word_is_never_split(self):
        self.assertEqual(pptx_ir.wrap_paragraph("Acetabulum", 10, lambda s: len(s) * 6.0), ["Acetabulum"])


@unittest.skipUnless(os.environ.get("PPTX_IR_TEST_DECK"), "set PPTX_IR_TEST_DECK to the pelvis deck to run")
class PelvisDeck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp()
        pptx_ir.main([os.environ["PPTX_IR_TEST_DECK"], cls.out, "--deck-key", "pelvis-test"])
        cls.ir = json.load(open(os.path.join(cls.out, "pelvis-test.ir.json")))
        cls.slides = {s["index"]: s for s in cls.ir["slides"]}

    def obj(self, slide, shape_id):
        return next(o for o in self.slides[slide]["objects"] if o["id"] == shape_id)

    def test_slide_size_is_the_decks_own(self):
        self.assertEqual(self.ir["deck"]["slideSize"], {"cx": 12192000, "cy": 6858000})

    def test_rotated_photo_keeps_its_rotation(self):
        pic = self.obj(3, "146")
        self.assertEqual(pic["rotation"], pic["source"]["rot"])  # rot / 60000, unchanged
        self.assertAlmostEqual(pic["rotation"], -17.0, delta=0.01)

    def test_grouped_photo_is_composed_with_its_group(self):
        pic = self.obj(18, "547")
        self.assertEqual(pic["groupPath"], ["546"])
        self.assertAlmostEqual(pic["frame"]["x"], 3886201, delta=1)
        self.assertAlmostEqual(pic["frame"]["width"], 4571999, delta=1)

    def test_connector_glue_is_recorded(self):
        self.assertEqual(self.obj(2, "124")["connections"], {"start": {"shapeId": "111", "site": 0}})

    def test_label_line_breaks_match_powerpoint(self):
        lines = [l["text"] for l in self.obj(3, "151")["text"]["layout"]["lines"]]
        self.assertEqual(lines, ["Anterior", "Superior Iliac", "Spine"])

    def test_hyperlinks_resolve_to_slide_numbers(self):
        self.assertEqual(self.obj(3, "148")["hyperlink"]["slideIndex"], 5)

    def test_media_is_deduplicated_by_content(self):
        self.assertEqual(len(self.ir["media"]), 7)


if __name__ == "__main__":
    unittest.main()
