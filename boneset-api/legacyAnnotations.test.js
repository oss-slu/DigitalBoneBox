// Tests for importing existing (legacy) labels, pointer lines, and colored regions
// into scenes. Issue #467 (parent #463).
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

// Keep scenes created by these tests out of boneset-api/data/scenes.
// This must be set before server.js is loaded.
const scenesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-annotation-import-test-"));
process.env.SCENES_DIR = scenesDir;

const { app, serverReady } = require("./server");
const { buildLegacyImages } = require("./legacyImport");
const {
    buildLegacyAnnotations,
    pathToPoints,
    slideToScene,
    SLIDE_WIDTH,
    SLIDE_HEIGHT,
} = require("./legacyAnnotations");

const ANNOTATIONS_DIR = path.join(__dirname, "data", "annotations");
const BOTH = { labels: true, regions: true };

beforeAll(() => serverReady);

afterAll(() => {
    fs.rmSync(scenesDir, { recursive: true, force: true });
});

function readLabels(boneId) {
    const file = path.join(ANNOTATIONS_DIR, "text_label_annotations", `${boneId}_text_annotations.json`);
    return JSON.parse(fs.readFileSync(file, "utf8")).text_annotations;
}

async function importBone(boneId, include = BOTH) {
    const { images, totalImages } = await buildLegacyImages(boneId);
    const result = await buildLegacyAnnotations(boneId, images, {
        include,
        allImagesImported: images.length === totalImages,
    });
    return { images, ...result };
}

// Every annotation must be an object the Scene Editor can draw (see templates/js/sceneCanvas.js).
function expectDrawable(annotation) {
    expect(typeof annotation.id).toBe("string");
    expect(annotation.source.type).toMatch(/^legacy-/);
    switch (annotation.type) {
        case "text":
            expect(annotation.text.length).toBeGreaterThan(0);
            expect(Number.isFinite(annotation.x) && Number.isFinite(annotation.y)).toBe(true);
            break;
        case "line":
        case "arrow":
            if (annotation.points) {
                expect(annotation.points.length).toBeGreaterThanOrEqual(2);
            } else {
                expect([annotation.x1, annotation.y1, annotation.x2, annotation.y2].every(Number.isFinite)).toBe(true);
            }
            break;
        case "polygon":
            expect(annotation.points.length).toBeGreaterThanOrEqual(3);
            expect(annotation.points.flat().every(Number.isFinite)).toBe(true);
            break;
        default:
            throw new Error(`Unexpected annotation type: ${annotation.type}`);
    }
}

// One item from every boneset that has both labels and colored regions.
const SAMPLES = [
    { boneId: "ilium", boneset: "bony_pelvis" },
    { boneId: "anterior_mandible", boneset: "skull" },
    { boneId: "first_rib_head_and_neck", boneset: "thorax" },
    { boneId: "atlas", boneset: "vertebrae" },
    { boneId: "hand_metacarpals", boneset: "upper_limb" },
    { boneId: "femur_head", boneset: "lower_limb" },
];

describe("buildLegacyAnnotations - Issue 467", () => {
    describe.each(SAMPLES)("$boneId ($boneset)", ({ boneId }) => {
        let result;
        beforeAll(async () => {
            result = await importBone(boneId);
        });

        it("imports every label with its text", () => {
            const labels = readLabels(boneId);
            const texts = result.annotations.filter((a) => a.type === "text").map((a) => a.text);
            expect(texts).toEqual(labels.map((label) => label.text_content.replace(/\s+/g, " ").trim()));
            expect(result.counts.labels).toBe(labels.length);
        });

        it("imports every pointer line", () => {
            const lineCount = readLabels(boneId).reduce((sum, label) => sum + (label.pointer_lines || []).length, 0);
            expect(result.counts.lines).toBe(lineCount);
        });

        it("imports colored regions", () => {
            expect(result.counts.regions).toBeGreaterThan(0);
        });

        it("only creates objects the Scene Editor can draw", () => {
            result.annotations.forEach(expectDrawable);
        });
    });

    it("places newer-format colored regions on each image", async () => {
        const { images, annotations } = await importBone("femur_head", { regions: true });
        const regions = annotations.filter((a) => a.source.type === "legacy-colored-region");

        expect(regions.length % images.length).toBe(0);
        for (const region of regions) {
            const image = images.find((candidate) => candidate.id === region.source.imageId);
            for (const [x, y] of region.points) {
                expect(x).toBeGreaterThanOrEqual(image.x - 1);
                expect(x).toBeLessThanOrEqual(image.x + image.width + 1);
                expect(y).toBeGreaterThanOrEqual(image.y - 1);
                expect(y).toBeLessThanOrEqual(image.y + image.height + 1);
            }
        }
    });

    it("notes that older-format regions may differ from the hand-tuned viewer", async () => {
        const { warnings } = await importBone("ilium", { regions: true });
        expect(warnings).toEqual([expect.objectContaining({ item: "colored regions", reason: expect.stringMatching(/Older format/) })]);
    });

    it("imports only the kinds of annotation that were selected", async () => {
        const labelsOnly = await importBone("ilium", { labels: true });
        expect(labelsOnly.annotations.some((a) => a.type === "polygon")).toBe(false);
        expect(labelsOnly.counts.labels).toBeGreaterThan(0);

        const regionsOnly = await importBone("ilium", { regions: true });
        expect(regionsOnly.annotations.every((a) => a.type === "polygon")).toBe(true);

        const nothing = await importBone("ilium", {});
        expect(nothing.annotations).toEqual([]);
    });

    it("records labels it skips when only some images were imported", async () => {
        const { images } = await buildLegacyImages("ilium", { filenames: ["ilium_image1.jpg"] });
        const result = await buildLegacyAnnotations("ilium", images, { include: BOTH, allImagesImported: false });

        expect(result.counts.labels).toBe(0);
        expect(result.warnings).toContainEqual(expect.objectContaining({ item: "labels and pointer lines" }));
        // Older-format regions belonging to the image that wasn't imported are reported too.
        expect(result.warnings).toContainEqual(expect.objectContaining({ reason: "Its image wasn't imported" }));
    });

    describe("with test data", () => {
        let dir;
        const image = { id: "img", x: 100, y: 50, width: 200, height: 100, source: { index: 0 } };

        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-annotation-data-"));
            fs.mkdirSync(path.join(dir, "text_label_annotations"));
            fs.mkdirSync(path.join(dir, "ColoredRegions"));
            fs.writeFileSync(path.join(dir, "text_label_annotations", "test_bone_text_annotations.json"), JSON.stringify({
                text_annotations: [
                    {
                        annotation_id: "good",
                        text_content: "Good Label",
                        text_box: { x: 0, y: 0, width: SLIDE_WIDTH / 2, height: SLIDE_HEIGHT / 2 },
                        pointer_lines: [{ start_point: { x: 0, y: 0 }, end_point: { x: SLIDE_WIDTH, y: SLIDE_HEIGHT } }],
                    },
                    { annotation_id: "no-position", text_content: "Lost Label" },
                ],
            }));
            fs.writeFileSync(path.join(dir, "ColoredRegions", "test_bone_colored_regions.json"), JSON.stringify({
                image_dimensions: { width: 1000, height: 1000 },
                colored_regions: [
                    {
                        anatomical_name: "Square",
                        color: "008000",
                        path_data: [{ commands: [
                            { type: "moveTo", x: 0, y: 0 },
                            { type: "lineTo", x: 1000, y: 0 },
                            { type: "lineTo", x: 1000, y: 1000 },
                            { type: "lineTo", x: 0, y: 1000 },
                            { type: "close" },
                        ] }],
                    },
                    { anatomical_name: "Broken", color: "008000", path_data: [{ commands: [{ type: "arcTo" }] }] },
                ],
            }));
        });
        afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

        const run = () => buildLegacyAnnotations("test_bone", [image], { include: BOTH, annotationsDir: dir });

        it("maps a colored region onto its image", async () => {
            const square = (await run()).annotations.find((a) => a.type === "polygon");
            expect(square.points).toEqual([[100, 50], [300, 50], [300, 150], [100, 150]]);
            expect(square).toMatchObject({ fill: "#008000", opacity: 0.4 });
        });

        it("maps labels and pointer lines from slide units onto the bone's images", async () => {
            const { annotations } = await run();
            const line = annotations.find((a) => a.type === "line");
            // With no crop template in the test folder the whole slide maps onto the image.
            expect(line).toMatchObject({ x1: 100, y1: 50, x2: 300, y2: 150 });
            expect(annotations.find((a) => a.type === "text").text).toBe("Good Label");
        });

        it("records what couldn't be converted instead of silently skipping it", async () => {
            const { warnings, counts } = await run();
            expect(counts).toEqual({ labels: 1, lines: 1, regions: 1 });
            expect(warnings).toEqual([
                { item: "label no-position", reason: "Label has no text or no position" },
                { item: "Broken", reason: "Colored region outline couldn't be converted" },
            ]);
        });
    });

    it("pathToPoints approximates curves and rejects unknown commands", () => {
        const points = pathToPoints([
            { type: "moveTo", x: 0, y: 0 },
            { type: "cubicBezTo", x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 },
            { type: "close" },
        ]);
        expect(points).toHaveLength(9);
        expect(points[8]).toEqual([10, 0]);
        expect(pathToPoints([{ type: "arcTo", x: 1, y: 1 }])).toBeNull();
    });

    it("slideToScene maps the slide crop onto a box", () => {
        const toScene = slideToScene({ x: 10, y: 20, width: 100, height: 50 }, { normX: 0.5, normY: 0, normW: 0.5, normH: 1 });
        expect(toScene(SLIDE_WIDTH / 2, 0)).toEqual({ x: 10, y: 20 });
        expect(toScene(SLIDE_WIDTH, SLIDE_HEIGHT)).toEqual({ x: 110, y: 70 });
    });
});

describe("POST /api/scenes/:sceneId/import-legacy with annotations - Issue 467", () => {
    const createScene = async (name) => (await request(app).post("/api/scenes").send({ name })).body;
    const importInto = (sceneId, body) => request(app).post(`/api/scenes/${sceneId}/import-legacy`).send(body);

    it("adds the selected annotations to the scene and saves them", async () => {
        const scene = await createScene("Ilium With Labels");
        const response = await importInto(scene.id, { boneId: "ilium", annotations: BOTH });

        expect(response.statusCode).toBe(200);
        const { labels, lines, regions } = response.body.importedAnnotations;
        expect(labels).toBeGreaterThan(0);
        expect(regions).toBeGreaterThan(0);
        expect(response.body.scene.annotations).toHaveLength(labels + lines + regions);
        response.body.scene.annotations.forEach(expectDrawable);

        const reopened = await request(app).get(`/api/scenes/${scene.id}`);
        expect(reopened.body.annotations).toEqual(response.body.scene.annotations);
    });

    it("records each import, including notes about anything not converted, on the scene", async () => {
        const scene = await createScene("Import Log");
        await importInto(scene.id, { boneId: "ilium", annotations: { regions: true } });
        await importInto(scene.id, { boneId: "femur_head" });

        const { body } = await request(app).get(`/api/scenes/${scene.id}`);
        expect(body.importLog).toHaveLength(2);
        expect(body.importLog[0]).toMatchObject({ boneId: "ilium", images: 2 });
        expect(body.importLog[0].warnings).toContainEqual(expect.objectContaining({ item: "colored regions" }));
        expect(body.importLog[1]).toMatchObject({ boneId: "femur_head", annotations: { labels: 0, lines: 0, regions: 0 } });
    });

    it("imports no annotations unless they are requested", async () => {
        const scene = await createScene("Images Only");
        const response = await importInto(scene.id, { boneId: "ilium" });
        expect(response.body.scene.annotations).toEqual([]);
    });

    it("rejects an invalid annotations option", async () => {
        const scene = await createScene("Bad Annotations Option");
        expect((await importInto(scene.id, { boneId: "ilium", annotations: true })).statusCode).toBe(400);
        expect((await importInto(scene.id, { boneId: "ilium", annotations: { labels: "yes" } })).statusCode).toBe(400);
        expect((await importInto(scene.id, { boneId: "ilium", annotations: { notes: true } })).statusCode).toBe(400);
    });
});