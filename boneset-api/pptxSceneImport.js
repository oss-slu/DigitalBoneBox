// Converts one slide of a PowerPoint intermediate representation (written by
// data_extraction/pptx_ir.py) into a Scene Editor scene.
//
// The rule is one exact mapping: scene px = slide EMU / 9525 - origin. Nothing
// is re-laid-out, so every photo, label, line and highlight lands where the
// author put it on the slide. Pictures keep their rotation, flips and crop;
// annotations are linked to the photo under them (sourceImageId +
// sourceImageFrame), stored in that photo's own unrotated coordinates, so
// sceneCanvas.js maps them back onto the photo however it is later moved,
// resized, rotated or flipped.
//
// Anything the converter cannot place with confidence is still imported, but
// carries `importReview` so an instructor only checks the flagged objects.

const crypto = require("crypto");
const zlib = require("zlib");

const CONVERTER_VERSION = "0.2.0";
const EMU_PER_PX = 9525; // 96 dpi, the CSS pixel
const FLATTEN_TOLERANCE_PX = 0.1; // max distance between a curve and its polygon
const ENDPOINT_SNAP_PX = 3; // connector ends closer than this are one joint
const LABEL_TOUCH_PX = 4; // a line end this close to a text box belongs to it
const CAPTION_MARGIN_PX = 48; // unfilled text this close to the figure is kept (captions)
const UUID_NAMESPACE = "digital-bone-box:pptx-import";
const TEXT_TOP_OFFSET_EM = 0.21;

const round2 = (value) => Math.round(value * 100) / 100;
const px = (emu) => emu / EMU_PER_PX;

/**
 * A deterministic UUID derived from the parts, so a re-import reuses the same
 * ids. Name-based UUID version 8 with SHA-256 (RFC 9562, section 5.8 and
 * appendix B.2): the first 128 bits of SHA-256 over the namespace and the
 * parts, with the version set to 8 and the variant to 10. The parts are
 * encoded as a JSON array so that different part lists can never produce the
 * same hash input.
 * @param {...string} parts
 * @returns {string}
 */
function stableUuid(...parts) {
    const name = JSON.stringify([UUID_NAMESPACE, ...parts.map(String)]);
    const hash = crypto.createHash("sha256").update(name, "utf8").digest();
    hash[6] = (hash[6] & 0x0f) | 0x80;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable hash of a value's JSON, used to tell whether a scene was edited after import. */
function contentHash(value) {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------- geometry

function rotatePoint([x, y], degrees, cx, cy) {
    const r = (degrees * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/** Same rule as sceneCanvas.js imageTransform: flip about the box center, then rotate. */
function imageToScreen(image) {
    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    const rotation = image.rotation || 0;
    return ([x, y]) => {
        const flipped = [image.flipX ? 2 * cx - x : x, image.flipY ? 2 * cy - y : y];
        return rotation ? rotatePoint(flipped, rotation, cx, cy) : flipped;
    };
}

/** The exact inverse of imageToScreen: where a drawn point sits in the image's own box. */
function screenToImage(image) {
    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    const rotation = image.rotation || 0;
    return (point) => {
        const [x, y] = rotation ? rotatePoint(point, -rotation, cx, cy) : point;
        return [image.flipX ? 2 * cx - x : x, image.flipY ? 2 * cy - y : y];
    };
}

/** Whether a drawn point lies on the visible (cropped) part of an image. */
function insideVisible(image, point, tolerance = 0) {
    const [x, y] = screenToImage(image)(point);
    const left = image.x + (image.cropX || 0);
    const top = image.y + (image.cropY || 0);
    const width = image.cropWidth ?? image.width;
    const height = image.cropHeight ?? image.height;
    return x >= left - tolerance && x <= left + width + tolerance && y >= top - tolerance && y <= top + height + tolerance;
}

function distanceToVisible(image, point) {
    const [x, y] = screenToImage(image)(point);
    const left = image.x + (image.cropX || 0);
    const top = image.y + (image.cropY || 0);
    const right = left + (image.cropWidth ?? image.width);
    const bottom = top + (image.cropHeight ?? image.height);
    const dx = Math.max(left - x, 0, x - right);
    const dy = Math.max(top - y, 0, y - bottom);
    return Math.hypot(dx, dy);
}

/** Points every `step` px along a polyline, for coverage tests. */
function densify(points, step) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let k = 1; k <= n; k += 1) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    return out;
}

function distanceToRect(rect, [x, y]) {
    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
    return Math.hypot(dx, dy);
}

function rectCenter(rect) {
    return [rect.x + rect.width / 2, rect.y + rect.height / 2];
}

function containsPoint(rect, [x, y], margin = 0) {
    return x >= rect.x - margin && x <= rect.x + rect.width + margin && y >= rect.y - margin && y <= rect.y + rect.height + margin;
}

/** Adaptive subdivision of Bezier segments until the polygon is within `tolerance` of the curve. */
function flattenCubic(p0, p1, p2, p3, tolerance, out, depth = 0) {
    const d1 = distanceToLine(p1, p0, p3);
    const d2 = distanceToLine(p2, p0, p3);
    if (depth >= 16 || Math.max(d1, d2) <= tolerance) {
        out.push(p3);
        return;
    }
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const p01 = mid(p0, p1);
    const p12 = mid(p1, p2);
    const p23 = mid(p2, p3);
    const p012 = mid(p01, p12);
    const p123 = mid(p12, p23);
    const m = mid(p012, p123);
    flattenCubic(p0, p01, p012, m, tolerance, out, depth + 1);
    flattenCubic(m, p123, p23, p3, tolerance, out, depth + 1);
}

function distanceToLine([x, y], [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) return Math.hypot(x - ax, y - ay);
    return Math.abs(dy * x - dx * y + bx * ay - by * ax) / length;
}

/**
 * IR path commands (slide EMU) to subpaths of [x, y] points in px.
 * @returns {Array<{ points: number[][], closed: boolean }>}
 */
function flattenCommands(commands, tolerance = FLATTEN_TOLERANCE_PX) {
    const subpaths = [];
    let current = null;
    let last = null;
    let start = null;
    for (const command of commands) {
        const pts = command.pts.map(([x, y]) => [px(x), px(y)]);
        if (command.type === "M") {
            current = { points: [pts[0]], closed: false };
            subpaths.push(current);
            last = start = pts[0];
            continue;
        }
        if (!current) {
            current = { points: [[0, 0]], closed: false };
            subpaths.push(current);
            last = start = [0, 0];
        }
        if (command.type === "L") {
            for (const p of pts) current.points.push(p);
            last = pts[pts.length - 1];
        } else if (command.type === "C") {
            for (let i = 0; i + 2 < pts.length; i += 3) {
                flattenCubic(last, pts[i], pts[i + 1], pts[i + 2], tolerance, current.points);
                last = pts[i + 2];
            }
        } else if (command.type === "Q") {
            for (let i = 0; i + 1 < pts.length; i += 2) {
                const [c, end] = [pts[i], pts[i + 1]];
                const c1 = [last[0] + (2 / 3) * (c[0] - last[0]), last[1] + (2 / 3) * (c[1] - last[1])];
                const c2 = [end[0] + (2 / 3) * (c[0] - end[0]), end[1] + (2 / 3) * (c[1] - end[1])];
                flattenCubic(last, c1, c2, end, tolerance, current.points);
                last = end;
            }
        } else if (command.type === "Z") {
            current.closed = true;
            last = start;
        }
    }
    for (const sub of subpaths) {
        // drop a repeated closing point; the polygon closes itself
        const first = sub.points[0];
        const end = sub.points[sub.points.length - 1];
        if (sub.closed && sub.points.length > 1 && Math.hypot(first[0] - end[0], first[1] - end[1]) < 1e-6) sub.points.pop();
    }
    return subpaths.filter((sub) => sub.points.length >= 2);
}

// ---------------------------------------------------------------- pictures

/**
 * A PowerPoint picture as a scene image. PowerPoint stretches the cropped part
 * of the source over the visible frame and rotates about the frame's center;
 * the Scene Editor keeps the whole source box, clips it to cropX/Y/Width/Height
 * and rotates about the whole box's center. The box is placed so both agree:
 * full box from the crop fractions, then shifted by (I - L)(cv - cf), where L
 * is the flip+rotation and cv, cf are the visible and full box centers.
 */
function pictureToImage(object, origin, warnings) {
    const frame = object.frame;
    const crop = { ...(object.picture && object.picture.crop) };
    for (const side of ["l", "t", "r", "b"]) {
        if (!(crop[side] > 0)) {
            if (crop[side] < 0) warnings.push("negative crop ignored (picture padding not supported)");
            crop[side] = 0;
        }
    }
    const visible = { x: px(frame.x) - origin[0], y: px(frame.y) - origin[1], width: px(frame.width), height: px(frame.height) };
    const fullWidth = visible.width / (1 - crop.l - crop.r);
    const fullHeight = visible.height / (1 - crop.t - crop.b);
    const box = { x: visible.x - crop.l * fullWidth, y: visible.y - crop.t * fullHeight, width: fullWidth, height: fullHeight };

    const rotation = object.rotation || 0;
    const flipX = Boolean(object.flipH);
    const flipY = Boolean(object.flipV);
    const cv = rectCenter(visible);
    const cf = rectCenter(box);
    const linear = imageToScreen({ x: -0.5, y: -0.5, width: 1, height: 1, rotation, flipX, flipY }); // L about the origin
    const d = [cv[0] - cf[0], cv[1] - cf[1]];
    const ld = linear(d);
    const shift = [d[0] - ld[0], d[1] - ld[1]];

    const image = {
        x: round2(box.x + shift[0]),
        y: round2(box.y + shift[1]),
        width: round2(box.width),
        height: round2(box.height),
    };
    if (rotation) image.rotation = round2(rotation);
    if (flipX) image.flipX = true;
    if (flipY) image.flipY = true;
    if (crop.l || crop.t || crop.r || crop.b) {
        image.cropX = round2(crop.l * fullWidth);
        image.cropY = round2(crop.t * fullHeight);
        image.cropWidth = round2(Math.min(visible.width, image.width - image.cropX));
        image.cropHeight = round2(Math.min(visible.height, image.height - image.cropY));
    }
    if (object.picture && object.picture.opacity !== undefined) image.opacity = object.picture.opacity;
    return image;
}

/** A 1x1 PNG of one color as a data URL (the slide's backdrop panel, stretched). */
function solidPngDataUrl(hex) {
    const rgb = Buffer.from(hex.replace("#", ""), "hex");
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const raw = Buffer.concat([Buffer.from([0]), rgb]);
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
    return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * The box sceneCanvas.js textBox() gives a text annotation (0.6em per character,
 * 1.2 line height, offset by alignment). Kept in step with sceneCanvas.js; the
 * tests compare the two.
 */
function canvasTextBox(annotation) {
    const fontSize = annotation.fontSize;
    const lines = annotation.text.split("\n");
    const width = Math.max(...lines.map((line) => line.length)) * fontSize * 0.6;
    const offset = annotation.align === "center" ? width / 2 : annotation.align === "right" ? width : 0;
    return { x: annotation.x - offset, y: annotation.y, width, height: fontSize + (lines.length - 1) * fontSize * 1.2 };
}

// ---------------------------------------------------------------- slide analysis

function bboxPx(object) {
    return { x: px(object.bbox.x), y: px(object.bbox.y), width: px(object.bbox.width), height: px(object.bbox.height) };
}

function isOpaqueFill(object) {
    return Boolean(object.fill && object.fill.alpha >= 0.9);
}

/**
 * The figure area of the slide: the opaque rectangle behind the photos (the
 * dark panel these decks use), or the photos' bounds when there is none.
 */
function findFigure(objects) {
    const pictures = objects.filter((o) => o.kind === "picture" && !o.hidden);
    if (pictures.length === 0) return null;
    const centers = pictures.map((p) => rectCenter(bboxPx(p)));
    let backdrop = null;
    let best = 0;
    for (const o of objects) {
        if (o.kind !== "preset" || o.preset !== "rect" || !isOpaqueFill(o) || o.text || o.hidden) continue;
        if (o.z > Math.min(...pictures.map((p) => p.z))) continue; // must be drawn under the photos
        const rect = bboxPx(o);
        const count = centers.filter((c) => containsPoint(rect, c)).length;
        const area = rect.width * rect.height;
        if (count > best || (count === best && count > 0 && area < bboxPx(backdrop).width * bboxPx(backdrop).height)) {
            best = count;
            backdrop = o;
        }
    }
    if (backdrop) return { rect: bboxPx(backdrop), backdrop };
    const boxes = pictures.map(bboxPx);
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.width));
    const y1 = Math.max(...boxes.map((b) => b.y + b.height));
    const pad = 0.1 * Math.max(x1 - x0, y1 - y0);
    return { rect: { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad }, backdrop: null };
}

function inFigure(object, figure) {
    if (object.placeholder && ["title", "ctrTitle", "subTitle", "sldNum", "ftr", "dt"].includes(object.placeholder.type)) return false;
    const rect = bboxPx(object);
    if (containsPoint(figure.rect, rectCenter(rect))) return true;
    // Captions just outside the panel: small, unfilled, unlinked text whose whole
    // box sits within the margin (buttons have fills or links; titles are wider).
    const isPlainText = object.kind === "text" && !object.fill && object.fillType !== "gradient" && !object.hyperlink;
    const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y + rect.height]];
    return isPlainText && corners.every((corner) => containsPoint(figure.rect, corner, CAPTION_MARGIN_PX));
}

/** A rule or divider: a straight line running (almost) the full width or height of the figure. */
function isDivider(object, figure) {
    const rect = bboxPx(object);
    return rect.width >= 0.9 * figure.rect.width || rect.height >= 0.9 * figure.rect.height;
}

function textColor(object) {
    for (const paragraph of object.text.paragraphs) {
        for (const run of paragraph.runs) {
            if (run.color) return run.color;
        }
    }
    return { rgb: "#000000", alpha: 1 };
}

const ALIGN = { l: undefined, ctr: "center", r: "right", just: undefined, dist: "center" };

function textAnnotation(object, origin, review) {
    const text = object.text;
    const lines = text.layout.lines;
    const first = lines.find((line) => line.text) || lines[0];
    const sizePt = first ? first.sizePt : 18;
    const fontSize = round2((sizePt * 96) / 72);
    const aligns = new Set(lines.filter((line) => line.text).map((line) => line.align));
    if (aligns.size > 1) review.push("paragraphs have mixed alignment; the first is used");
    if (new Set(lines.filter((line) => line.text).map((line) => line.sizePt)).size > 1) {
        review.push("mixed font sizes in one text box; the first size is used");
    }
    if (Math.abs(object.rotation || 0) > 0.5) review.push("rotated text box is shown upright");
    const align = ALIGN[first ? first.align : "l"];
    const frame = object.frame;
    const ins = text.insets;
    const area = {
        x: px(frame.x + ins.lIns) - origin[0],
        y: px(frame.y + ins.tIns) - origin[1],
        width: px(frame.width - ins.lIns - ins.rIns),
        height: px(frame.height - ins.tIns - ins.bIns),
    };
    const height = fontSize + (lines.length - 1) * fontSize * text.layout.lineHeightFactor;
    // PowerPoint puts the first line's ascent below the inset; sceneCanvas draws
    // text with dominant-baseline "hanging" at y. Measured on 31 labels against
    // reference renders, the hanging line sits 0.21em higher (docs/pptx-import).
    let y = area.y + TEXT_TOP_OFFSET_EM * fontSize;
    if (text.anchor === "ctr") y += (area.height - height) / 2;
    if (text.anchor === "b") y += area.height - height;
    let x = area.x;
    if (align === "center") x = area.x + area.width / 2;
    if (align === "right") x = area.x + area.width;
    const color = textColor(object);
    const font = text.paragraphs.flatMap((p) => p.runs).find((run) => run.font);
    const annotation = {
        type: "text",
        text: lines.map((line) => line.text).join("\n"),
        x: round2(x),
        y: round2(y),
        fontSize,
        color: color.rgb,
    };
    if (align) annotation.align = align;
    if (first && first.bold) annotation.fontWeight = "bold";
    annotation.fontFamily = `${font ? font.font : "Calibri"}, Carlito, Arial, sans-serif`;
    // the PowerPoint text frame, for pointer association and the review report
    return { annotation, frame: { x: px(frame.x) - origin[0], y: px(frame.y) - origin[1], width: px(frame.width), height: px(frame.height) } };
}

/**
 * Points over where the text's glyphs are (each laid-out line's measured width,
 * placed by its alignment), not the whole frame: a frame often overlaps a photo
 * while the words themselves do not.
 */
function inkSamples(object, origin) {
    const text = object.text;
    const frame = object.frame;
    const ins = text.insets;
    const left = px(frame.x + ins.lIns) - origin[0];
    const top = px(frame.y + ins.tIns) - origin[1];
    const width = px(frame.width - ins.lIns - ins.rIns);
    const samples = [];
    text.layout.lines.forEach((line, i) => {
        if (!line.text) return;
        const size = (line.sizePt * 96) / 72;
        const y0 = top + i * size * text.layout.lineHeightFactor;
        let x0 = left;
        if (line.align === "ctr") x0 = left + (width - line.widthPx) / 2;
        if (line.align === "r") x0 = left + width - line.widthPx;
        for (let k = 0; k <= 4; k += 1) {
            samples.push([x0 + (line.widthPx * k) / 4, y0 + size * 0.2], [x0 + (line.widthPx * k) / 4, y0 + size * 0.8]);
        }
    });
    return samples;
}

/** Groups connector ends into joints, then each group of touching lines into one pointer. */
function associatePointers(connectors, labels) {
    const nodes = [];
    const nodeOf = (point) => {
        for (let i = 0; i < nodes.length; i += 1) {
            if (Math.hypot(nodes[i][0] - point[0], nodes[i][1] - point[1]) <= ENDPOINT_SNAP_PX) return i;
        }
        nodes.push(point);
        return nodes.length - 1;
    };
    const edges = connectors.map((c) => ({ ...c, a: nodeOf(c.points[0]), b: nodeOf(c.points[c.points.length - 1]) }));
    const labelAt = (point) =>
        labels.filter((label) => distanceToRect(label.frame, point) <= LABEL_TOUCH_PX).map((label) => label.index);

    // connected components of lines
    const parent = edges.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    edges.forEach((e, i) => edges.forEach((f, j) => {
        if (j > i && (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b)) parent[find(i)] = find(j);
    }));
    const components = new Map();
    edges.forEach((e, i) => {
        const root = find(i);
        if (!components.has(root)) components.set(root, []);
        components.get(root).push(e);
    });

    const results = [];
    for (const members of components.values()) {
        const touching = new Map(); // node -> labels
        for (const e of members) {
            for (const [node, point] of [[e.a, e.points[0]], [e.b, e.points[e.points.length - 1]]]) {
                const hits = labelAt(point);
                if (hits.length) touching.set(node, [...new Set([...(touching.get(node) || []), ...hits])]);
            }
        }
        const labelIds = new Set([...touching.values()].flat());
        if (labelIds.size !== 1) {
            const reason = labelIds.size === 0 ? "line is not attached to any label" : "line touches more than one label";
            for (const e of members) results.push({ label: null, points: e.points, members: [e], review: [reason] });
            continue;
        }
        const label = [...labelIds][0];
        const startNodes = [...touching.keys()];
        // walk from the label's node to every leaf, one polyline per branch
        const adjacency = new Map();
        for (const e of members) {
            for (const [from, to, pts] of [[e.a, e.b, e.points], [e.b, e.a, [...e.points].reverse()]]) {
                if (!adjacency.has(from)) adjacency.set(from, []);
                adjacency.get(from).push({ to, pts, edge: e });
            }
        }
        for (const start of startNodes) {
            const stack = [{ node: start, points: [nodes[start]], used: new Set(), edges: [] }];
            while (stack.length) {
                const { node, points, used, edges: path } = stack.pop();
                const next = (adjacency.get(node) || []).filter((step) => !used.has(step.edge));
                if (next.length === 0 && path.length) {
                    results.push({ label, points, members: path, review: [] });
                    continue;
                }
                for (const step of next) {
                    stack.push({
                        node: step.to,
                        points: [...points, ...step.pts.slice(1)],
                        used: new Set([...used, step.edge]),
                        edges: [...path, step.edge],
                    });
                }
            }
        }
        if (startNodes.length > 1) results.forEach((r) => r.label === label && r.review.push("label touches its line in two places"));
    }
    return results;
}

// ---------------------------------------------------------------- conversion

/**
 * @param {object} ir - The deck IR from pptx_ir.py.
 * @param {number} slideIndex - 1-based slide number.
 * @param {{ mediaSrc: (sha256: string, mediaFile: string) => string, now?: string }} options
 * @returns {{ scene: object, report: object }}
 */
function convertSlide(ir, slideIndex, options) {
    const slide = ir.slides.find((s) => s.index === slideIndex);
    if (!slide) throw new Error(`Slide ${slideIndex} is not in the IR`);
    const deckKey = ir.deck.key;
    const sceneId = stableUuid(deckKey, "slide", slide.slideId);
    const objects = slide.objects.filter((o) => o.kind !== "group");
    const figure = findFigure(objects);
    const report = { slide: slideIndex, slideId: slide.slideId, flagged: [], skipped: [], counts: {} };
    const images = [];
    const annotations = [];
    const idFor = (object, part = 0) => stableUuid(deckKey, slide.slideId, object.id, String(part));
    const sourceOf = (object, type) => ({
        type,
        deck: deckKey,
        slide: slideIndex,
        slideId: slide.slideId,
        shapeId: object.id,
        shapeName: object.name,
    });
    const flag = (annotation, object, reasons) => {
        if (!reasons.length) return;
        annotation.importReview = { status: "needs-review", reasons: [...new Set(reasons)] };
        report.flagged.push({ shapeId: object.id, name: object.name, type: annotation.type, reasons: annotation.importReview.reasons });
    };

    if (!figure) {
        report.skipped.push({ reason: "slide has no pictures" });
        const now = options.now || new Date().toISOString();
        return { scene: null, report: { ...report, sceneId, now } };
    }
    const origin = [figure.rect.x, figure.rect.y];

    // 1. the backdrop panel, as the bottom image, so white labels stay readable
    if (figure.backdrop) {
        images.push({
            id: idFor(figure.backdrop),
            src: solidPngDataUrl(figure.backdrop.fill.rgb),
            name: "Slide backdrop",
            x: 0,
            y: 0,
            width: round2(figure.rect.width),
            height: round2(figure.rect.height),
            source: sourceOf(figure.backdrop, "pptx-backdrop"),
        });
    }

    // 2. pictures, in slide order
    const pictures = [];
    const pictureInfo = new Map();
    for (const object of objects) {
        if (object.kind !== "picture" || object.hidden) continue;
        if (!inFigure(object, figure)) {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: "picture outside the figure area" });
            continue;
        }
        const warnings = [...object.warnings];
        const image = {
            id: idFor(object),
            src: options.mediaSrc(object.picture.mediaSha256, object.picture.mediaFile),
            name: object.descr || object.name,
            ...pictureToImage(object, origin, warnings),
            source: { ...sourceOf(object, "pptx-picture"), mediaSha256: object.picture.mediaSha256 },
        };
        if (warnings.length) image.importReview = { status: "needs-review", reasons: warnings };
        images.push(image);
        pictures.push(image);
        pictureInfo.set(image, { z: object.z, opaque: !object.picture.mayBeTransparent });
    }

    // The Scene Editor draws every annotation above every image, but on a slide a
    // photo can be drawn over a shape. A shape fully under an opaque photo was
    // invisible to students, so it is left out (and reported); one partly
    // covered is imported and flagged.
    const occlusion = (points, z) => {
        let opaque = 0;
        let maybe = 0;
        for (const point of points) {
            const above = pictures.filter((img) => pictureInfo.get(img).z > z && insideVisible(img, point));
            if (above.some((img) => pictureInfo.get(img).opaque)) opaque += 1;
            else if (above.length) maybe += 1;
        }
        if (!points.length) return null;
        if (opaque / points.length >= 0.9) return "hidden";
        if ((opaque + maybe) / points.length >= 0.1) return "partial";
        return null;
    };
    const HIDDEN = "hidden behind a photo drawn above it on the slide";
    const PARTIAL = "partly behind a photo on the slide; the Scene Editor draws it on top";

    // Lines and polygons: store points in the photo's own (unrotated, unflipped) box.
    const linkTo = (annotation, image) => {
        if (!image) return annotation;
        const toImage = screenToImage(image);
        annotation.points = annotation.points.map((point) => toImage(point).map(round2));
        annotation.sourceImageId = image.id;
        annotation.sourceImageFrame = { x: image.x, y: image.y, width: image.width, height: image.height };
        return annotation;
    };
    const bestPictureFor = (points) => {
        let best = null;
        let bestCount = -1;
        let bestDistance = Infinity;
        for (const image of pictures) {
            const count = points.filter((p) => insideVisible(image, p)).length;
            const distance = Math.min(...points.map((p) => distanceToVisible(image, p)));
            if (count > bestCount || (count === bestCount && distance < bestDistance)) {
                best = image;
                bestCount = count;
                bestDistance = distance;
            }
        }
        return { image: best, inside: bestCount, distance: bestDistance };
    };

    // 3. highlights (freeforms and filled preset shapes)
    for (const object of objects) {
        if (!["freeform", "preset"].includes(object.kind) || object.hidden || object === figure.backdrop) continue;
        if (!inFigure(object, figure)) {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: "shape outside the figure area" });
            continue;
        }
        if (object.kind === "preset" && isOpaqueFill(object) && object.preset === "rect") {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: "opaque panel inside the figure" });
            continue;
        }
        let part = 0;
        for (const path of object.paths || []) {
            const subpaths = flattenCommands(path.commands).map((sub) => ({
                ...sub,
                points: sub.points.map(([x, y]) => [x - origin[0], y - origin[1]]),
            }));
            for (const sub of subpaths) {
                const reasons = [...object.warnings];
                if (subpaths.length > 1) reasons.push("compound path split into separate shapes (holes are filled)");
                const filled = path.fill && sub.closed && object.fill;
                const line = object.line;
                const annotation = filled
                    ? {
                        type: "polygon",
                        points: sub.points.map(([x, y]) => [round2(x), round2(y)]),
                        fill: object.fill.rgb,
                        fillOpacity: object.fill.alpha,
                        stroke: line && line.color ? line.color.rgb : "none",
                        strokeWidth: line ? round2(px(line.widthEmu)) : 0,
                    }
                    : {
                        type: "line",
                        points: (sub.closed ? [...sub.points, sub.points[0]] : sub.points).map(([x, y]) => [round2(x), round2(y)]),
                        stroke: line && line.color ? line.color.rgb : "#000000",
                        strokeWidth: line ? round2(px(line.widthEmu)) : 1,
                    };
                if (!filled && !(line && line.color)) continue; // invisible shape
                const covered = occlusion(sub.points, object.z);
                if (covered === "hidden") {
                    report.skipped.push({ shapeId: object.id, name: object.name, reason: HIDDEN });
                    continue;
                }
                if (covered === "partial") reasons.push(PARTIAL);
                const target = bestPictureFor(sub.points);
                if (target.inside < sub.points.length * 0.5) reasons.push("shape is mostly outside every photo");
                annotation.id = idFor(object, part);
                annotation.source = sourceOf(object, filled ? "pptx-region" : "pptx-outline");
                linkTo(annotation, target.image);
                flag(annotation, object, reasons);
                annotations.push(annotation);
                part += 1;
            }
        }
    }

    // 4. labels and pointer lines
    const labelObjects = [];
    for (const object of objects) {
        if (!object.text || object.hidden || !["text", "preset", "text-box"].includes(object.kind)) continue;
        if (object.kind === "preset" && object.preset !== "rect") continue;
        if (!inFigure(object, figure)) {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: "text outside the figure area", text: object.text.plain.slice(0, 60) });
            continue;
        }
        const review = [...object.warnings.filter((w) => !w.startsWith("gradient"))];
        if (object.kind === "text-box") review.push("the text box's own background is not imported");
        const { annotation, frame } = textAnnotation(object, origin, review);
        const covered = occlusion(inkSamples(object, origin), object.z);
        if (covered === "hidden") {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: HIDDEN, text: object.text.plain.slice(0, 60) });
            continue;
        }
        if (covered === "partial") review.push(PARTIAL);
        annotation.id = idFor(object);
        annotation.source = sourceOf(object, "pptx-label");
        if (object.hyperlink) annotation.source.hyperlink = object.hyperlink;
        labelObjects.push({ object, annotation, frame, review, index: labelObjects.length });
    }
    const connectorObjects = objects.filter((o) => o.kind === "connector" && !o.hidden);
    const connectors = [];
    for (const object of connectorObjects) {
        if (!inFigure(object, figure)) {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: "line outside the figure area" });
            continue;
        }
        if (!object.line || !object.line.color) continue;
        if (isDivider(object, figure)) {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: "divider line along the figure" });
            continue;
        }
        const points = flattenCommands(object.paths[0].commands)[0].points.map(([x, y]) => [x - origin[0], y - origin[1]]);
        connectors.push({ object, points });
    }
    const pointers = associatePointers(connectors, labelObjects.map((l) => ({ index: l.index, frame: l.frame })));
    const labelTargets = new Map(labelObjects.map((l) => [l.index, []]));

    const pointerAnnotations = [];
    const labelIndexByShape = new Map(labelObjects.map((l) => [l.object.id, l.index]));
    for (const pointer of pointers) {
        // The author's glue (stCxn/endCxn) is the strongest evidence of which label
        // a line belongs to; geometry decides only when there is no glue.
        const gluedShapes = pointer.members.flatMap((m) => Object.values(m.object.connections || {}).map((c) => c.shapeId));
        const gluedLabels = [...new Set(gluedShapes.filter((id) => labelIndexByShape.has(id)).map((id) => labelIndexByShape.get(id)))];
        if (gluedLabels.length === 1 && pointer.label !== gluedLabels[0]) {
            if (pointer.label !== null) pointer.review.push("glue and geometry point to different labels; glue used");
            else pointer.review = pointer.review.filter((r) => !r.startsWith("line is not attached") && !r.startsWith("line touches"));
            pointer.label = gluedLabels[0];
            const box = labelObjects[pointer.label].frame;
            const ends = [pointer.points[0], pointer.points[pointer.points.length - 1]];
            if (distanceToRect(box, ends[1]) < distanceToRect(box, ends[0])) pointer.points = [...pointer.points].reverse();
        } else if (gluedLabels.length > 1) {
            pointer.review.push("line is glued to more than one label");
        }
        const first = pointer.members[0].object;
        const line = first.line;
        const samples = densify(pointer.points, 4);
        const covered = occlusion(samples, Math.min(...pointer.members.map((m) => m.object.z)));
        if (covered === "hidden") {
            report.skipped.push({ shapeId: first.id, name: first.name, reason: HIDDEN });
            continue;
        }
        if (covered === "partial") pointer.review.push(PARTIAL);
        const arrowAtStart = pointer.members.some((m) => m.object.line && m.object.line.headEnd && m.object.line.headEnd !== "none");
        const arrowAtEnd = pointer.members.some((m) => m.object.line && m.object.line.tailEnd && m.object.line.tailEnd !== "none");
        const reasons = [...pointer.review, ...pointer.members.flatMap((m) => m.object.warnings)];
        if (pointer.label !== null && arrowAtStart && !arrowAtEnd) reasons.push("arrowhead at the label end is drawn at the target end");
        const annotation = {
            type: arrowAtStart || arrowAtEnd ? "arrow" : "line",
            points: pointer.points.map(([x, y]) => [round2(x), round2(y)]),
            stroke: line.color.rgb,
            strokeWidth: round2(px(line.widthEmu)),
        };
        annotation.id = idFor(first, pointer.members.length > 1 ? `p${pointer.members.map((m) => m.object.id).join("-")}` : "p");
        annotation.source = { ...sourceOf(first, "pptx-pointer-line"), shapeIds: pointer.members.map((m) => m.object.id) };
        const gluedTargets = gluedShapes.filter((id) => !labelIndexByShape.has(id));
        // e.g. the highlighted region this label's line was attached to: a label-to-region link for quizzes
        if (gluedTargets.length) annotation.source.gluedTo = [...new Set(gluedTargets)];
        const target = pointer.points[pointer.points.length - 1];
        const where = bestPictureFor([target]);
        if (where.inside === 0 && where.distance > 6) reasons.push("line does not end on a photo");
        if (pointer.label !== null) {
            annotation.labelId = labelObjects[pointer.label].annotation.id;
            labelTargets.get(pointer.label).push(where.image);
        }
        pointerAnnotations.push({ annotation, object: first, reasons, image: where.image, label: pointer.label });
    }

    // a label moves with the photo its lines point into (or the photo it sits on / nearest)
    const labelImage = new Map();
    for (const label of labelObjects) {
        const targets = labelTargets.get(label.index).filter(Boolean);
        let image = null;
        if (targets.length) {
            const counts = new Map();
            for (const t of targets) counts.set(t, (counts.get(t) || 0) + 1);
            image = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            if (counts.size > 1) {
                // Imported exactly; only matters if one photo is later moved on its own.
                label.annotation.importNotes = ["label points into more than one photo; it and its lines move with one of them"];
                report.notes = [...(report.notes || []), { shapeId: label.object.id, name: label.object.name, note: label.annotation.importNotes[0] }];
            }
        } else {
            image = bestPictureFor([rectCenter(label.frame)]).image;
        }
        labelImage.set(label.index, image);
    }
    for (const label of labelObjects) {
        const image = labelImage.get(label.index);
        const annotation = label.annotation;
        // sceneCanvas maps a linked label through the center of its textBox(), so
        // store it such that unmap(center) lands where the slide put that center.
        const center = rectCenter(canvasTextBox(annotation));
        if (image) {
            const [cx, cy] = screenToImage(image)(center);
            annotation.x = round2(annotation.x + (cx - center[0]));
            annotation.y = round2(annotation.y + (cy - center[1]));
            annotation.sourceImageId = image.id;
            annotation.sourceImageFrame = { x: image.x, y: image.y, width: image.width, height: image.height };
        }
        flag(annotation, label.object, label.review);
        annotations.push(annotation);
    }
    for (const pointer of pointerAnnotations) {
        const image = pointer.label !== null ? labelImage.get(pointer.label) : pointer.image;
        linkTo(pointer.annotation, image);
        flag(pointer.annotation, pointer.object, pointer.reasons);
        annotations.push(pointer.annotation);
    }

    for (const object of objects) {
        if (object.kind === "unsupported" && inFigure(object, figure) && !object.text) {
            report.skipped.push({ shapeId: object.id, name: object.name, reason: object.warnings.join("; ") || "unsupported object" });
        }
    }

    const counts = {
        images: pictures.length,
        backdrop: figure.backdrop ? 1 : 0,
        labels: labelObjects.length,
        pointerLines: pointerAnnotations.length,
        regions: annotations.filter((a) => a.source && a.source.type === "pptx-region").length,
        outlines: annotations.filter((a) => a.source && a.source.type === "pptx-outline").length,
        flagged: report.flagged.length,
        skipped: report.skipped.length,
    };
    report.counts = counts;
    const now = options.now || new Date().toISOString();
    const content = { images, annotations };
    const hash = contentHash(content);
    const scene = {
        id: sceneId,
        name: `${slide.title || "Slide"} (slide ${slideIndex})`.slice(0, 100),
        images,
        annotations,
        importLog: [{
            at: now,
            kind: "pptx-import",
            deck: { key: deckKey, file: ir.deck.file, sha256: ir.deck.sha256 },
            slide: { index: slideIndex, slideId: slide.slideId, sha256: slide.sha256 },
            extractor: ir.extractor,
            converter: { name: "pptxSceneImport.js", version: CONVERTER_VERSION },
            origin: { xEmu: Math.round(origin[0] * EMU_PER_PX), yEmu: Math.round(origin[1] * EMU_PER_PX), emuPerPx: EMU_PER_PX },
            counts,
            contentHash: hash,
            flagged: report.flagged.slice(0, 100),
            skipped: report.skipped.slice(0, 100),
        }],
        status: "draft",
        createdAt: now,
        updatedAt: now,
    };
    return { scene, report: { ...report, sceneId } };
}

module.exports = {
    CONVERTER_VERSION,
    EMU_PER_PX,
    convertSlide,
    contentHash,
    flattenCommands,
    pictureToImage,
    screenToImage,
    imageToScreen,
    stableUuid,
    solidPngDataUrl,
    associatePointers,
    canvasTextBox,
};
