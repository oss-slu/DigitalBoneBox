// PowerPoint -> scene import. The fixture is slides 2, 3 and 18 of the
// pelvis deck as data_extraction/pptx_ir.py extracted them: two photos (one
// rotated -17 deg), freeform highlights, flipped and rotated connectors, glued
// pointer chains, a line hidden under a photo, and a photo inside a scaled group.
//
// "Truth" is computed straight from the IR's DrawingML matrices; the scene is
// checked through sceneCanvas.js itself (the SVG it renders and
// displayedAnnotation), so these tests compare PowerPoint geometry with what
// the Scene Editor actually draws.
import { renderScene, displayedAnnotation, textBox, storeAnnotationGeometry } from "../templates/js/sceneCanvas.js";

const ir = require("./test-fixtures/bony-pelvis-slides-2-3-18.ir.json");
const { convertSlide, canvasTextBox, flattenCommands, stableUuid } = require("./pptxSceneImport");
const { validateSceneContent, isValidSceneId } = require("./scenes");

const EMU = 9525;
const TOLERANCE = 0.02; // px: the converter rounds stored values to 0.01
const NOW = "2026-11-21T00:00:00.000Z";
const mediaSrc = (sha) => `/api/images/pptx_${sha.slice(0, 16)}.jpg`;
const convert = (index) => convertSlide(ir, index, { mediaSrc, now: NOW });
const slide = (index) => ir.slides.find((s) => s.index === index);
const clone = (value) => JSON.parse(JSON.stringify(value));

function apply(m, [x, y]) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function origin(scene) {
    const log = scene.importLog[0].origin;
    return [log.xEmu / EMU, log.yEmu / EMU];
}

/** Slide geometry in scene px: IR EMU / 9525 minus the scene origin. */
function slidePx(scene, [x, y]) {
    const [ox, oy] = origin(scene);
    return [x / EMU - ox, y / EMU - oy];
}

function expectClose(actual, expected, tolerance = TOLERANCE) {
    expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(tolerance);
}

/** Parses the transform list sceneCanvas writes (rotate/translate/scale) into a matrix. */
function parseTransform(text) {
    let m = [1, 0, 0, 1, 0, 0];
    const mul = (a, b) => [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ];
    for (const [, name, args] of (text || "").matchAll(/(\w+)\(([^)]*)\)/g)) {
        const v = args.trim().split(/[\s,]+/).map(Number);
        if (name === "translate") m = mul(m, [1, 0, 0, 1, v[0], v[1] || 0]);
        if (name === "scale") m = mul(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
        if (name === "rotate") {
            const r = (v[0] * Math.PI) / 180;
            const rot = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
            m = v.length === 3 ? mul(mul(mul(m, [1, 0, 0, 1, v[1], v[2]]), rot), [1, 0, 0, 1, -v[1], -v[2]]) : mul(m, rot);
        }
    }
    return m;
}

/** Visible corners of each rendered photo, read back from the SVG sceneCanvas produced. */
function renderedPhotoCorners(scene) {
    const { svg } = renderScene(scene);
    const out = new Map();
    for (const node of svg.querySelectorAll("image.scene-image-object")) {
        const index = Number(node.getAttribute("data-scene-image-index"));
        // sceneCanvas puts the transform on the <image>, or on a wrapping <g> when the image is clipped
        const m = parseTransform(node.getAttribute("transform") || node.parentNode.getAttribute("transform"));
        let rect = ["x", "y", "width", "height"].map((k) => Number(node.getAttribute(k)));
        const clip = node.getAttribute("clip-path");
        if (clip) {
            const r = svg.querySelector(`${clip.slice(4, -1)} rect`);
            rect = ["x", "y", "width", "height"].map((k) => Number(r.getAttribute(k)));
        }
        const [x, y, w, h] = rect;
        out.set(index, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => apply(m, p)));
    }
    return out;
}

describe("PowerPoint slide import: placement matches the slide", () => {
    test.each([2, 3, 18])("slide %i: every photo's visible corners are exactly where PowerPoint draws them", (index) => {
        const { scene } = convert(index);
        const corners = renderedPhotoCorners(scene);
        for (const [i, image] of scene.images.entries()) {
            if (image.source.type !== "pptx-picture") continue;
            const object = slide(index).objects.find((o) => o.id === image.source.shapeId);
            const [cx, cy] = object.size;
            const expected = [[0, 0], [cx, 0], [cx, cy], [0, cy]].map((p) => slidePx(scene, apply(object.matrix, p)));
            corners.get(i).forEach((corner, k) => expectClose(corner, expected[k], 0.03));
        }
    });

    test.each([
        [30, true, false],
        [-112, false, true],
        [0, true, true],
    ])("a cropped photo rotated %i deg (flipH %s, flipV %s) shows the same visible frame as PowerPoint", (rot, flipH, flipV) => {
        // PowerPoint rotates about the visible (cropped) frame; the Scene Editor about the whole image box.
        const off = [2000000, 1500000];
        const ext = [3000000, 2000000];
        const c = [off[0] + ext[0] / 2, off[1] + ext[1] / 2];
        const r = (rot * Math.PI) / 180;
        const fx = flipH ? -1 : 1;
        const fy = flipV ? -1 : 1;
        // T(c) R S(flip) T(-ext/2), as DrawingML defines a frame
        const a = Math.cos(r) * fx, b = Math.sin(r) * fx, cc = -Math.sin(r) * fy, d = Math.cos(r) * fy;
        const matrix = [a, b, cc, d, c[0] - (a * ext[0] + cc * ext[1]) / 2, c[1] - (b * ext[0] + d * ext[1]) / 2];
        const corners = [[0, 0], [ext[0], 0], [ext[0], ext[1]], [0, ext[1]]].map((p) => apply(matrix, p));
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const picture = {
            z: 0, id: "2", name: "photo", kind: "picture", groupPath: [], warnings: [], size: ext, matrix,
            frame: { x: off[0], y: off[1], width: ext[0], height: ext[1] }, rotation: rot, flipH, flipV,
            bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
            picture: { mediaSha256: "ab".repeat(32), mediaFile: "media/x.jpg", crop: { l: 0.1, t: 0.2, r: 0.05, b: 0.15 }, mayBeTransparent: false },
        };
        const synthetic = { deck: { key: "synthetic", file: "x.pptx", sha256: "0" }, extractor: {}, slides: [{ index: 1, slideId: "256", sha256: "0", objects: [picture] }] };
        const { scene } = convertSlide(synthetic, 1, { mediaSrc, now: NOW });
        const image = scene.images[0];
        expect(image.cropWidth).toBeCloseTo(ext[0] / EMU, 1);
        expect(image.width).toBeCloseTo(ext[0] / EMU / 0.85, 1);
        const rendered = renderedPhotoCorners(scene).get(0);
        const expected = corners.map((p) => slidePx(scene, p));
        rendered.forEach((corner, k) => expectClose(corner, expected[k], 0.03));
    });

    test("slide 18: a photo inside a scaled group lands where the group puts it", () => {
        const { scene } = convert(18);
        const object = slide(18).objects.find((o) => o.kind === "picture");
        expect(object.groupPath).toEqual(["546"]);
        const image = scene.images.find((i) => i.source.shapeId === object.id);
        // the group maps its child space (2791529,3269146 3171469x2648661) onto 3886201,1676401 4571999x4165207
        const [ox, oy] = origin(scene);
        expect(image.x).toBeCloseTo(3886201 / EMU - ox, 1);
        expect(image.width).toBeCloseTo(4571999 / EMU, 1);
        expect(image.height).toBeCloseTo(4165207 / EMU, 1);
    });

    test.each([2, 3, 18])("slide %i: highlights and pointer lines are drawn on the slide's own points", (index) => {
        const { scene } = convert(index);
        const objects = new Map(slide(index).objects.map((o) => [o.id, o]));
        for (const annotation of scene.annotations) {
            if (annotation.type === "text") continue;
            const shown = displayedAnnotation(annotation, scene).points;
            if (annotation.source.type === "pptx-pointer-line") {
                // ends: the connector ends from the IR matrices (label end first)
                const ends = annotation.source.shapeIds.flatMap((id) => {
                    const o = objects.get(id);
                    return [apply(o.matrix, [0, 0]), apply(o.matrix, o.size)].map((p) => slidePx(scene, p));
                });
                for (const point of [shown[0], shown[shown.length - 1]]) {
                    const nearest = Math.min(...ends.map((e) => Math.hypot(e[0] - point[0], e[1] - point[1])));
                    expect(nearest).toBeLessThanOrEqual(0.03);
                }
            } else {
                const object = objects.get(annotation.source.shapeId);
                const expected = flattenCommands(object.paths[0].commands)[0].points.map(([x, y]) => [x - origin(scene)[0], y - origin(scene)[1]]);
                expect(shown.length).toBeGreaterThanOrEqual(expected.length - 1);
                shown.slice(0, expected.length).forEach((p, k) => expectClose(p, expected[k], 0.03));
            }
        }
    });

    test("slide 2: a connector flipped and rotated 180 degrees keeps its direction (the bug in extract_text_labels.py)", () => {
        const { scene } = convert(2);
        const line = scene.annotations.find((a) => a.source.type === "pptx-pointer-line" && a.source.shapeIds.includes("124"));
        const shown = displayedAnnotation(line, scene).points;
        // label end at the top right, target at the bottom left (rot=180 + flipH)
        const [labelEnd, target] = [shown[0], shown[shown.length - 1]];
        expect(target[0]).toBeLessThan(labelEnd[0]);
        expect(target[1]).toBeGreaterThan(labelEnd[1]);
        // the legacy extractor ignored flipH and would have drawn top-left to bottom-right
        const o = slide(2).objects.find((x) => x.id === "124");
        const ignoringFlip = [o.source.off, [o.source.off[0] + o.source.ext[0], o.source.off[1] + o.source.ext[1]]].map((p) => slidePx(scene, p));
        expect(Math.hypot(ignoringFlip[1][0] - target[0], ignoringFlip[1][1] - target[1])).toBeGreaterThan(50);
    });

    test.each([2, 3, 18])("slide %i: centered labels are centered on their PowerPoint text frame", (index) => {
        const { scene } = convert(index);
        for (const label of scene.annotations.filter((a) => a.type === "text" && a.align === "center")) {
            const object = slide(index).objects.find((o) => o.id === label.source.shapeId);
            const box = textBox(displayedAnnotation(label, scene));
            const frameCenter = slidePx(scene, [object.frame.x + object.frame.width / 2, 0])[0];
            expect(Math.abs(box.x + box.width / 2 - frameCenter)).toBeLessThanOrEqual(0.03);
        }
    });
});

describe("PowerPoint slide import: associations", () => {
    test("pointer lines belong to the label the author glued them to", () => {
        for (const index of [2, 3, 18]) {
            const { scene } = convert(index);
            const objects = new Map(slide(index).objects.map((o) => [o.id, o]));
            const labelByShape = new Map(scene.annotations.filter((a) => a.type === "text").map((a) => [a.source.shapeId, a.id]));
            for (const line of scene.annotations.filter((a) => a.source.type === "pptx-pointer-line")) {
                const glued = line.source.shapeIds.flatMap((id) => Object.values(objects.get(id).connections || {}).map((c) => c.shapeId));
                const gluedLabels = glued.filter((id) => labelByShape.has(id)).map((id) => labelByShape.get(id));
                expect(gluedLabels.length).toBeGreaterThan(0);
                expect(new Set(gluedLabels)).toEqual(new Set([line.labelId]));
            }
        }
    });

    test("a line glued to a highlighted region records that region (label-to-region link)", () => {
        const { scene } = convert(2);
        const line = scene.annotations.find((a) => a.source.shapeIds && a.source.shapeIds.includes("124"));
        expect(line.source.gluedTo).toEqual(["111"]);
        expect(scene.annotations.some((a) => a.source.type === "pptx-region" && a.source.shapeId === "111")).toBe(true);
    });

    test("a line hidden under a photo on the slide is left out and reported, not drawn on top", () => {
        const { scene, report } = convert(2);
        expect(scene.annotations.some((a) => a.source.shapeIds && a.source.shapeIds.includes("109"))).toBe(false);
        expect(report.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ shapeId: "109", reason: expect.stringContaining("hidden behind a photo") })]));
    });

    test("titles, navigation and buttons stay out of the scene", () => {
        const { scene, report } = convert(3);
        const texts = scene.annotations.filter((a) => a.type === "text").map((a) => a.text);
        expect(texts).not.toContain("Bony Pelvis");
        expect(texts).not.toContain("No labels");
        expect(report.skipped.map((s) => s.text || "")).toEqual(expect.arrayContaining([expect.stringContaining("Ilium")]));
    });
});

describe("PowerPoint slide import: editing after import", () => {
    /** Each linked annotation's points in its photo's normalized (0..1) frame, as currently drawn. */
    function normalized(scene) {
        const out = new Map();
        for (const a of scene.annotations) {
            if (!a.sourceImageId) continue;
            const image = scene.images.find((i) => i.id === a.sourceImageId);
            const shown = displayedAnnotation(a, scene);
            const pts = a.type === "text" ? [[textBox(shown).x + textBox(shown).width / 2, shown.y]] : shown.points;
            const cx = image.x + image.width / 2;
            const cy = image.y + image.height / 2;
            const r = (-(image.rotation || 0) * Math.PI) / 180;
            out.set(a.id, pts.map(([x, y]) => {
                let px = cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r);
                let py = cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r);
                if (image.flipX) px = 2 * cx - px;
                if (image.flipY) py = 2 * cy - py;
                return [(px - image.x) / image.width, (py - image.y) / image.height];
            }));
        }
        return out;
    }

    test("moving, resizing, rotating and flipping a photo keeps every linked label, line and highlight on the same anatomy", () => {
        const { scene } = convert(3);
        const before = normalized(scene);
        const edited = clone(scene);
        const photo = edited.images.find((i) => i.rotation);
        Object.assign(photo, { x: photo.x + 137, y: photo.y - 41, width: photo.width * 1.6, height: photo.height * 0.7, rotation: 33, flipX: true });
        const after = normalized(edited);
        let checked = 0;
        for (const [id, points] of before) {
            const annotation = edited.annotations.find((a) => a.id === id);
            if (annotation.sourceImageId !== photo.id || annotation.type === "text") continue;
            points.forEach((p, k) => {
                expect(after.get(id)[k][0]).toBeCloseTo(p[0], 6);
                expect(after.get(id)[k][1]).toBeCloseTo(p[1], 6);
            });
            checked += 1;
        }
        expect(checked).toBeGreaterThan(0);
    });

    test("saving through the API's validation and reloading changes nothing", () => {
        const { scene } = convert(2);
        const content = validateSceneContent(clone({ images: scene.images, annotations: scene.annotations, importLog: scene.importLog }));
        expect(content.error).toBeUndefined();
        const reloaded = { ...scene, ...JSON.parse(JSON.stringify(content)) };
        for (const a of scene.annotations) {
            expect(displayedAnnotation(reloaded.annotations.find((b) => b.id === a.id), reloaded)).toEqual(displayedAnnotation(a, scene));
        }
    });

    test("storing a dragged centered label keeps it centered (align survives the edit round trip)", () => {
        const { scene } = convert(3);
        const label = scene.annotations.find((a) => a.type === "text" && a.align === "center" && a.sourceImageId);
        const stored = clone(label);
        storeAnnotationGeometry(stored, displayedAnnotation(label, scene), scene);
        expect(stored.x).toBeCloseTo(label.x, 1);
        expect(stored.y).toBeCloseTo(label.y, 1);
    });

    test("the converter's copy of textBox matches sceneCanvas.textBox", () => {
        for (const align of [undefined, "center", "right"]) {
            const annotation = { type: "text", text: "Anterior\nSuperior Iliac\nSpine", x: 40, y: 12, fontSize: 10.67, align };
            const a = canvasTextBox(annotation);
            const b = textBox(annotation);
            expect([a.x, a.y, a.width, a.height]).toEqual([b.x, b.y, b.width, b.height]);
        }
    });
});

describe("PowerPoint slide import: repeatable and traceable", () => {
    test("converting twice gives identical scenes with stable, unique ids", () => {
        const first = convert(2).scene;
        const second = convert(2).scene;
        expect(second).toEqual(first);
        const ids = [...first.images, ...first.annotations].map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(first.id).toBe(stableUuid(ir.deck.key, "slide", slide(2).slideId));
    });

    test("ids are name-based UUID version 8 values from SHA-256 (RFC 9562)", () => {
        // Expected values computed independently with Python's hashlib and
        // uuid modules, which also report version 8 and the RFC variant.
        expect(stableUuid("bone-project-2", "slide", "256")).toBe("5ffc29fe-bf15-8f00-81c9-311588b4dabb");
        expect(stableUuid("bony-pelvis", "257", "12", "0")).toBe("f622f88c-1c87-8df8-8fdd-a982940e2e02");
    });

    test("repeated conversion of every fixture slide gives identical ids", () => {
        const idsOf = (scene) => [scene.id, ...scene.images.map((o) => o.id), ...scene.annotations.map((o) => o.id)];
        for (const { index } of ir.slides) {
            expect(idsOf(convert(index).scene)).toEqual(idsOf(convert(index).scene));
        }
        expect(stableUuid("deck", "257", "12", "0")).toBe(stableUuid("deck", "257", "12", "0"));
        expect(stableUuid("deck", 257, 12, 0)).toBe(stableUuid("deck", "257", "12", "0"));
    });

    test("different objects, slides and decks receive different ids", () => {
        const ids = [];
        for (const { index } of ir.slides) {
            const { scene } = convert(index);
            ids.push(scene.id, ...scene.images.map((o) => o.id), ...scene.annotations.map((o) => o.id));
        }
        expect(ids.length).toBeGreaterThan(40); // 3 scenes, 48 ids: guards against a vacuous check
        expect(new Set(ids).size).toBe(ids.length);

        const other = clone(ir);
        other.deck.key = "another-deck";
        const otherScene = convertSlide(other, 2, { mediaSrc, now: NOW }).scene;
        expect(otherScene.id).not.toBe(convert(2).scene.id);
        expect(otherScene.annotations.map((o) => o.id).filter((id) => ids.includes(id))).toEqual([]);

        // the encoding keeps part boundaries, so shifting text between parts changes the id
        expect(stableUuid("ab", "c")).not.toBe(stableUuid("a", "bc"));
        expect(stableUuid("a\u0000b", "c")).not.toBe(stableUuid("a", "b\u0000c"));
        expect(stableUuid("a", "b")).not.toBe(stableUuid("a,b"));
    });

    test("every id is a valid UUID string the scene store accepts", () => {
        const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        for (const { index } of ir.slides) {
            const { scene } = convert(index);
            for (const id of [scene.id, ...scene.images.map((o) => o.id), ...scene.annotations.map((o) => o.id)]) {
                expect(id).toMatch(UUID_V8);
                expect(isValidSceneId(id)).toBe(true);
            }
        }
    });

    test("every object records the deck, slide and shape it came from", () => {
        const { scene } = convert(2);
        for (const o of [...scene.images, ...scene.annotations]) {
            expect(o.source).toEqual(expect.objectContaining({ deck: ir.deck.key, slide: 2, slideId: slide(2).slideId, shapeId: expect.any(String) }));
        }
        expect(scene.importLog[0]).toEqual(expect.objectContaining({ kind: "pptx-import", contentHash: expect.any(String) }));
        expect(scene.importLog[0].deck.sha256).toBe(ir.deck.sha256);
    });

    test("labels without align render exactly as before (backward compatible)", () => {
        const plain = { type: "text", text: "Ilium", x: 10, y: 20, fontSize: 18 };
        expect(textBox(plain).x).toBe(10);
        const { svg } = renderScene({ images: [], annotations: [plain] });
        expect(svg.querySelector("text").getAttribute("text-anchor")).toBeNull();
    });
});
