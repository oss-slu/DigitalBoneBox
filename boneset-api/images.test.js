// Existing image preservation - Issue #464 (parent #463).
const { Buffer } = require("buffer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

// Keep scene files written by server start-up out of the real data folder.
const scenesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-images-test-"));
process.env.SCENES_DIR = scenesDir;

const { app, serverReady } = require("./server");
const { buildImageCatalog, readImageDimensions, imageUrl } = require("./images");

const IMAGES_DIR = path.join(__dirname, "data", "images");
const DESCRIPTIONS_DIR = path.join(__dirname, "data", "descriptions");

// One bone or sub-bone from each boneset, plus the three items whose image
// references were fixed for this issue.
const REPRESENTATIVE_BONE_IDS = ["ilium", "iliac_crest", "sternum", "atlas", "humerus", "femur_head"];
const FIXED_REFERENCES = [
    { boneId: "anterior_view", filename: "anterior_image.png" },
    { boneId: "inferior_cranial_base", filename: "inferior_image.jpg" },
    { boneId: "scapula_fossaw", filename: "Scapula_Extra_image.jpg" },
];

let catalog;

beforeAll(async () => {
    await serverReady;
    catalog = await buildImageCatalog({ imagesDir: IMAGES_DIR, descriptionsDir: DESCRIPTIONS_DIR });
});

afterAll(() => {
    fs.rmSync(scenesDir, { recursive: true, force: true });
});

describe("Existing image files", () => {
    // fs.existsSync would pass a wrong-case name on macOS and Windows, so compare
    // against the exact names in the folder, as the Linux deployment does.
    it("has a file with the exact same name for every image a description lists", () => {
        expect(catalog.missingReferences).toEqual([]);
    });

    it.each(FIXED_REFERENCES)("lists $filename for $boneId", ({ boneId, filename }) => {
        const image = catalog.images.find((entry) => entry.filename === filename);
        expect(image).toBeDefined();
        expect(image.usedBy).toContain(boneId);
    });

    it("reads a pixel size for every image", () => {
        for (const image of catalog.images) {
            expect(Number.isInteger(image.width) && image.width > 0).toBe(true);
            expect(Number.isInteger(image.height) && image.height > 0).toBe(true);
        }
    });
});

describe("GET /api/image-catalog", () => {
    it("lists every image in the images folder", async () => {
        const response = await request(app).get("/api/image-catalog");
        expect(response.statusCode).toBe(200);

        const onDisk = fs.readdirSync(IMAGES_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
        expect(response.body.images.map((image) => image.filename)).toEqual(onDisk);
    });

    it("keeps each image's existing URL", async () => {
        const response = await request(app).get("/api/image-catalog");
        for (const image of response.body.images) {
            expect(image.url).toBe(`/api/images/${encodeURIComponent(image.filename)}`);
        }
    });

    it("serves every catalog URL as an image", async () => {
        const response = await request(app).get("/api/image-catalog");
        for (const image of response.body.images) {
            const file = await request(app).get(image.url);
            expect(file.statusCode).toBe(200);
            expect(file.headers["content-type"]).toMatch(/^image\//);
        }
    });

    // The viewer gets images from /api/bone-data; the editor gets them from the
    // catalog. Both must point at the same files for the same bone.
    it.each(REPRESENTATIVE_BONE_IDS)("returns the same images as the viewer for %s", async (boneId) => {
        const viewer = await request(app).get(`/api/bone-data/?boneId=${boneId}`);
        const editor = await request(app).get("/api/image-catalog").query({ boneId });
        expect(viewer.statusCode).toBe(200);
        expect(editor.statusCode).toBe(200);

        const viewerUrls = viewer.body.images.map((image) => image.url).sort();
        const editorUrls = editor.body.images.map((image) => image.url).sort();
        expect(viewerUrls.length).toBeGreaterThan(0);
        expect(editorUrls).toEqual(viewerUrls);
    });

    it("returns an empty list for a bone with no images", async () => {
        const response = await request(app).get("/api/image-catalog").query({ boneId: "not_a_real_bone" });
        expect(response.statusCode).toBe(200);
        expect(response.body.images).toEqual([]);
    });

    it("rejects an invalid boneId", async () => {
        const response = await request(app).get("/api/image-catalog").query({ boneId: "../etc/passwd" });
        expect(response.statusCode).toBe(400);
    });

    it("does not change the existing /api/images file route", async () => {
        const response = await request(app).get("/api/images/ilium_image1.jpg");
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toMatch(/^image\//);
    });
});

describe("readImageDimensions", () => {
    it("reads a PNG header", () => {
        const png = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
        png.writeUInt32BE(328, 16);
        png.writeUInt32BE(480, 20);
        expect(readImageDimensions(png)).toEqual({ width: 328, height: 480 });
    });

    it("reads a JPEG header after an APP0 segment", () => {
        const jpeg = Buffer.from([
            0xff, 0xd8, // start of image
            0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
            0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xea, 0x01, 0x60, // SOF0: height 234, width 352
        ]);
        expect(readImageDimensions(jpeg)).toEqual({ width: 352, height: 234 });
    });

    it("returns null for data that is not an image", () => {
        expect(readImageDimensions(Buffer.from("not an image"))).toBeNull();
    });

    it("builds URL-safe image URLs", () => {
        expect(imageUrl("a b#.jpg")).toBe("/api/images/a%20b%23.jpg");
    });
});