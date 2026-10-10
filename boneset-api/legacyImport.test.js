// Tests for importing existing (legacy) bone images into scenes. Issue #466 (parent #463).
const { Buffer } = require("buffer"); // explicit: Jest's jsdom environment has no global Buffer
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

// Keep scenes created by these tests out of boneset-api/data/scenes.
// This must be set before server.js is loaded.
const scenesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-import-test-"));
process.env.SCENES_DIR = scenesDir;

const { app, serverReady } = require("./server");
const { buildLegacyImages, fitWithin, nextRowY, MAX_IMAGE_SIZE, IMAGE_GAP } = require("./legacyImport");

const DESCRIPTIONS_DIR = path.join(__dirname, "data", "descriptions");

beforeAll(() => serverReady);

afterAll(() => {
    fs.rmSync(scenesDir, { recursive: true, force: true });
});

function readDescriptionImages(boneId) {
    const file = path.join(DESCRIPTIONS_DIR, `${boneId}_description.json`);
    return JSON.parse(fs.readFileSync(file, "utf8")).images;
}

// A minimal PNG header: enough for the image catalog to read width and height.
function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    buffer.writeUInt32BE(0x89504e47, 0);
    buffer.writeUInt32BE(0x0d0a1a0a, 4);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

// One item from every boneset, covering portrait, landscape, and square images.
const SAMPLES = [
    { boneId: "ilium", boneset: "bony_pelvis" },
    { boneId: "anterior_mandible", boneset: "skull" },
    { boneId: "sternum", boneset: "thorax" },
    { boneId: "atlas", boneset: "vertebrae" },
    { boneId: "humerus", boneset: "upper_limb" },
    { boneId: "femur", boneset: "lower_limb" },
];

describe("buildLegacyImages - Issue 466", () => {
    describe.each(SAMPLES)("$boneId ($boneset)", ({ boneId }) => {
        let result;
        beforeAll(async () => {
            result = await buildLegacyImages(boneId);
        });

        it("imports every image the viewer shows, in the same order", () => {
            expect(result.warnings).toEqual([]);
            expect(result.images.map((image) => image.source.filename)).toEqual(readDescriptionImages(boneId));
        });

        it("points each image at its original, unchanged URL", () => {
            for (const image of result.images) {
                expect(image.src).toBe(`/api/images/${encodeURIComponent(image.source.filename)}`);
                expect(image.source).toMatchObject({ type: "legacy-image", boneId });
            }
        });

        it("keeps each image's proportions and fits it within the maximum size", () => {
            for (const image of result.images) {
                const { naturalWidth, naturalHeight } = image.source;
                expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(MAX_IMAGE_SIZE);
                expect(image.width / image.height).toBeCloseTo(naturalWidth / naturalHeight, 1);
                expect(image.rotation).toBe(0);
            }
        });

        it("lays the images out left to right without overlapping", () => {
            for (let i = 1; i < result.images.length; i += 1) {
                const previous = result.images[i - 1];
                expect(result.images[i].x).toBe(previous.x + previous.width + IMAGE_GAP);
                expect(result.images[i].y).toBe(previous.y);
            }
        });
    });

    it("handles portrait, landscape, and square images", async () => {
        const shapes = new Set();
        for (const boneId of ["humerus", "atlas", "cervical_body"]) {
            for (const image of (await buildLegacyImages(boneId)).images) {
                const ratio = image.width / image.height;
                shapes.add(ratio < 0.9 ? "portrait" : ratio > 1.1 ? "landscape" : "square");
            }
        }
        expect([...shapes].sort()).toEqual(["landscape", "portrait", "square"]);
    });

    it("imports only the selected images, keeping the viewer's order", async () => {
        const all = readDescriptionImages("cervical_body");
        const { images, warnings } = await buildLegacyImages("cervical_body", { filenames: [all[2], all[0]] });

        expect(warnings).toEqual([]);
        expect(images.map((image) => image.source.filename)).toEqual([all[0], all[2]]);
        expect(images[0].x).toBe(0);
    });

    it("reports a selected file that isn't one of the bone's images", async () => {
        const { images, warnings } = await buildLegacyImages("ilium", { filenames: ["femur_image.png"] });

        expect(images).toEqual([]);
        expect(warnings).toEqual([{ filename: "femur_image.png", reason: "Not an image of this bone" }]);
    });

    it("rejects an invalid boneId and reports an unknown one", async () => {
        await expect(buildLegacyImages("../server")).rejects.toMatchObject({ status: 400 });
        await expect(buildLegacyImages("not_a_real_bone")).rejects.toMatchObject({ status: 404 });
    });

    describe("with test data", () => {
        let dir;
        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-import-data-"));
            fs.mkdirSync(path.join(dir, "descriptions"));
            fs.mkdirSync(path.join(dir, "images"));
            fs.writeFileSync(path.join(dir, "images", "big.png"), pngHeader(2000, 1000));
            fs.writeFileSync(path.join(dir, "descriptions", "test_bone_description.json"), JSON.stringify({
                id: "test_bone",
                name: "Test Bone",
                images: ["big.png", "missing.png", "../secret.png"],
            }));
        });
        afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

        const options = () => ({
            descriptionsDir: path.join(dir, "descriptions"),
            imagesDir: path.join(dir, "images"),
            origin: { x: 10, y: 500 },
        });

        it("scales large images down and starts at the given position", async () => {
            const { images } = await buildLegacyImages("test_bone", options());
            expect(images).toHaveLength(1);
            expect(images[0]).toMatchObject({ x: 10, y: 500, width: 480, height: 240 });
        });

        it("records images that couldn't be imported instead of skipping them silently", async () => {
            const { warnings } = await buildLegacyImages("test_bone", options());
            expect(warnings).toEqual([
                { filename: "missing.png", reason: "Image file not found" },
                { filename: "../secret.png", reason: "Invalid image file name" },
            ]);
        });
    });

    it("fitWithin never scales small images up", () => {
        expect(fitWithin(100, 50, 480)).toEqual({ width: 100, height: 50 });
        expect(fitWithin(960, 480, 480)).toEqual({ width: 480, height: 240 });
    });

    it("nextRowY starts a new row below existing images", () => {
        expect(nextRowY({ images: [] })).toBe(0);
        expect(nextRowY({ images: [{ y: 0, height: 300 }, { y: 20, height: 400 }] })).toBe(420 + IMAGE_GAP);
    });
});

describe("POST /api/scenes/:sceneId/import-legacy - Issue 466", () => {
    const createScene = async (name) => (await request(app).post("/api/scenes").send({ name })).body;
    const importInto = (sceneId, boneId, filenames) =>
        request(app).post(`/api/scenes/${sceneId}/import-legacy`).send(filenames ? { boneId, filenames } : { boneId });

    it("links a bone's images to a scene and saves them", async () => {
        const scene = await createScene("Import Ilium");
        const response = await importInto(scene.id, "ilium");

        expect(response.statusCode).toBe(200);
        expect(response.body.imported).toEqual({ boneId: "ilium", name: "Ilium", count: 2 });
        expect(response.body.warnings).toEqual([]);
        expect(response.body.scene.images).toHaveLength(2);

        const reopened = await request(app).get(`/api/scenes/${scene.id}`);
        expect(reopened.body.images).toEqual(response.body.scene.images);
    });

    it("links only the selected image when one is chosen", async () => {
        const scene = await createScene("Import One Image");
        const response = await importInto(scene.id, "ilium", ["ilium_image2.jpg"]);

        expect(response.statusCode).toBe(200);
        expect(response.body.imported.count).toBe(1);
        expect(response.body.scene.images.map((image) => image.source.filename)).toEqual(["ilium_image2.jpg"]);
    });

    it("keeps the original images and bone data accessible", async () => {
        const scene = await createScene("Import Femur");
        const { body } = await importInto(scene.id, "femur");

        for (const image of body.scene.images) {
            const file = await request(app).get(image.src);
            expect(file.statusCode).toBe(200);
            expect(file.headers["content-type"]).toMatch(/^image\//);
        }

        const boneData = await request(app).get("/api/bone-data/?boneId=femur");
        expect(boneData.statusCode).toBe(200);
        expect(boneData.body.images.map((image) => image.filename)).toEqual(readDescriptionImages("femur"));
    });

    it("places a second import on a new row below the first", async () => {
        const scene = await createScene("Two Imports");
        const first = (await importInto(scene.id, "sternum")).body.scene.images;
        const second = (await importInto(scene.id, "humerus")).body.scene.images;

        expect(second).toHaveLength(first.length + 2);
        const firstBottom = Math.max(...first.map((image) => image.y + image.height));
        for (const image of second.slice(first.length)) {
            expect(image.y).toBe(firstBottom + IMAGE_GAP);
        }
    });

    it("returns 422 and leaves the scene unchanged when there are no images to import", async () => {
        const scene = await createScene("Nothing To Import");
        const response = await importInto(scene.id, "lower_limb");

        expect(response.statusCode).toBe(422);
        const reopened = await request(app).get(`/api/scenes/${scene.id}`);
        expect(reopened.body.images).toEqual([]);
    });

    it("validates the request", async () => {
        const scene = await createScene("Bad Requests");

        expect((await importInto(scene.id, undefined)).statusCode).toBe(400);
        expect((await importInto(scene.id, "../server")).statusCode).toBe(400);
        expect((await importInto(scene.id, "not_a_real_bone")).statusCode).toBe(404);
        expect((await request(app).post(`/api/scenes/${scene.id}/import-legacy`)
            .send({ boneId: "ilium", filenames: [] })).statusCode).toBe(400);
        expect((await request(app).post(`/api/scenes/${scene.id}/import-legacy`)
            .send({ boneId: "ilium", filenames: "ilium_image1.jpg" })).statusCode).toBe(400);
        expect((await importInto("00000000-0000-4000-8000-000000000000", "ilium")).statusCode).toBe(404);
    });
});