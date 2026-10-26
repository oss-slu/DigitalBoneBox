// Tests for keeping the bone viewer usable while content is moved into scenes.
// Issue #469 (parent #463).
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

// Keep scenes made by these tests out of boneset-api/data/scenes.
// This has to be set before server.js is loaded.
const scenesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-transition-test-"));
process.env.SCENES_DIR = scenesDir;

const { app, serverReady } = require("./server");

const IMAGES_DIR = path.join(__dirname, "data", "images");
const LONG_TEST = 30000; // tests that go through every item need more than Jest's default 5 seconds

// Every boneset, bone, and bone part in the viewer's dropdowns.
let items = [];

beforeAll(async () => {
    await serverReady;
    const response = await request(app).get("/combined-data");
    items = [
        ...response.body.bonesets.map((set) => set.id),
        ...response.body.bones.map((bone) => bone.id),
        ...response.body.subbones.map((subbone) => subbone.id),
    ];
});

afterAll(() => {
    fs.rmSync(scenesDir, { recursive: true, force: true });
});

const createScene = async (name) => (await request(app).post("/api/scenes").send({ name })).body;
   // Import only builds the content now (#466); save it like the editor's Save does (#451).
   async function importInto(sceneId, boneId) {
       const imported = await request(app)
           .post(`/api/scenes/${sceneId}/import-legacy`)
           .send({ boneId, annotations: { labels: true, regions: true } });
       if (imported.statusCode !== 200) return imported;

       const scene = (await request(app).get(`/api/scenes/${sceneId}`)).body;
       return request(app).put(`/api/scenes/${sceneId}`).send({
           images: [...scene.images, ...imported.body.images],
           annotations: [...scene.annotations, ...imported.body.annotations],
           importLog: [...(scene.importLog || []), imported.body.importLogEntry],
           baseUpdatedAt: scene.updatedAt,
       });
   }
// Everything the viewer loads for one item, so we can check it doesn't change.
async function viewerContent(boneId) {
    const boneData = await request(app).get(`/api/bone-data/?boneId=${boneId}`);
    const description = await request(app).get(`/api/description/?boneId=${boneId}`);
    const regions = await request(app).get(`/api/colored-regions?boneId=${boneId}`);
    return {
        boneData: [boneData.statusCode, boneData.body],
        description: [description.statusCode, description.text],
        regions: [regions.statusCode, regions.body],
    };
}

describe("Non-migrated content stays viewable - Issue 469", () => {
    it("checks all the items in the dropdowns", () => {
        expect(items.length).toBeGreaterThan(150);
    });

    it("gives every item an id the API accepts", async () => {
        const rejected = [];
        for (const id of items) {
            const response = await request(app).get(`/api/bone-data/?boneId=${encodeURIComponent(id)}`);
            if (response.statusCode === 400) rejected.push(id);
        }
        expect(rejected).toEqual([]);
    }, LONG_TEST);

    it("never gives a server error for any item", async () => {
        for (const id of items) {
            const boneData = await request(app).get(`/api/bone-data/?boneId=${encodeURIComponent(id)}`);
            // 200 = has content, 404 = no content yet (the viewer shows a message for that)
            expect([200, 404]).toContain(boneData.statusCode);

            const description = await request(app).get(`/api/description/?boneId=${encodeURIComponent(id)}`);
            expect(description.statusCode).toBe(200);
            expect(description.text).not.toContain("Invalid bone ID");
        }
    }, LONG_TEST);

    it("has a file for every image the viewer lists", async () => {
        const missing = [];
        for (const id of items) {
            const response = await request(app).get(`/api/bone-data/?boneId=${encodeURIComponent(id)}`);
            if (response.statusCode !== 200) continue;
            for (const image of response.body.images) {
                if (!fs.existsSync(path.join(IMAGES_DIR, image.filename))) missing.push(`${id}: ${image.filename}`);
            }
        }
        expect(missing).toEqual([]);
    }, LONG_TEST);

    it("no longer lists the leftover axis_body_(dens) item", () => {
        expect(items).not.toContain("axis_body_(dens)");
        expect(items).toContain("axis_body");
    });

    it("can open 2nd-5th metatarsals now that ids can have hyphens", async () => {
        const boneData = await request(app).get("/api/bone-data/?boneId=2nd-5th_metatarsals");
        expect(boneData.statusCode).toBe(200);
        expect(boneData.body.images.length).toBeGreaterThan(0);

        const regions = await request(app).get("/api/colored-regions?boneId=2nd-5th_metatarsals");
        expect(regions.statusCode).toBe(200);
    });

    it("still rejects ids that could reach other folders", async () => {
        expect((await request(app).get("/api/bone-data/?boneId=../server")).statusCode).toBe(400);
        expect((await request(app).get("/api/bone-data/?boneId=a/b")).statusCode).toBe(400);
        expect((await request(app).get("/api/colored-regions?boneId=..%2Fserver")).statusCode).toBe(400);
    });
});

describe("Migrated and non-migrated content side by side - Issue 469", () => {
    it("lists which viewer items each scene was made from", async () => {
        const scene = await createScene("Pelvis and Femur");
        expect((await importInto(scene.id, "ilium")).statusCode).toBe(200);
        expect((await importInto(scene.id, "femur")).statusCode).toBe(200);

        const list = await request(app).get("/api/scenes");
        const summary = list.body.scenes.find((s) => s.id === scene.id);
        expect(summary.sources).toEqual(["ilium", "femur"]);
    });

    it("lists no sources for a scene without imported bone images", async () => {
        const scene = await createScene("Empty Scene");
        const list = await request(app).get("/api/scenes");
        expect(list.body.scenes.find((s) => s.id === scene.id).sources).toEqual([]);
    });

    it("doesn't change what the viewer shows for an item after it is migrated", async () => {
        const before = await viewerContent("iliac_crest");

        const scene = await createScene("Iliac Crest Scene");
        expect((await importInto(scene.id, "iliac_crest")).statusCode).toBe(200);

        expect(await viewerContent("iliac_crest")).toEqual(before);
    });

    it("works when moving between migrated and non-migrated items in one session", async () => {
        const scene = await createScene("Atlas Scene");
        expect((await importInto(scene.id, "atlas")).statusCode).toBe(200);
        const atlasBefore = await viewerContent("atlas");

        // 1. A migrated item in the viewer
        expect(atlasBefore.boneData[0]).toBe(200);

        // 2. The scene made from it, with every image loading
        const opened = await request(app).get(`/api/scenes/${scene.id}`);
        expect(opened.statusCode).toBe(200);
        expect(opened.body.images.length).toBeGreaterThan(0);
        for (const image of opened.body.images) {
            expect(image.source.boneId).toBe("atlas");
            const file = await request(app).get(image.src);
            expect(file.statusCode).toBe(200);
        }

        // 3. An item nobody has migrated
        const scenes = (await request(app).get("/api/scenes")).body.scenes;
        expect(scenes.some((s) => s.sources.includes("humerus_head"))).toBe(false);
        const humerusHead = await viewerContent("humerus_head");
        expect(humerusHead.boneData[0]).toBe(200);
        expect(humerusHead.boneData[1].images.length).toBeGreaterThan(0);

        // 4. Back to the migrated item, which looks the same as before
        expect(await viewerContent("atlas")).toEqual(atlasBefore);
    });
});
