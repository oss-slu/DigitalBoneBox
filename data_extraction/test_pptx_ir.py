"""Tests for pptx_ir.py.

    python3 -m unittest data_extraction/test_pptx_ir.py

The math tests need nothing else. Set PPTX_IR_TEST_DECK to the path of
"Bone Box (Boney Pelvis).pptx" to also run the integration checks against the
real deck (they are skipped otherwise, because the deck is not in the repo).
"""
import contextlib
import io
import json
import math
import os
import pathlib
import shutil
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib

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


def tiny_png(width, height):
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def write_minimal_deck(path):
    """A one-slide deck with one picture: enough for main() to run end to end without the client deck."""
    ns = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
          'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rels_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    parts = {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                               '<Default Extension="png" ContentType="image/png"/></Types>',
        "ppt/presentation.xml": f'<p:presentation {ns}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
                                '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
        "ppt/_rels/presentation.xml.rels": f'<Relationships xmlns="{rels_ns}"><Relationship Id="rId2" '
                                           f'Type="{rel}/slide" Target="slides/slide1.xml"/></Relationships>',
        "ppt/slides/slide1.xml": (
            f'<p:sld {ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
            '</p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1"/><p:cNvPicPr/><p:nvPr/>'
            '</p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            '<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1371600"/></a:xfrm>'
            '<a:prstGeom prst="rect"/></p:spPr></p:pic></p:spTree></p:cSld></p:sld>'),
        "ppt/slides/_rels/slide1.xml.rels": f'<Relationships xmlns="{rels_ns}"><Relationship Id="rId3" '
                                            f'Type="{rel}/image" Target="../media/image1.png"/></Relationships>',
    }
    with zipfile.ZipFile(path, "w") as z:
        for name, text in parts.items():
            z.writestr(name, text)
        z.writestr("ppt/media/image1.png", tiny_png(4, 3))


def files_under(folder):
    return sorted(os.path.join(root, name) for root, _, names in os.walk(folder) for name in names)


class OutputPaths(unittest.TestCase):
    """OUT_DIR and --deck-key are checked before anything is written (Sonar pythonsecurity:S8707)."""

    def setUp(self):
        self.work = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        previous = os.getcwd()
        os.chdir(self.work)
        self.addCleanup(os.chdir, previous)
        self.deck = os.path.join(self.work, "mini.pptx")
        write_minimal_deck(self.deck)

    def run_main(self, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                code = pptx_ir.main([self.deck, *args])
            except SystemExit as exit_:
                code = exit_.code
        return code, err.getvalue()

    def test_valid_relative_output_directory(self):
        code, _ = self.run_main("out", "--deck-key", "mini")
        self.assertEqual(code, 0)
        out = os.path.join(self.work, "out")
        self.assertEqual(pptx_ir.resolve_out_dir("out"), pathlib.Path(out))
        with open(os.path.join(out, "mini.ir.json"), encoding="utf-8") as fh:
            ir = json.load(fh)
        self.assertEqual(ir["deck"]["key"], "mini")
        self.assertEqual(len(ir["media"]), 1)
        media_file = next(iter(ir["media"].values()))["file"]
        self.assertTrue(os.path.isfile(os.path.join(out, media_file)))

    def test_valid_absolute_temporary_output_directory(self):
        target = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, target, ignore_errors=True)
        self.assertTrue(os.path.isabs(target))
        code, _ = self.run_main(target, "--deck-key", "mini")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(target, "mini.ir.json")))
        self.assertEqual(pptx_ir.resolve_out_dir(target), pathlib.Path(target))

    def test_parent_traversal_is_rejected(self):
        for bad in ("..", "../out", "out/../../out", "..\\out", "out\\..\\..\\x", os.path.join(self.work, "..", "x")):
            with self.subTest(out_dir=bad):
                with self.assertRaises(pptx_ir.OutputPathError):
                    pptx_ir.resolve_out_dir(bad)
                before = files_under(os.path.dirname(self.work))
                code, err = self.run_main(bad, "--deck-key", "mini")
                self.assertEqual(code, 2)
                self.assertIn("must not contain '..'", err)
                self.assertEqual(files_under(os.path.dirname(self.work)), before)

    def test_directory_outside_the_allowed_roots_is_rejected(self):
        outside = os.path.join(os.path.abspath(os.sep), "pptx-ir-test-not-allowed")
        if any(pptx_ir.is_within(os.path.realpath(outside), root) for root in pptx_ir.allowed_output_roots()):
            self.skipTest("the filesystem root is inside an allowed root here")
        with self.assertRaises(pptx_ir.OutputPathError):
            pptx_ir.resolve_out_dir(outside)
        code, _ = self.run_main(outside, "--deck-key", "mini")
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(outside))

    def test_unsafe_deck_keys_are_rejected(self):
        for bad in ("", ".", "..", "../evil", "..\\evil", "a/b", "a\\b", "/abs", "C:\\deck", "C:deck", ".hidden",
                    "-flag", "key with space", "key\x00", "k" * 129, None):
            with self.subTest(deck_key=bad):
                with self.assertRaises(pptx_ir.OutputPathError):
                    pptx_ir.validate_deck_key(bad)
        for bad in ("../evil", "a/b", "/abs"):
            with self.subTest(main_deck_key=bad):
                code, err = self.run_main("out", "--deck-key", bad)
                self.assertEqual(code, 2)
                self.assertIn("invalid deck key", err)
                self.assertFalse(os.path.exists(os.path.join(self.work, "out")))
        for good in ("bone-project-2", "bony-pelvis-deck", "Deck_1.v2", "k" * 128):
            self.assertEqual(pptx_ir.validate_deck_key(good), good)

    def test_output_files_remain_inside_the_requested_output_directory(self):
        before = set(files_under(self.work))
        code, _ = self.run_main("out", "--deck-key", "mini")
        self.assertEqual(code, 0)
        out = os.path.join(self.work, "out")
        written = sorted(set(files_under(self.work)) - before)
        self.assertGreaterEqual(len(written), 2)  # the IR and one media file
        for path in written:
            self.assertTrue(pptx_ir.is_within(os.path.realpath(path), out), path)

        base = pptx_ir.resolve_out_dir("out")
        self.assertEqual(pptx_ir.output_path(base, "media", "a.png"), base / "media" / "a.png")
        for bad in (("..", "x"), ("media", "..", "..", "x"), (os.path.join(self.work, "elsewhere"),), ("",)):
            with self.subTest(parts=bad):
                with self.assertRaises(pptx_ir.OutputPathError):
                    pptx_ir.output_path(base, *bad)

    def test_a_symlink_inside_the_output_directory_cannot_redirect_a_write(self):
        outside = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        base = pptx_ir.resolve_out_dir("out")
        base.mkdir()
        try:
            os.symlink(outside, os.path.join(base, "media"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        with self.assertRaises(pptx_ir.OutputPathError):
            pptx_ir.output_path(base, "media", "a.png")
        code, _ = self.run_main("out", "--deck-key", "mini")
        self.assertNotEqual(code, 0)
        self.assertEqual(os.listdir(outside), [])

    def test_media_extensions_from_the_deck_are_plain(self):
        self.assertEqual(pptx_ir.media_extension("ppt/media/image1.PNG"), ".png")
        self.assertEqual(pptx_ir.media_extension("ppt/media/image2.jpeg"), ".jpeg")
        for odd in ("ppt/media/noext", "ppt/media/a.b\\..\\..\\c", "ppt/media/x.p ng", "ppt/media/x." + "a" * 11):
            self.assertEqual(pptx_ir.media_extension(odd), ".bin")


@unittest.skipUnless(os.environ.get("PPTX_IR_TEST_DECK"), "set PPTX_IR_TEST_DECK to the pelvis deck to run")
class PelvisDeck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp()
        pptx_ir.main([os.environ["PPTX_IR_TEST_DECK"], cls.out, "--deck-key", "pelvis-test"])
        with open(os.path.join(cls.out, "pelvis-test.ir.json"), encoding="utf-8") as fh:
            cls.ir = json.load(fh)
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
