#!/usr/bin/env python3
r"""
Extract a faithful intermediate representation (IR) of a PowerPoint deck.

The IR is the traceable record of what PowerPoint itself stores. It makes no
Digital Bone Box layout decisions: every coordinate is in slide EMU after the
shape's own transform (offset, size, flip, rotation) and every enclosing group
transform have been applied. The Node converter (boneset-api/pptxSceneImport.js)
turns this record into Scene Editor scenes, so conversion rules can change
without reopening the PPTX.

Usage:
    python3 data_extraction/pptx_ir.py DECK.pptx [OUT_DIR] [--deck-key KEY] [--slides 2-7,9]

Writes OUT_DIR/<deck-key>.ir.json and OUT_DIR/media/<sha256[:16]><ext>.
Without OUT_DIR the local import folder is used: DBB_PPTX_IMPORT_DIR when set,
otherwise %LOCALAPPDATA%\DigitalBoneBox\imports\pptx on Windows,
~/Library/Application Support/DigitalBoneBox/imports/pptx on macOS and
$XDG_DATA_HOME (or ~/.local/share)/DigitalBoneBox/imports/pptx elsewhere.
OUT_DIR may be relative or absolute, but it must not contain '..' and must
resolve inside the current directory, the user's home directory, the system
temporary directory or the import folder. The deck key may only use letters,
digits, '.', '_' and '-'. Every file is checked to land inside OUT_DIR before
it is written.
Only the Python standard library is required. Pillow is used, when installed,
to measure text with Calibri (or the metric-compatible Carlito), found in the
usual Windows, macOS and Linux font folders; without it, line breaks fall
back to an average character width and the IR says so.
"""

import argparse
import hashlib
import json
import math
import ntpath
import os
import posixpath
import re
import struct
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

IR_VERSION = 1
EXTRACTOR_VERSION = "0.1.0"
EMU_PER_PT = 12700
EMU_PER_PX = 9525  # 96 dpi

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
A = "{%s}" % NS["a"]
P = "{%s}" % NS["p"]
R_ID = "{%s}id" % NS["r"]
R_EMBED = "{%s}embed" % NS["r"]
R_LINK = "{%s}link" % NS["r"]

# --------------------------------------------------------------------------
# 2D affine matrices: (a, b, c, d, e, f) maps (x, y) to (a*x + c*y + e, b*x + d*y + f),
# the same convention as SVG's matrix(a b c d e f).
# --------------------------------------------------------------------------
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mul(m, n):
    """Returns m after n (apply n first, then m)."""
    a1, b1, c1, d1, e1, f1 = m
    a2, b2, c2, d2, e2, f2 = n
    return (a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1)


def translate(x, y):
    return (1.0, 0.0, 0.0, 1.0, float(x), float(y))


def scale(sx, sy):
    return (float(sx), 0.0, 0.0, float(sy), 0.0, 0.0)


def rotate(deg):
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return (c, s, -s, c, 0.0, 0.0)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def frame_matrix(off, ext, rot_deg, flip_h, flip_v):
    """Box-local [0,cx]x[0,cy] to parent space, as DrawingML defines it:
    scale to ext, flip about the box center, rotate about the box center, move to off."""
    cx, cy = ext
    m = translate(off[0] + cx / 2.0, off[1] + cy / 2.0)
    m = mul(m, rotate(rot_deg))
    m = mul(m, scale(-1 if flip_h else 1, -1 if flip_v else 1))
    return mul(m, translate(-cx / 2.0, -cy / 2.0))


def decompose(m, cx, cy):
    """Splits box-local->slide matrix into an axis-aligned frame + rotation + flips.
    Exact when the linear part has orthogonal columns (no skew); returns a warning otherwise."""
    a, b, c, d, _, _ = m
    sx = math.hypot(a, b)
    sy = math.hypot(c, d)
    det = a * d - b * c
    skew = abs(a * c + b * d) / (sx * sy) if sx and sy else 0.0
    rot = math.degrees(math.atan2(b, a))
    flip_v = det < 0  # represent any single reflection as flipV after rotation by rot
    w, h = cx * sx, cy * sy
    center = apply(m, cx / 2.0, cy / 2.0)
    frame = {"x": center[0] - w / 2.0, "y": center[1] - h / 2.0, "width": w, "height": h}
    rot = ((rot + 180.0) % 360.0) - 180.0
    return frame, rot, False, flip_v, (skew > 1e-6)


# --------------------------------------------------------------------------
# Package helpers
# --------------------------------------------------------------------------
class Package:
    def __init__(self, path):
        self.path = path
        self.zip = zipfile.ZipFile(path)
        self.names = set(self.zip.namelist())

    def xml(self, name):
        return ET.fromstring(self.zip.read(name))

    def bytes(self, name):
        return self.zip.read(name)

    def rels(self, part):
        folder, base = posixpath.split(part)
        rels_name = posixpath.join(folder, "_rels", base + ".rels")
        out = {}
        if rels_name not in self.names:
            return out
        for rel in self.xml(rels_name):
            target = rel.get("Target")
            mode = rel.get("TargetMode")
            if mode == "External":
                resolved = target
            elif target.startswith("/"):  # absolute package path (Google Slides exports use these)
                resolved = posixpath.normpath(target.lstrip("/"))
            else:
                resolved = posixpath.normpath(posixpath.join(folder, target))
            out[rel.get("Id")] = {"target": resolved, "type": rel.get("Type", "").rsplit("/", 1)[-1], "external": mode == "External"}
        return out


def image_pixel_size(data):
    """Reads PNG/JPEG/GIF pixel size from the header bytes; None if unknown."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return list(struct.unpack(">II", data[16:24]))
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return list(struct.unpack("<HH", data[6:10]))
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return [w, h]
            i += 2 + length
    return None


def may_be_transparent(data):
    """True if the image format can carry transparency and this file declares it."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        color_type = data[25]
        return color_type in (4, 6) or b"tRNS" in data[:4096]
    return data[:3] == b"GIF" or data[:4] == b"RIFF"


# --------------------------------------------------------------------------
# Colors
# --------------------------------------------------------------------------
class Colors:
    def __init__(self, pkg, master_part):
        self.scheme = {}
        self.map = {"bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2"}
        master = pkg.xml(master_part)
        clr_map = master.find("p:clrMap", NS)
        if clr_map is not None:
            self.map.update(clr_map.attrib)
        for rel in pkg.rels(master_part).values():
            if rel["type"] == "theme":
                theme = pkg.xml(rel["target"])
                scheme = theme.find(".//a:clrScheme", NS)
                for el in scheme if scheme is not None else []:
                    name = el.tag.replace(A, "")
                    val = el[0].get("lastClr") or el[0].get("val")
                    self.scheme[name] = (val or "000000").upper()

    def resolve(self, holder, warnings):
        """holder is an element whose first child is a color (srgbClr, schemeClr, ...)."""
        if holder is None or not len(holder):
            return None
        clr = holder[0]
        tag = clr.tag.replace(A, "")
        alpha = 1.0
        mods = []
        for mod in clr:
            mtag = mod.tag.replace(A, "")
            if mtag == "alpha":
                alpha = int(mod.get("val")) / 100000.0
            else:
                mods.append(mtag)
        if tag == "srgbClr":
            rgb = clr.get("val").upper()
        elif tag == "schemeClr":
            key = self.map.get(clr.get("val"), clr.get("val"))
            rgb = self.scheme.get(key)
            if rgb is None:
                warnings.append(f"unknown scheme color {clr.get('val')}")
                rgb = "000000"
        elif tag == "sysClr":
            rgb = (clr.get("lastClr") or "000000").upper()
        elif tag == "prstClr":
            rgb = {"black": "000000", "white": "FFFFFF", "red": "FF0000", "green": "008000", "blue": "0000FF",
                   "yellow": "FFFF00"}.get(clr.get("val"), "000000")
        else:
            warnings.append(f"unsupported color {tag}")
            rgb = "000000"
        if mods:
            warnings.append("color modifiers ignored: " + ",".join(sorted(set(mods))))
        return {"rgb": "#" + rgb, "alpha": round(alpha, 4)}


# --------------------------------------------------------------------------
# Text layout (line breaks), measured with a Calibri-compatible font when available
# --------------------------------------------------------------------------
# Fonts used to measure line breaks. The real typeface is preferred; a
# metric-compatible substitute (Carlito for Calibri, Liberation Sans for Arial)
# gives the same breaks. PPTX_IR_FONT_DIR adds a folder to search first.
FONT_NAMES = {
    ("calibri", False): ["calibri.ttf", "Calibri.ttf", "Carlito-Regular.ttf"],
    ("calibri", True): ["calibrib.ttf", "Calibri Bold.ttf", "Carlito-Bold.ttf"],
    ("arial", False): ["arial.ttf", "Arial.ttf", "LiberationSans-Regular.ttf"],
    ("arial", True): ["arialbd.ttf", "Arial Bold.ttf", "LiberationSans-Bold.ttf"],
}
FONT_ALIASES = {"carlito": "calibri", "helvetica": "arial", "liberation sans": "arial"}


def font_dirs():
    home = os.path.expanduser("~")
    dirs = [os.environ.get("PPTX_IR_FONT_DIR"),
            os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts"),
            "/Library/Fonts", "/System/Library/Fonts/Supplemental", os.path.join(home, "Library", "Fonts"),
            "/Applications/Microsoft Word.app/Contents/Resources/DFonts",
            "/usr/share/fonts/truetype/crosextra", "/usr/share/fonts/truetype/liberation",
            "/usr/share/fonts/truetype/msttcorefonts", os.path.join(home, ".fonts")]
    return [d for d in dirs if d and os.path.isdir(d)]


class TextMeasurer:
    def __init__(self):
        self.cache = {}
        try:
            from PIL import ImageFont  # optional
            self.ImageFont = ImageFont
        except Exception:
            self.ImageFont = None

    def font(self, family, bold, size_px):
        if self.ImageFont is None:
            return None, "estimate"
        name = FONT_ALIASES.get((family or "").lower(), (family or "").lower())
        if (name, bold) not in FONT_NAMES:
            name = "calibri"  # the deck's theme font; also the PowerPoint default
        path = self.find_font(name, bold)
        if path is None:
            return None, "estimate"
        cache_key = (path, round(size_px * 64))
        if cache_key not in self.cache:
            # Measure at 64x and scale down: avoids integer hinting at small sizes.
            self.cache[cache_key] = self.ImageFont.truetype(path, max(1, round(size_px * 64)))
        return self.cache[cache_key], os.path.basename(path)

    def find_font(self, name, bold):
        key = ("path", name, bold)
        if key not in self.cache:
            self.cache[key] = None
            for folder in font_dirs():
                for filename in FONT_NAMES[(name, bold)]:
                    candidate = os.path.join(folder, filename)
                    if os.path.exists(candidate):
                        self.cache[key] = candidate
                        break
                if self.cache[key]:
                    break
        return self.cache[key]

    def width(self, text, family, bold, size_px):
        font, _ = self.font(family, bold, size_px)
        if font is None:
            return len(text) * size_px * 0.5
        return font.getlength(text) / 64.0

    def method(self, family, bold, size_px):
        return self.font(family, bold, size_px)[1]


def wrap_paragraph(words_text, max_width, measure):
    """Greedy word wrap, the way PowerPoint wraps: break at spaces, never mid-word."""
    words = words_text.split(" ")
    lines, current = [], ""
    for word in words:
        trial = word if not current else current + " " + word
        if not current or measure(trial) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


# --------------------------------------------------------------------------
# Output paths
#
# OUT_DIR and --deck-key come from the command line, which may be composed by
# a script or an agent rather than typed by a person. They are checked before
# anything is created: OUT_DIR is resolved to a real absolute path inside an
# allowed root, the deck key is limited to a plain file-name stem, and every
# file is resolved again and confirmed to be inside OUT_DIR just before it is
# written, so a symlink inside OUT_DIR cannot redirect a write either.
# --------------------------------------------------------------------------
IMPORT_DIR_ENV = "DBB_PPTX_IMPORT_DIR"
DECK_KEY_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
MEDIA_EXT_PATTERN = re.compile(r"\.[a-z0-9]{1,10}")


class OutputPathError(ValueError):
    """An output directory, deck key or file name that could write outside OUT_DIR."""


def is_within(path, root):
    """True when the real path `path` is `root` or inside it (both already resolved)."""
    path = os.path.normcase(path)
    root = os.path.normcase(root)
    prefix = root if root.endswith(os.sep) else root + os.sep
    return path == root or path.startswith(prefix)


def default_import_dir(environ=None, platform=None):
    """The local import folder for the IR, extracted media and import reports.

    DBB_PPTX_IMPORT_DIR overrides the platform default, for tests and for a
    deployment that keeps imports elsewhere. The default is per user and outside
    the repository, so generated files are never committed by accident.
    """
    environ = os.environ if environ is None else environ
    platform = sys.platform if platform is None else platform
    configured = environ.get(IMPORT_DIR_ENV, "").strip()
    if configured:
        return configured
    if platform.startswith("win"):
        base = environ.get("LOCALAPPDATA") or ntpath.join(os.path.expanduser("~"), "AppData", "Local")
        return ntpath.join(base, "DigitalBoneBox", "imports", "pptx")
    home = environ.get("HOME") or os.path.expanduser("~")
    if platform == "darwin":
        return posixpath.join(home, "Library", "Application Support", "DigitalBoneBox", "imports", "pptx")
    base = environ.get("XDG_DATA_HOME") or posixpath.join(home, ".local", "share")
    return posixpath.join(base, "DigitalBoneBox", "imports", "pptx")


def allowed_output_roots():
    """Real paths of the folders an output directory may be in."""
    roots = []
    for root in (os.getcwd(), os.path.expanduser("~"), tempfile.gettempdir(), default_import_dir()):
        real = os.path.realpath(root)
        if real not in roots:
            roots.append(real)
    return roots


def resolve_out_dir(out_dir):
    """The output directory as a real absolute Path, or OutputPathError."""
    raw = os.fspath(out_dir)
    if not raw.strip():
        raise OutputPathError("the output directory is empty")
    if ".." in re.split(r"[\\/]+", raw):
        raise OutputPathError(f"the output directory must not contain '..': {raw!r}")
    resolved = os.path.realpath(os.path.abspath(raw))
    for root in allowed_output_roots():
        if is_within(resolved, root):
            return Path(resolved)
    raise OutputPathError(
        f"the output directory {resolved!r} is not inside the current directory, the home directory, "
        f"the temporary directory or the import folder ({', '.join(allowed_output_roots())})")


def validate_deck_key(key):
    """The deck key unchanged, or OutputPathError if it is not a plain file-name stem."""
    if not isinstance(key, str) or not DECK_KEY_PATTERN.fullmatch(key):
        raise OutputPathError(
            f"invalid deck key {key!r}: use 1 to 128 letters, digits, '.', '_' or '-', "
            "starting with a letter or digit (no path separators, drive letters or '..')")
    return key


def output_path(base, *parts):
    """`base` joined with `parts`, resolved, and confirmed to be strictly inside `base`."""
    real_base = os.path.realpath(os.fspath(base))
    target = os.path.realpath(os.path.join(real_base, *parts))
    if target == real_base or not is_within(target, real_base):
        raise OutputPathError(f"{os.path.join(*parts)!r} would be written outside {real_base!r}")
    return Path(target)


def media_extension(part):
    """The lower-case extension of a media part name, or '.bin' if it is not a plain extension."""
    ext = posixpath.splitext(posixpath.basename(part))[1].lower()
    return ext if MEDIA_EXT_PATTERN.fullmatch(ext) else ".bin"


# --------------------------------------------------------------------------
# Slide parsing
# --------------------------------------------------------------------------
class DeckExtractor:
    def __init__(self, path, deck_key, out_dir, slide_filter=None):
        self.deck_key = validate_deck_key(deck_key)
        self.out_dir = resolve_out_dir(out_dir)
        self.media_dir = output_path(self.out_dir, "media")
        self.pkg = Package(path)
        self.slide_filter = slide_filter
        self.media = {}
        self.measurer = TextMeasurer()
        self.media_dir.mkdir(parents=True, exist_ok=True)

    # ---- presentation ----
    def run(self):
        pres_part = "ppt/presentation.xml"
        pres = self.pkg.xml(pres_part)
        sz = pres.find("p:sldSz", NS)
        self.slide_size = {"cx": int(sz.get("cx")), "cy": int(sz.get("cy"))}
        rels = self.pkg.rels(pres_part)
        self.slides = []
        for idx, sld in enumerate(pres.find("p:sldIdLst", NS), 1):
            self.slides.append({"index": idx, "slideId": sld.get("id"), "part": rels[sld.get(R_ID)]["target"]})
        self.part_to_index = {s["part"]: s["index"] for s in self.slides}
        with open(self.pkg.path, "rb") as fh:
            deck_sha = hashlib.sha256(fh.read()).hexdigest()
        out = {
            "irVersion": IR_VERSION,
            "extractor": {"name": "pptx_ir.py", "version": EXTRACTOR_VERSION},
            "deck": {"key": self.deck_key, "file": os.path.basename(self.pkg.path), "sha256": deck_sha,
                     "slideSize": self.slide_size, "slideCount": len(self.slides)},
            "units": "EMU (914400 per inch, 9525 per CSS px at 96 dpi)",
            "slides": [],
        }
        try:
            for slide in self.slides:
                if self.slide_filter and slide["index"] not in self.slide_filter:
                    continue
                out["slides"].append(self.slide(slide))
        finally:
            self.pkg.zip.close()
        out["media"] = self.media
        return out

    # ---- one slide ----
    def slide(self, info):
        part = info["part"]
        root = self.pkg.xml(part)
        rels = self.pkg.rels(part)
        layout_part = next((r["target"] for r in rels.values() if r["type"] == "slideLayout"), None)
        master_part = None
        if layout_part:
            master_part = next((r["target"] for r in self.pkg.rels(layout_part).values() if r["type"] == "slideMaster"), None)
        self.colors = Colors(self.pkg, master_part) if master_part else None
        self.placeholders = self.collect_placeholders([layout_part, master_part])
        self.rels = rels
        self.objects = []
        self.slide_warnings = []
        tree = root.find("p:cSld/p:spTree", NS)
        self.walk(tree, IDENTITY, [])
        title = next((o["text"]["plain"] for o in self.objects
                      if o.get("placeholder", {}).get("type") in ("title", "ctrTitle") and o.get("text")), None)
        return {
            "index": info["index"], "slideId": info["slideId"], "part": part,
            "sha256": hashlib.sha256(self.pkg.bytes(part)).hexdigest(),
            "title": title, "objects": self.objects, "warnings": self.slide_warnings,
        }

    def collect_placeholders(self, parts):
        found = []
        for part in parts:
            if not part:
                continue
            for sp in self.pkg.xml(part).iter(P + "sp"):
                ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
                xfrm = sp.find("p:spPr/a:xfrm", NS)
                if ph is not None and xfrm is not None:
                    found.append({"type": ph.get("type", "body"), "idx": ph.get("idx"), "xfrm": xfrm})
        return found

    def inherited_xfrm(self, ph):
        ph_type, ph_idx = ph.get("type", "body"), ph.get("idx")
        for cand in self.placeholders:
            if ph_idx is not None and cand["idx"] == ph_idx:
                return cand["xfrm"]
        for cand in self.placeholders:
            if cand["type"] == ph_type:
                return cand["xfrm"]
        return None

    def walk(self, container, parent_m, group_path):
        for el in container:
            tag = el.tag
            if tag == "{%s}AlternateContent" % NS["mc"]:
                fallback = el.find("mc:Fallback", NS)
                if fallback is not None:
                    self.slide_warnings.append("mc:AlternateContent: used Fallback content")
                    self.walk(fallback, parent_m, group_path)
                continue
            if tag not in (P + "sp", P + "pic", P + "cxnSp", P + "grpSp", P + "graphicFrame"):
                continue
            self.shape(el, parent_m, group_path)

    def read_xfrm(self, el):
        xfrm = None
        for path in ("p:spPr/a:xfrm", "p:grpSpPr/a:xfrm", "p:xfrm"):
            xfrm = el.find(path, NS)
            if xfrm is not None:
                break
        inherited = False
        if xfrm is None:
            ph = el.find(".//p:nvPr/p:ph", NS)
            if ph is not None:
                xfrm = self.inherited_xfrm(ph)
                inherited = xfrm is not None
        if xfrm is None:
            return None, False
        off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
        d = {"off": (int(off.get("x")), int(off.get("y"))), "ext": (int(ext.get("cx")), int(ext.get("cy"))),
             "rot": int(xfrm.get("rot", 0)) / 60000.0, "flipH": xfrm.get("flipH") == "1", "flipV": xfrm.get("flipV") == "1"}
        ch_off, ch_ext = xfrm.find("a:chOff", NS), xfrm.find("a:chExt", NS)
        if ch_off is not None and ch_ext is not None:
            d["chOff"] = (int(ch_off.get("x")), int(ch_off.get("y")))
            d["chExt"] = (int(ch_ext.get("cx")), int(ch_ext.get("cy")))
        return d, inherited

    def shape(self, el, parent_m, group_path):
        tag = el.tag.replace(P, "")
        c_nv = el.find(".//p:cNvPr", NS)
        warnings = []
        rec = {"z": len(self.objects), "id": c_nv.get("id") if c_nv is not None else None,
               "name": c_nv.get("name") if c_nv is not None else None,
               "descr": c_nv.get("descr") if c_nv is not None else None,
               "groupPath": list(group_path), "element": tag, "warnings": warnings}
        if c_nv is not None and c_nv.get("hidden") == "1":
            rec["hidden"] = True
        xfrm, inherited = self.read_xfrm(el)
        if inherited:
            warnings.append("position inherited from layout/master placeholder")
        ph = el.find(".//p:nvPr/p:ph", NS)
        if ph is not None:
            rec["placeholder"] = {"type": ph.get("type", "body"), "idx": ph.get("idx")}
        if xfrm is None:
            rec["kind"] = "unsupported"
            warnings.append("no transform (position unknown)")
            self.objects.append(rec)
            return
        local = frame_matrix(xfrm["off"], xfrm["ext"], xfrm["rot"], xfrm["flipH"], xfrm["flipV"])
        m = mul(parent_m, local)
        cx, cy = xfrm["ext"]
        rec["source"] = {"off": list(xfrm["off"]), "ext": [cx, cy], "rot": xfrm["rot"], "flipH": xfrm["flipH"], "flipV": xfrm["flipV"]}
        rec["matrix"] = [round(v, 9) for v in m]
        rec["size"] = [cx, cy]
        frame, rot, fh, fv, skewed = decompose(m, cx, cy)
        if group_path:
            rec["frame"], rec["rotation"], rec["flipH"], rec["flipV"] = frame, rot, fh, fv
        else:  # keep PowerPoint's own flip choice when there is no group to fold in
            rec["frame"] = {"x": float(xfrm["off"][0]), "y": float(xfrm["off"][1]), "width": float(cx), "height": float(cy)}
            rec["rotation"], rec["flipH"], rec["flipV"] = xfrm["rot"], xfrm["flipH"], xfrm["flipV"]
        if skewed:
            warnings.append("non-uniform scale under a rotated group: frame is approximate")
        corners = [apply(m, x, y) for x, y in ((0, 0), (cx, 0), (cx, cy), (0, cy))]
        xs, ys = [p[0] for p in corners], [p[1] for p in corners]
        rec["bbox"] = {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}

        if tag == "grpSp":
            rec["kind"] = "group"
            ch_off = xfrm.get("chOff", xfrm["off"])
            ch_ext = xfrm.get("chExt", xfrm["ext"])
            sx = cx / ch_ext[0] if ch_ext[0] else 1.0
            sy = cy / ch_ext[1] if ch_ext[1] else 1.0
            child_m = mul(m, mul(scale(sx, sy), translate(-ch_off[0], -ch_off[1])))
            rec["childMatrix"] = [round(v, 9) for v in child_m]
            self.objects.append(rec)
            self.walk(el, child_m, group_path + [rec["id"]])
            return

        self.hyperlink(el, rec)
        if tag == "cxnSp":
            # Glue: the shapes (and connection sites) the author attached this connector to.
            conn = {}
            for end, path in (("start", "p:nvCxnSpPr/p:cNvCxnSpPr/a:stCxn"), ("end", "p:nvCxnSpPr/p:cNvCxnSpPr/a:endCxn")):
                glued = el.find(path, NS)
                if glued is not None:
                    conn[end] = {"shapeId": glued.get("id"), "site": int(glued.get("idx", 0))}
            if conn:
                rec["connections"] = conn
        if tag == "pic":
            self.picture(el, rec, warnings)
        elif tag == "graphicFrame":
            rec["kind"] = "unsupported"
            warnings.append("graphicFrame (table/chart/OLE) not extracted")
        else:
            self.geometry(el, rec, m, cx, cy, warnings)
        self.text(el, rec, warnings)
        self.objects.append(rec)

    # ---- hyperlinks ----
    def hyperlink(self, el, rec):
        click = el.find(".//p:cNvPr/a:hlinkClick", NS)
        if click is None:
            return
        action = click.get("action") or ""
        rid = click.get(R_ID)
        link = {"action": action}
        if rid and rid in self.rels:
            target = self.rels[rid]
            if target["type"] == "slide":
                link["slideIndex"] = self.part_to_index.get(target["target"])
            elif target["external"]:
                link["url"] = target["target"]
        if "jump=" in action:
            link["jump"] = action.split("jump=", 1)[1]
        rec["hyperlink"] = link

    # ---- pictures ----
    def picture(self, el, rec, warnings):
        rec["kind"] = "picture"
        blip = el.find("p:blipFill/a:blip", NS)
        pic = {}
        if blip is None:
            warnings.append("picture without blip")
        else:
            rid = blip.get(R_EMBED)
            if blip.get(R_LINK):
                warnings.append("linked (external) picture not embedded")
            if rid and rid in self.rels:
                pic.update(self.store_media(self.rels[rid]["target"]))
            if blip.find(".//a:extLst", NS) is not None and "svgBlip" in ET.tostring(blip, encoding="unicode"):
                warnings.append("SVG picture: raster fallback used")
            for eff in blip:
                etag = eff.tag.replace(A, "")
                if etag == "alphaModFix":
                    amount = int(eff.get("amt", 100000)) / 100000.0
                    if amount < 1.0:
                        pic["opacity"] = amount
                elif etag != "extLst":
                    warnings.append(f"picture effect ignored: {etag}")
        src = el.find("p:blipFill/a:srcRect", NS)
        crop = {k: 0.0 for k in ("l", "t", "r", "b")}
        if src is not None:
            for k in crop:
                crop[k] = int(src.get(k, 0)) / 100000.0
        pic["crop"] = crop
        if any(v < 0 for v in crop.values()):
            warnings.append("negative crop (picture padded inside its frame)")
        if el.find("p:blipFill/a:tile", NS) is not None:
            warnings.append("tiled picture fill not supported")
        rec["picture"] = pic
        ln = el.find("p:spPr/a:ln", NS)
        if ln is not None:
            rec["line"] = self.line_style(ln, warnings)

    def store_media(self, part):
        data = self.pkg.bytes(part)
        sha = hashlib.sha256(data).hexdigest()
        name = sha[:16] + media_extension(part)
        if sha not in self.media:
            with open(output_path(self.media_dir, name), "wb") as fh:
                fh.write(data)
            self.media[sha] = {"file": "media/" + name, "sourcePart": part, "bytes": len(data),
                               "pixelSize": image_pixel_size(data), "mayBeTransparent": may_be_transparent(data)}
        return {"mediaSha256": sha, "mediaFile": "media/" + name, "pixelSize": self.media[sha]["pixelSize"],
                "mayBeTransparent": self.media[sha]["mayBeTransparent"]}

    # ---- styles ----
    def line_style(self, ln, warnings):
        if ln.find("a:noFill", NS) is not None:
            return None
        fill = ln.find("a:solidFill", NS)
        color = self.colors.resolve(fill, warnings) if (fill is not None and self.colors) else None
        width = int(ln.get("w", 9525))
        head, tail = ln.find("a:headEnd", NS), ln.find("a:tailEnd", NS)
        dash = ln.find("a:prstDash", NS)
        return {"color": color, "widthEmu": width,
                "headEnd": head.get("type") if head is not None else None,
                "tailEnd": tail.get("type") if tail is not None else None,
                "dash": dash.get("val") if dash is not None else None}

    def style_ref_color(self, el, name, warnings):
        ref = el.find(f"p:style/a:{name}", NS)
        if ref is None or not len(ref) or not self.colors:
            return None
        return self.colors.resolve(ref, warnings)

    # ---- shape geometry ----
    def geometry(self, el, rec, m, cx, cy, warnings):
        sppr = el.find("p:spPr", NS)
        cust = sppr.find("a:custGeom", NS) if sppr is not None else None
        prst = sppr.find("a:prstGeom", NS) if sppr is not None else None
        # fill
        fill = None
        fill_type = "style"
        if sppr is not None and sppr.find("a:solidFill", NS) is not None:
            fill_type = "solid"
            fill = self.colors.resolve(sppr.find("a:solidFill", NS), warnings) if self.colors else None
        elif sppr is not None and sppr.find("a:noFill", NS) is not None:
            fill_type = "none"
        elif sppr is not None and (sppr.find("a:gradFill", NS) is not None or sppr.find("a:pattFill", NS) is not None
                                   or sppr.find("a:blipFill", NS) is not None):
            fill_type = "gradient"
            warnings.append("gradient/pattern/picture fill not supported")
        else:
            fill = self.style_ref_color(el, "fillRef", warnings)
            if fill is None:
                fill_type = "none"
        rec["fillType"] = fill_type
        ln = sppr.find("a:ln", NS) if sppr is not None else None
        if ln is not None:
            line = self.line_style(ln, warnings)
            if line is not None and line["color"] is None:
                line["color"] = self.style_ref_color(el, "lnRef", warnings)
        else:
            ref_color = self.style_ref_color(el, "lnRef", warnings)
            line = {"color": ref_color, "widthEmu": 9525, "headEnd": None, "tailEnd": None, "dash": None} if ref_color else None
        rec["fill"], rec["line"] = fill, line

        if cust is not None:
            rec["kind"] = "freeform"
            rec["paths"] = self.custom_paths(cust, m, cx, cy, warnings)
        elif prst is not None:
            name = prst.get("prst")
            rec["preset"] = name
            adj = {g.get("name"): g.get("fmla") for g in prst.findall("a:avLst/a:gd", NS)}
            pts = self.preset_points(name, cx, cy, adj, warnings)
            if pts is None:
                rec["kind"] = "unsupported"
                if name not in ("rect",) or fill is not None or line is not None:
                    warnings.append(f"preset geometry '{name}' not converted")
            else:
                closed = name in ("rect", "ellipse", "roundRect", "triangle", "rtTriangle", "diamond")
                rec["kind"] = "connector" if not closed else "preset"
                rec["paths"] = [{"fill": closed, "stroke": True, "closed": closed,
                                 "commands": self.transform_commands(pts, m)}]
        else:
            rec["kind"] = "unsupported"
            warnings.append("shape without geometry")

    def custom_paths(self, cust, m, cx, cy, warnings):
        paths = []
        for path in cust.findall("a:pathLst/a:path", NS):
            w = int(path.get("w", cx) or cx) or 1
            h = int(path.get("h", cy) or cy) or 1
            sx, sy = cx / float(w), cy / float(h)
            cmds, closed = [], False
            current = (0.0, 0.0)
            for cmd in path:
                kind = cmd.tag.replace(A, "")
                try:
                    pts = [(int(pt.get("x")) * sx, int(pt.get("y")) * sy) for pt in cmd.findall("a:pt", NS)]
                except (TypeError, ValueError):
                    warnings.append("custGeom guide formula in point: path skipped")
                    pts, cmds = [], []
                    break
                if kind == "moveTo":
                    cmds.append({"type": "M", "pts": pts})
                elif kind == "lnTo":
                    cmds.append({"type": "L", "pts": pts})
                elif kind == "cubicBezTo":
                    cmds.append({"type": "C", "pts": pts})
                elif kind == "quadBezTo":
                    cmds.append({"type": "Q", "pts": pts})
                elif kind == "close":
                    cmds.append({"type": "Z", "pts": []})
                    closed = True
                elif kind == "arcTo":
                    arc = self.arc_points(current, cmd, sx, sy)
                    if arc is None:
                        warnings.append("arcTo with guide formula skipped")
                        pts = []
                    else:
                        for i in range(0, len(arc), 3):
                            cmds.append({"type": "C", "pts": arc[i:i + 3]})
                        pts = [arc[-1]] if arc else []
                else:
                    warnings.append(f"path command {kind} ignored")
                if pts:
                    current = pts[-1]
            paths.append({"fill": path.get("fill") != "none", "stroke": path.get("stroke") != "0", "closed": closed,
                          "commands": self.transform_commands(cmds, m)})
        return paths

    @staticmethod
    def arc_points(current, cmd, sx, sy):
        """DrawingML arcTo -> cubic Bezier control points (in box-local units)."""
        try:
            wr, hr = int(cmd.get("wR")) * sx, int(cmd.get("hR")) * sy
            st, sw = int(cmd.get("stAng")) / 60000.0, int(cmd.get("swAng")) / 60000.0
        except (TypeError, ValueError):
            return None

        def param(angle_deg):  # DrawingML angles are visual angles on the ellipse
            t = math.radians(angle_deg)
            return math.atan2(math.sin(t) * wr, math.cos(t) * hr) if wr and hr else t

        t0 = param(st)
        t1 = t0 + math.radians(sw)  # sweep is applied in parametric space, a standard approximation
        cxe = current[0] - wr * math.cos(t0)
        cye = current[1] - hr * math.sin(t0)
        segments = max(1, int(math.ceil(abs(t1 - t0) / (math.pi / 2))))
        out = []
        step = (t1 - t0) / segments
        k = 4.0 / 3.0 * math.tan(step / 4.0)
        for i in range(segments):
            a0, a1 = t0 + i * step, t0 + (i + 1) * step
            p0 = (cxe + wr * math.cos(a0), cye + hr * math.sin(a0))
            p3 = (cxe + wr * math.cos(a1), cye + hr * math.sin(a1))
            c1 = (p0[0] - k * wr * math.sin(a0), p0[1] + k * hr * math.cos(a0))
            c2 = (p3[0] + k * wr * math.sin(a1), p3[1] - k * hr * math.cos(a1))
            out += [c1, c2, p3]
        return out

    @staticmethod
    def preset_points(name, cx, cy, adj, warnings):
        def adj_val(key, default):
            fmla = adj.get(key)
            if fmla and fmla.startswith("val "):
                return int(fmla[4:]) / 100000.0
            return default

        if name in ("line", "straightConnector1"):
            return [{"type": "M", "pts": [(0, 0)]}, {"type": "L", "pts": [(cx, cy)]}]
        if name == "bentConnector2":
            return [{"type": "M", "pts": [(0, 0)]}, {"type": "L", "pts": [(cx, 0), (cx, cy)]}]
        if name == "bentConnector3":
            x1 = cx * adj_val("adj1", 0.5)
            return [{"type": "M", "pts": [(0, 0)]}, {"type": "L", "pts": [(x1, 0), (x1, cy), (cx, cy)]}]
        if name in ("curvedConnector2", "curvedConnector3"):
            warnings.append(f"{name} approximated by a cubic curve")
            return [{"type": "M", "pts": [(0, 0)]}, {"type": "C", "pts": [(cx * 0.5, 0), (cx * 0.5, cy), (cx, cy)]}]
        if name == "rect":
            return [{"type": "M", "pts": [(0, 0)]}, {"type": "L", "pts": [(cx, 0), (cx, cy), (0, cy)]}, {"type": "Z", "pts": []}]
        if name == "ellipse":
            k = 0.5522847498
            rx, ry = cx / 2.0, cy / 2.0
            return [{"type": "M", "pts": [(cx, ry)]},
                    {"type": "C", "pts": [(cx, ry + k * ry), (rx + k * rx, cy), (rx, cy)]},
                    {"type": "C", "pts": [(rx - k * rx, cy), (0, ry + k * ry), (0, ry)]},
                    {"type": "C", "pts": [(0, ry - k * ry), (rx - k * rx, 0), (rx, 0)]},
                    {"type": "C", "pts": [(rx + k * rx, 0), (cx, ry - k * ry), (cx, ry)]},
                    {"type": "Z", "pts": []}]
        return None

    @staticmethod
    def transform_commands(cmds, m):
        out = []
        for c in cmds:
            out.append({"type": c["type"], "pts": [[round(v, 2) for v in apply(m, x, y)] for x, y in c["pts"]]})
        return out

    # ---- text ----
    def text(self, el, rec, warnings):
        tx = el.find("p:txBody", NS)
        if tx is None:
            return
        body = tx.find("a:bodyPr", NS)
        bp = body.attrib if body is not None else {}
        insets = {k: int(bp.get(k, d)) for k, d in (("lIns", 91440), ("tIns", 45720), ("rIns", 91440), ("bIns", 45720))}
        autofit = None
        font_scale = 1.0
        if body is not None:
            for child in body:
                ctag = child.tag.replace(A, "")
                if ctag in ("normAutofit", "spAutoFit", "noAutofit"):
                    autofit = ctag
                    if ctag == "normAutofit" and child.get("fontScale"):
                        font_scale = int(child.get("fontScale")) / 100000.0
        paragraphs = []
        for para in tx.findall("a:p", NS):
            ppr = para.find("a:pPr", NS)
            runs = []
            for item in para:
                itag = item.tag.replace(A, "")
                if itag in ("r", "fld"):
                    t = item.find("a:t", NS)
                    rpr = item.find("a:rPr", NS)
                    runs.append(self.run_props(t.text if t is not None and t.text else "", rpr, warnings))
                elif itag == "br":
                    runs.append({"text": "\n", "break": True})
            end = para.find("a:endParaRPr", NS)
            paragraphs.append({"align": (ppr.get("algn") if ppr is not None else None) or "l",
                               "level": int(ppr.get("lvl", 0)) if ppr is not None else 0,
                               "bullet": bool(ppr is not None and ppr.find("a:buChar", NS) is not None),
                               "runs": runs,
                               "endSizePt": (int(end.get("sz")) / 100.0) if end is not None and end.get("sz") else None})
        plain = "\n".join("".join(r["text"] for r in p["runs"]) for p in paragraphs).strip()
        if not plain:
            return
        text = {"plain": plain, "paragraphs": paragraphs, "insets": insets,
                "anchor": bp.get("anchor", "t"), "wrap": bp.get("wrap", "square"),
                "vert": bp.get("vert", "horz"), "autofit": autofit, "fontScale": font_scale}
        if text["vert"] != "horz":
            warnings.append(f"vertical text ({text['vert']}) laid out horizontally")
        text["layout"] = self.layout_text(rec, text, warnings)
        rec["text"] = text
        if rec.get("kind") in (None, "unsupported", "preset") and rec.get("preset") in (None, "rect"):
            rec["kind"] = "text" if rec.get("fill") is None else "text-box"

    def run_props(self, text, rpr, warnings):
        run = {"text": text, "sizePt": None, "bold": False, "italic": False, "font": None, "color": None}
        if rpr is None:
            return run
        if rpr.get("sz"):
            run["sizePt"] = int(rpr.get("sz")) / 100.0
        run["bold"] = rpr.get("b") == "1"
        run["italic"] = rpr.get("i") == "1"
        latin = rpr.find("a:latin", NS)
        run["font"] = latin.get("typeface") if latin is not None else None
        fill = rpr.find("a:solidFill", NS)
        if fill is not None and self.colors:
            run["color"] = self.colors.resolve(fill, warnings)
        return run

    def layout_text(self, rec, text, warnings):
        """Computes line breaks the way PowerPoint would wrap the box, in px at 96 dpi."""
        frame = rec["frame"]
        area_w_px = (frame["width"] - text["insets"]["lIns"] - text["insets"]["rIns"]) / EMU_PER_PX
        lines = []
        size_pt = None
        methods = set()
        for para in text["paragraphs"]:
            runs = [r for r in para["runs"] if not r.get("break")]
            psize = next((r["sizePt"] for r in runs if r.get("sizePt")), None) or para.get("endSizePt")
            if psize is None:
                psize = 18.0
                if runs:
                    warnings.append("font size inherited from master: 18pt assumed")
            psize *= text["fontScale"]
            size_pt = size_pt or psize
            font = next((r["font"] for r in runs if r.get("font")), None) or "Calibri"
            bold = any(r.get("bold") for r in runs)
            px = psize * 96.0 / 72.0
            methods.add(self.measurer.method(font, bold, px))
            pieces = "".join(r["text"] for r in para["runs"]).split("\n")
            for piece in pieces:
                if text["wrap"] == "none" or area_w_px <= 0:
                    wrapped = [piece]
                else:
                    wrapped = wrap_paragraph(piece, area_w_px, lambda s: self.measurer.width(s, font, bold, px))
                for line in wrapped:
                    lines.append({"text": line.strip(), "align": para["align"], "sizePt": round(psize, 2), "bold": bold,
                                  "widthPx": round(self.measurer.width(line.strip(), font, bold, px), 2)})
        # drop leading/trailing empty lines (blank paragraphs PowerPoint does not draw visibly)
        while lines and not lines[0]["text"]:
            lines.pop(0)
        while lines and not lines[-1]["text"]:
            lines.pop()
        line_height_pt = (size_pt or 18.0) * 1.2
        height_px = len(lines) * line_height_pt * 96.0 / 72.0
        area_h_px = (frame["height"] - text["insets"]["tIns"] - text["insets"]["bIns"]) / EMU_PER_PX
        if text["autofit"] != "spAutoFit" and height_px > area_h_px + 2:
            warnings.append("text taller than its box (overflow)")
        if "estimate" in methods:
            warnings.append("line breaks estimated without font metrics (install Pillow and Calibri or Carlito)")
        return {"lines": lines, "lineHeightFactor": 1.2, "measuredWith": sorted(methods), "areaWidthPx": round(area_w_px, 2)}


def parse_slide_filter(spec):
    if not spec:
        return None
    out = set()
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("deck")
    parser.add_argument("out_dir", nargs="?", default=None,
                        help=f"where the IR and media go (default: {IMPORT_DIR_ENV} or the local import folder, "
                             f"currently {default_import_dir()})")
    parser.add_argument("--deck-key", default=None,
                        help="stable name for this deck, used for scene ids and the IR file name "
                             "(letters, digits, '.', '_', '-')")
    parser.add_argument("--slides", default=None, help="e.g. 2-7,9 (default: all)")
    args = parser.parse_args(argv)
    key = args.deck_key or re.sub(r"[^a-z0-9]+", "-", os.path.splitext(os.path.basename(args.deck))[0].lower()).strip("-")
    try:
        validate_deck_key(key)
    except OutputPathError as err:
        hint = "" if args.deck_key else " (derived from the deck's file name; pass --deck-key)"
        parser.error(f"{err}{hint}")
    try:
        out_dir = resolve_out_dir(args.out_dir if args.out_dir is not None else default_import_dir())
        out_path = output_path(out_dir, key + ".ir.json")
        extractor = DeckExtractor(args.deck, key, out_dir, parse_slide_filter(args.slides))
        ir = extractor.run()
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(ir, fh, indent=1)
    except OutputPathError as err:
        parser.error(str(err))
    objects = sum(len(s["objects"]) for s in ir["slides"])
    warned = sum(1 for s in ir["slides"] for o in s["objects"] if o["warnings"])
    if any("line breaks estimated" in w for s in ir["slides"] for o in s["objects"] for w in o["warnings"]):
        print("WARNING: label line breaks were estimated, so every label will be flagged for review. "
              "Install Pillow (pip install pillow) and make sure Calibri or Carlito is installed, "
              "or point PPTX_IR_FONT_DIR at a folder that has one.", file=sys.stderr)
    print(f"{out_path}: {len(ir['slides'])} slides, {objects} objects, {len(ir['media'])} media files, {warned} objects with warnings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
