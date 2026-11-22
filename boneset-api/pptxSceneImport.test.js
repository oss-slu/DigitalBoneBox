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
const { convertSlide, canvasTextBox, flattenCommands, stableUuid, contentHash, CONVERTER_VERSION } = require("./pptxSceneImport");
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

        const moved = clone(ir);
        moved.slides.find((s) => s.index === 2).slideId = "999";
        const movedScene = convertSlide(moved, 2, { mediaSrc, now: NOW }).scene;
        expect(movedScene.id).not.toBe(convert(2).scene.id);
        expect(movedScene.images.map((o) => o.id).filter((id) => ids.includes(id))).toEqual([]);

        // the scene name is not part of the identity
        const retitled = clone(ir);
        retitled.slides.find((s) => s.index === 2).title = "A different title";
        const retitledScene = convertSlide(retitled, 2, { mediaSrc, now: NOW }).scene;
        expect(retitledScene.name).not.toBe(convert(2).scene.name);
        expect(retitledScene.id).toBe(convert(2).scene.id);

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
        expect(svg.querySelector("text").getAttribute("text-anchor")).toBe("middle");
    });
});

// ---------------------------------------------------------------- the import command
//
// These run boneset-api/scripts/import-pptx-scenes.js against a scratch scene
// store and images folder. The fixture IR's media are replaced by small files
// written next to a copy of it (one of them a copy of a real legacy bone
// image), so the importer's hashing, reuse and copying run for real.
describe("PowerPoint import command: preflight, identity, names and images", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const crypto = require("crypto");
    const { Buffer } = require("buffer"); // Jest's jsdom environment has no global Buffer
    const { run, sourceIdentity, IMPORTED_IMAGES_SUBDIR, FAILED_ACTION } = require("./scripts/import-pptx-scenes");
    const { resolveSceneStore } = require("./scenes");
    const { buildImageCatalog } = require("./images");

    const LEGACY_IMAGE = path.join(__dirname, "data", "images", "Clavicle_Top_Image.jpg");
    const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
    let workspaces = [];
    let log;

    beforeEach(() => {
        log = jest.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
        log.mockRestore();
        for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
        workspaces = [];
    });

    function workspace() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-import-test-"));
        workspaces.push(root);
        const irDir = path.join(root, "import");
        const imagesDir = path.join(root, "images");
        fs.mkdirSync(path.join(irDir, "media"), { recursive: true });
        fs.mkdirSync(imagesDir);
        const legacyBytes = fs.readFileSync(LEGACY_IMAGE);
        fs.writeFileSync(path.join(imagesDir, "Legacy_Bone_Image.jpg"), legacyBytes);
        fs.copyFileSync(path.join(__dirname, "data", "images", "Clavicle_Bottom_Image.jpg"), path.join(imagesDir, "Clavicle_Bottom_Image.jpg"));

        const data = clone(ir);
        const media = {};
        const shas = Object.keys(data.media);
        const renamed = new Map();
        shas.forEach((sha, i) => {
            const bytes = i === 0 ? legacyBytes : Buffer.from(`pptx import test image ${i}`);
            const next = sha256(bytes);
            const file = `media/${next.slice(0, 16)}${i === 0 ? ".jpg" : ".png"}`;
            fs.writeFileSync(path.join(irDir, file), bytes);
            renamed.set(sha, { sha: next, file });
            media[next] = { ...data.media[sha], file };
        });
        data.media = media;
        for (const s of data.slides) {
            for (const o of s.objects) {
                if (!o.picture) continue;
                const r = renamed.get(o.picture.mediaSha256);
                o.picture.mediaSha256 = r.sha;
                o.picture.mediaFile = r.file;
            }
        }
        const irPath = path.join(irDir, `${data.deck.key}.ir.json`);
        const write = () => fs.writeFileSync(irPath, JSON.stringify(data));
        write();
        const env = { SCENES_DIR: path.join(root, "scenes") };
        const store = resolveSceneStore(env);
        const importDeck = (...extra) => run(["--ir", irPath, "--images-dir", imagesDir, ...extra], env);
        return { root, irDir, imagesDir, data, write, store, importDeck, legacyBytes };
    }

    function filesUnder(folder) {
        const out = {};
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else out[path.relative(folder, full)] = sha256(fs.readFileSync(full));
            }
        };
        walk(folder);
        return out;
    }

    const idsOf = (scenes) => Object.fromEntries(scenes.map((s) => [s.id, [...s.images, ...s.annotations].map((o) => o.id)]));
    const actions = (results) => results.map((r) => r.action);

    test("re-importing the same deck keeps every scene and object id and creates nothing new", async () => {
        const w = workspace();
        expect(actions(await w.importDeck())).toEqual(["created", "created", "created"]);
        const first = await w.store.list();
        const images = filesUnder(w.imagesDir);

        expect(actions(await w.importDeck())).toEqual(["unchanged", "unchanged", "unchanged"]);
        const second = await w.store.list();
        expect(second).toHaveLength(3);
        expect(idsOf(second)).toEqual(idsOf(first));
        expect(filesUnder(w.imagesDir)).toEqual(images);
        for (const { index } of ir.slides) expect(Object.keys(idsOf(second))).toContain(convert(index).scene.id);
    });

    test("images are reused by content hash, copied once, and legacy images stay untouched", async () => {
        const w = workspace();
        const catalogBefore = await buildImageCatalog({ imagesDir: w.imagesDir, descriptionsDir: w.irDir });
        const topLevelBefore = fs.readdirSync(w.imagesDir).sort();
        const legacyBefore = filesUnder(w.imagesDir);

        await w.importDeck();
        await w.importDeck();

        const scenes = await w.store.list();
        const srcs = new Set(scenes.flatMap((s) => s.images.map((i) => i.src)).filter((src) => !src.startsWith("data:")));
        expect(srcs).toContain("/api/images/Legacy_Bone_Image.jpg"); // reused, not copied
        const copied = fs.readdirSync(path.join(w.imagesDir, IMPORTED_IMAGES_SUBDIR));
        expect(copied).toHaveLength(Object.keys(w.data.media).length - 1); // every other image exactly once
        for (const name of copied) expect(srcs).toContain(`/api/images/${IMPORTED_IMAGES_SUBDIR}/${name}`);
        for (const src of srcs) expect(src).toMatch(/^\/api\/images\//);

        const after = filesUnder(w.imagesDir);
        for (const [name, hash] of Object.entries(legacyBefore)) expect(after[name]).toBe(hash);
        expect(fs.readdirSync(w.imagesDir).sort()).toEqual([...topLevelBefore, IMPORTED_IMAGES_SUBDIR].sort());
        const catalogAfter = await buildImageCatalog({ imagesDir: w.imagesDir, descriptionsDir: w.irDir });
        expect(catalogAfter.images.map((i) => i.filename)).toEqual(catalogBefore.images.map((i) => i.filename));
    });

    test("renaming a scene changes neither its id nor its source, and re-imports keep the new name", async () => {
        const w = workspace();
        await w.importDeck();
        const sceneId = convert(2).scene.id;
        const original = await w.store.get(sceneId);
        await w.store.save({ ...original, name: "My pelvis notes" });

        let results = await w.importDeck();
        expect(results.find((r) => r.report.slide === 2)).toEqual(expect.objectContaining({ action: "unchanged", sceneId, name: "My pelvis notes" }));

        // a changed image on the slide makes the import update the scene in place
        const bytes = Buffer.from("a replacement image");
        const next = sha256(bytes);
        fs.writeFileSync(path.join(w.irDir, `media/${next.slice(0, 16)}.png`), bytes);
        const picture = w.data.slides.find((s) => s.index === 2).objects.find((o) => o.picture).picture;
        picture.mediaSha256 = next;
        picture.mediaFile = `media/${next.slice(0, 16)}.png`;
        w.write();
        results = await w.importDeck();
        expect(results.find((r) => r.report.slide === 2)).toEqual(expect.objectContaining({ action: "updated", sceneId }));

        const updated = await w.store.get(sceneId);
        expect(updated.name).toBe("My pelvis notes");
        expect(updated.id).toBe(sceneId);
        expect(updated.createdAt).toBe(original.createdAt);
        const sources = updated.importLog.map((e) => sourceIdentity(e.deck.key, e.slide.slideId));
        expect(new Set(sources)).toEqual(new Set([sourceIdentity(ir.deck.key, slide(2).slideId)]));
        expect(updated.images.every((i) => i.source.deck === ir.deck.key && i.source.slideId === slide(2).slideId)).toBe(true);
        expect(await w.store.list()).toHaveLength(3);
    });

    const userScene = (name) => ({ id: crypto.randomUUID(), name, images: [], annotations: [], status: "draft", createdAt: NOW, updatedAt: NOW });
    const copiedImages = (w) => {
        const folder = path.join(w.imagesDir, IMPORTED_IMAGES_SUBDIR);
        return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    };

    test("a duplicate scene name creates no scene and copies no image, in a dry run or a real one", async () => {
        const w = workspace();
        const taken = userScene(convert(2).scene.name.toUpperCase()); // names compare without case, as the API does
        await w.store.save(taken);
        const legacyBefore = filesUnder(w.imagesDir);

        for (const extra of [["--dry-run"], []]) {
            const results = await w.importDeck(...extra);
            expect(results.find((r) => r.report.slide === 2).action).toBe(`rejected: a scene named "${taken.name}" already exists (${taken.id})`);
            expect(results.filter((r) => r.report.slide !== 2).map((r) => r.action)).toEqual(["not saved: 1 slide(s) rejected", "not saved: 1 slide(s) rejected"]);
            expect(results.some((r) => FAILED_ACTION.test(r.action))).toBe(true); // the command exits with status 1
        }
        expect((await w.store.list()).map((s) => s.id)).toEqual([taken.id]);
        expect(await w.store.get(taken.id)).toEqual(taken);
        expect(copiedImages(w)).toEqual([]);
        expect(filesUnder(w.imagesDir)).toEqual(legacyBefore);
    });

    test("a rejected later slide leaves no earlier new scene or image behind", async () => {
        const w = workspace();
        const taken = userScene(convert(18).scene.name); // the last slide clashes; slides 2 and 3 are valid and new
        await w.store.save(taken);
        const legacyBefore = filesUnder(w.imagesDir);

        const results = await w.importDeck();
        expect(results.map((r) => [r.report.slide, r.action.split(":")[0]])).toEqual([[2, "not saved"], [3, "not saved"], [18, "rejected"]]);
        expect((await w.store.list()).map((s) => s.id)).toEqual([taken.id]);
        for (const { index } of ir.slides) expect(await w.store.get(convert(index).scene.id)).toBeNull();
        expect(copiedImages(w)).toEqual([]);
        expect(filesUnder(w.imagesDir)).toEqual(legacyBefore);
        expect(fs.readFileSync(path.join(w.irDir, `${w.data.deck.key}.import-report.md`), "utf8")).toMatch(/No scenes were saved and no images were copied/);

        // once the conflict is gone, the same import goes through
        await w.store.remove(taken.id);
        expect(actions(await w.importDeck())).toEqual(["created", "created", "created"]);
        expect(copiedImages(w)).toHaveLength(Object.keys(w.data.media).length - 1);
    });

    test("two slides of one import that end up with the same name are rejected before anything is saved", async () => {
        const w = workspace();
        const long = "Posterior view of the bony pelvis ".repeat(4); // names are cut to 100 characters
        w.data.slides.find((s) => s.index === 3).title = long;
        w.data.slides.find((s) => s.index === 18).title = long;
        w.write();
        expect(convertSlide(w.data, 3, { mediaSrc, now: NOW }).scene.name).toBe(convertSlide(w.data, 18, { mediaSrc, now: NOW }).scene.name);

        const results = await w.importDeck();
        expect(results.find((r) => r.report.slide === 18).action).toMatch(/^rejected: slide 3 of this import already uses the name/);
        expect(results.filter((r) => r.report.slide !== 18).map((r) => r.action)).toEqual(["not saved: 1 slide(s) rejected", "not saved: 1 slide(s) rejected"]);
        expect(await w.store.list()).toEqual([]);
        expect(copiedImages(w)).toEqual([]);
    });

    test("the same deck under another deck key gets new identities, and its duplicate names are rejected", async () => {
        const w = workspace();
        await w.importDeck();
        const before = filesUnder(w.imagesDir);
        w.data.deck.key = "bony-pelvis-copy";
        w.write();
        const results = await w.importDeck();
        expect(results.every((r) => r.action.startsWith("rejected: a scene named"))).toBe(true);
        expect(await w.store.list()).toHaveLength(3);
        const otherIds = w.data.slides.map((s) => convertSlide(w.data, s.index, { mediaSrc, now: NOW }).scene.id);
        for (const id of otherIds) expect(await w.store.get(id)).toBeNull();
        expect(filesUnder(w.imagesDir)).toEqual(before);
    });

    test("a scene saved by the earlier SHA-1 converter is found by deck key and slide id and updated in place", async () => {
        const w = workspace();
        await w.importDeck();
        const newId = convert(3).scene.id;
        const current = await w.store.get(newId);
        // What converter 0.1.0 (SHA-1, UUID version 5) stored for this slide: its
        // own scene id and object ids, and the content hash of that content.
        const oldSceneId = "f72746f2-ee25-585b-a060-c4786072e411";
        const remap = new Map();
        const oldContent = JSON.parse(JSON.stringify({ images: current.images, annotations: current.annotations })
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => {
                if (!remap.has(id)) remap.set(id, crypto.randomUUID());
                return remap.get(id);
            }));
        const oldLog = { ...current.importLog[0], converter: { name: "pptxSceneImport.js", version: "0.1.0" }, contentHash: contentHash(oldContent) };
        await w.store.save({ ...current, id: oldSceneId, ...oldContent, importLog: [oldLog] });
        await w.store.remove(newId);

        const results = await w.importDeck();
        expect(results.find((r) => r.report.slide === 3)).toEqual(expect.objectContaining({ action: "updated", sceneId: oldSceneId }));
        expect(await w.store.get(newId)).toBeNull();
        expect(await w.store.list()).toHaveLength(3);
        const updated = await w.store.get(oldSceneId);
        expect(updated.importLog.map((e) => e.converter.version)).toEqual(["0.1.0", CONVERTER_VERSION]);
        expect(updated.images.map((i) => i.id)).toEqual(current.images.map((i) => i.id));
        expect(actions(await w.importDeck())).toEqual(["unchanged", "unchanged", "unchanged"]);
    });

    test("identical image bytes are copied once, even under two media file names", async () => {
        const w = workspace();
        // slides 2 and 3 show the same photo; give slide 3's copy of it a second file name
        const twin = w.data.slides.find((s) => s.index === 3).objects.find((o) => o.picture && o.picture.mediaFile.endsWith(".png")).picture;
        const first = w.data.slides.find((s) => s.index === 2).objects.find((o) => o.picture && o.picture.mediaSha256 === twin.mediaSha256).picture;
        expect(first.mediaFile).toBe(twin.mediaFile);
        fs.copyFileSync(path.join(w.irDir, twin.mediaFile), path.join(w.irDir, "media", "same-bytes-again.png"));
        twin.mediaFile = "media/same-bytes-again.png";
        w.write();
        await w.importDeck();
        const hashes = Object.values(filesUnder(path.join(w.imagesDir, IMPORTED_IMAGES_SUBDIR)));
        expect(new Set(hashes).size).toBe(hashes.length);
        expect(hashes).toHaveLength(Object.keys(w.data.media).length - 1);
    });

    test("a scene kept because it was edited does not pull its new images in", async () => {
        const w = workspace();
        await w.importDeck();
        const sceneId = convert(2).scene.id;
        const scene = await w.store.get(sceneId);
        await w.store.save({ ...scene, annotations: scene.annotations.slice(1) }); // edited in the editor
        const before = copiedImages(w).sort();

        const bytes = Buffer.from("an image only slide 2 would use");
        const next = sha256(bytes);
        fs.writeFileSync(path.join(w.irDir, `media/${next.slice(0, 16)}.png`), bytes);
        const picture = w.data.slides.find((s) => s.index === 2).objects.find((o) => o.picture).picture;
        picture.mediaSha256 = next;
        picture.mediaFile = `media/${next.slice(0, 16)}.png`;
        w.write();

        const results = await w.importDeck();
        expect(results.find((r) => r.report.slide === 2).action).toBe("kept (edited since import; use --force)");
        expect(copiedImages(w).sort()).toEqual(before);
        expect(actions(await w.importDeck("--force"))).toContain("replaced (--force)");
        expect(copiedImages(w)).toContain(`${next.slice(0, 16)}.png`);
    });

    test("media outside the IR folder, through a symlink, or not matching its hash is rejected before anything is written", async () => {
        const w = workspace();
        const picture = w.data.slides.find((s) => s.index === 2).objects.find((o) => o.picture && o.picture.mediaFile.endsWith(".png")).picture;
        const outside = path.join(w.root, "outside.png");
        fs.copyFileSync(path.join(w.irDir, picture.mediaFile), outside);
        const original = picture.mediaFile;
        const expectNothingWritten = (results, reason) => {
            expect(results.find((r) => r.report.slide === 2).action).toMatch(reason);
            // slide 3 uses the same image, so it can be rejected too; nothing is saved either way
            expect(results.filter((r) => r.report.slide !== 2).every((r) => /^(not saved|rejected)/.test(r.action))).toBe(true);
        };

        picture.mediaFile = "../outside.png";
        w.write();
        expectNothingWritten(await w.importDeck(), /^rejected: Media file .* is outside the IR folder/);

        picture.mediaFile = original;
        w.write();
        fs.writeFileSync(path.join(w.irDir, original), "tampered");
        expectNothingWritten(await w.importDeck(), /^rejected: .*does not match its sha256/);

        let linked = true;
        try {
            fs.rmSync(path.join(w.irDir, original));
            fs.symlinkSync(outside, path.join(w.irDir, original));
        } catch {
            linked = false;
        }
        if (linked) expectNothingWritten(await w.importDeck(), /^rejected: Media file .* is outside the IR folder/);
        expect(await w.store.list()).toEqual([]);
        expect(copiedImages(w)).toEqual([]);
    });

    test("an existing image file is never overwritten, and the clash is found before anything is written", async () => {
        const w = workspace();
        const picture = w.data.slides.find((s) => s.index === 2).objects.find((o) => o.picture && o.picture.mediaFile.endsWith(".png")).picture;
        const target = path.join(w.imagesDir, IMPORTED_IMAGES_SUBDIR, path.basename(picture.mediaFile));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "someone else's file");
        const results = await w.importDeck();
        expect(results.filter((r) => r.action.includes("already exists with different content")).length).toBeGreaterThan(0);
        expect(fs.readFileSync(target, "utf8")).toBe("someone else's file");
        expect(copiedImages(w)).toEqual([path.basename(target)]);
        expect(await w.store.list()).toEqual([]);
    });

    test("if writing an image fails, the images this run wrote are removed and no scene is saved", async () => {
        const w = workspace();
        const realWrite = fs.writeFileSync;
        let imageWrites = 0;
        const spy = jest.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
            if (String(file).includes(`${path.sep}${IMPORTED_IMAGES_SUBDIR}${path.sep}`)) {
                imageWrites += 1;
                if (imageWrites === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
            }
            return realWrite(file, ...rest);
        });
        try {
            await expect(w.importDeck()).rejects.toThrow(/disk full\. No scenes were saved, and the 1 image\(s\) this run had written were removed/);
        } finally {
            spy.mockRestore();
        }
        expect(copiedImages(w)).toEqual([]);
        expect(await w.store.list()).toEqual([]);
    });
});
