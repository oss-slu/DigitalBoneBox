const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const {
    createScenesRouter,
    createFileSceneStore,
    createRedisSceneStore,
    resolveSceneStore,
    MAX_IMAGE_SRC_LENGTH,
} = require("./scenes");

function validImage(overrides = {}) {
    return {
        id: crypto.randomUUID(),
        src: "data:image/png;base64,AAAA",
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        ...overrides,
    };
}

// Widens the read-save race window deterministically so a concurrency test
// doesn't depend on machine speed or backend internals (PR #493 review).
function withArtificialDelay(store, ms) {
    return {
        ...store,
        async get(sceneId) {
            const result = await store.get(sceneId);
            await new Promise((resolve) => setTimeout(resolve, ms));
            return result;
        },
        async save(scene) {
            await new Promise((resolve) => setTimeout(resolve, ms));
            return store.save(scene);
        },
    };
}

// In-memory stand-in for the subset of the @upstash/redis client the store uses.
// Values round-trip through JSON like the real client's automatic serialization.
function createFakeRedis() {
    const strings = new Map();
    const sets = new Map();
    return {
        async get(key) {
            return strings.has(key) ? JSON.parse(strings.get(key)) : null;
        },
        async mget(...keys) {
            return keys.map((key) => (strings.has(key) ? JSON.parse(strings.get(key)) : null));
        },
        async set(key, value, options = {}) {
            if (options.nx && strings.has(key)) return null;
            strings.set(key, JSON.stringify(value));
            return "OK";
        },
        async del(key) {
            return strings.delete(key) ? 1 : 0;
        },
        async sadd(key, member) {
            if (!sets.has(key)) sets.set(key, new Set());
            sets.get(key).add(member);
            return 1;
        },
        async srem(key, member) {
            return sets.has(key) && sets.get(key).delete(member) ? 1 : 0;
        },
        async smembers(key) {
            return [...(sets.get(key) || [])];
        },
    };
}

function buildApp(store) {
    const app = express();
    // Matches server.js's real limit (Issue #412) so tests near the image size
    // cap are rejected by the route's own validation, not Express's raw limit.
    app.use(express.json({ limit: "6mb" }));
    app.use("/api/scenes", createScenesRouter(store));
    return app;
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const backends = [
    {
        name: "file store",
        setup() {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-scenes-test-"));
            return {
                newStore: () => createFileSceneStore(dir),
                cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
            };
        },
    },
    {
        name: "redis store",
        setup() {
            const redis = createFakeRedis();
            return {
                newStore: () => createRedisSceneStore(redis),
                cleanup: () => {},
            };
        },
    },
];

describe.each(backends)("Scenes API ($name)", (backend) => {
    let env;
    let app;

    beforeEach(() => {
        env = backend.setup();
        app = buildApp(env.newStore());
    });

    afterEach(() => {
        env.cleanup();
    });

    const createScene = (body = {}) => request(app).post("/api/scenes").send(body);

    // Issue #421: Create a New Scene
    describe("POST /api/scenes - Issue 421", () => {
        it("creates a blank scene with a unique id", async () => {
            const first = await createScene();
            const second = await createScene();

            expect(first.statusCode).toBe(201);
            expect(second.statusCode).toBe(201);
            expect(first.body.id).not.toBe(second.body.id);
            expect(first.body.images).toEqual([]);
            expect(first.body.annotations).toEqual([]);
            expect(first.headers.location).toBe(`/api/scenes/${first.body.id}`);
        });

        it("assigns numbered default names when none is given", async () => {
            const first = await createScene();
            const second = await createScene();

            expect(first.body.name).toBe("Untitled Scene");
            expect(second.body.name).toBe("Untitled Scene 2");
        });

        it("accepts a custom name and rejects duplicates", async () => {
            const created = await createScene({ name: "  Pelvis Left  " });
            expect(created.body.name).toBe("Pelvis Left");

            const dup = await createScene({ name: "pelvis left" });
            expect(dup.statusCode).toBe(409);
        });

        it("rejects an empty name", async () => {
            const response = await createScene({ name: "   " });
            expect(response.statusCode).toBe(400);
        });
    });

    // Issue #422: Open an Existing Scene
    describe("GET /api/scenes and /api/scenes/:sceneId - Issue 422", () => {
        it("lists saved scenes", async () => {
            const created = await createScene({ name: "Skull" });
            const response = await request(app).get("/api/scenes");

            expect(response.statusCode).toBe(200);
            expect(response.body.scenes).toHaveLength(1);
            expect(response.body.scenes[0]).toMatchObject({
                id: created.body.id,
                name: "Skull",
                imageCount: 0,
                annotationCount: 0,
            });
        });

        it("opens a stored scene without losing object positions or styles", async () => {
            const created = await createScene({ name: "Bony Pelvis" });
            const stored = {
                ...created.body,
                images: [{ id: "img1", src: "/api/images/ilium.png", x: 10, y: 20, width: 300, height: 400, rotation: 15, flipX: true }],
                annotations: [{ id: "a1", type: "polygon", points: [[0, 0], [1, 0], [1, 1]], fill: "#ff000055" }],
            };
            await env.newStore().save(stored);

            const reopened = await request(buildApp(env.newStore())).get(`/api/scenes/${created.body.id}`);
            expect(reopened.statusCode).toBe(200);
            expect(reopened.body).toEqual(stored);
        });

        it("returns 404 for an unknown scene", async () => {
            const response = await request(app).get(`/api/scenes/${UNKNOWN_ID}`);
            expect(response.statusCode).toBe(404);
        });

        it("returns 400 for a malformed scene id", async () => {
            const response = await request(app).get("/api/scenes/..%2F..%2Fserver");
            expect(response.statusCode).toBe(400);
        });
    });

    // Issue #423: Manage Scene Names
    describe("PATCH /api/scenes/:sceneId - Issue 423", () => {
        it("renames a scene and the new name shows in the list", async () => {
            const created = await createScene();
            const renamed = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ name: "Thorax Anterior" });

            expect(renamed.statusCode).toBe(200);
            expect(renamed.body.name).toBe("Thorax Anterior");

            const list = await request(app).get("/api/scenes");
            expect(list.body.scenes[0].name).toBe("Thorax Anterior");
        });

        it("rejects empty and duplicate names", async () => {
            const a = await createScene({ name: "A" });
            await createScene({ name: "B" });

            const empty = await request(app).patch(`/api/scenes/${a.body.id}`).send({ name: "" });
            expect(empty.statusCode).toBe(400);

            const dup = await request(app).patch(`/api/scenes/${a.body.id}`).send({ name: "b" });
            expect(dup.statusCode).toBe(409);
        });

        it("allows re-saving a scene with its own name", async () => {
            const a = await createScene({ name: "A" });
            const response = await request(app).patch(`/api/scenes/${a.body.id}`).send({ name: "A" });
            expect(response.statusCode).toBe(200);
        });

        it("returns 404 when renaming an unknown scene", async () => {
            const response = await request(app)
                .patch(`/api/scenes/${UNKNOWN_ID}`)
                .send({ name: "Nope" });
            expect(response.statusCode).toBe(404);
        });
    });

    // Issue #412: Upload and Store an Imported Image
    describe("PATCH /api/scenes/:sceneId with an image - Issue 412", () => {
        it("adds a newly imported image to the scene", async () => {
            const created = await createScene();
            const image = validImage();

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image });

            expect(response.statusCode).toBe(200);
            expect(response.body.images).toEqual([image]);
        });

        it("keeps the image after the scene is reloaded", async () => {
            const created = await createScene();
            const image = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image });

            const reloaded = await request(app).get(`/api/scenes/${created.body.id}`);

            expect(reloaded.statusCode).toBe(200);
            expect(reloaded.body.images).toEqual([image]);
        });

        it("does not create a duplicate record when the same image id is saved twice", async () => {
            const created = await createScene();
            const image = validImage();

            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image });
            const second = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image });

            expect(second.statusCode).toBe(200);
            expect(second.body.images).toHaveLength(1);
        });

        it("keeps existing images when a different image is added", async () => {
            const created = await createScene();
            const first = validImage();
            const second = validImage();

            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: first });
            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image: second });

            expect(response.body.images).toEqual([first, second]);
        });

        it("rejects an image whose src is not a data:image/ URL", async () => {
            const created = await createScene();
            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image: validImage({ src: "https://example.com/x.png" }) });

            expect(response.statusCode).toBe(400);
            expect(response.body.error).toMatch(/data:image/);
        });

        it("rejects an image whose src exceeds the size cap", async () => {
            const created = await createScene();
            const oversizedSrc = `data:image/png;base64,${"A".repeat(MAX_IMAGE_SRC_LENGTH + 1)}`;
            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image: validImage({ src: oversizedSrc }) });

            expect(response.statusCode).toBe(400);
            expect(response.body.error).toMatch(/too large/i);
        });

        it("rejects an image with non-numeric position or size fields", async () => {
            const created = await createScene();
            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image: validImage({ width: "big" }) });

            expect(response.statusCode).toBe(400);
        });

        it("rejects an image with a width of 0", async () => {
            const created = await createScene();
            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ image: validImage({ width: 0 }) });

            expect(response.statusCode).toBe(400);
        });

        it("returns 404 when adding an image to an unknown scene", async () => {
            const response = await request(app)
                .patch(`/api/scenes/${UNKNOWN_ID}`)
                .send({ image: validImage() });

            expect(response.statusCode).toBe(404);
        });

        it("returns 400 when the body has neither name nor image", async () => {
            const created = await createScene();
            const response = await request(app).patch(`/api/scenes/${created.body.id}`).send({});
            expect(response.statusCode).toBe(400);
        });

        it("can rename and add an image in the same request", async () => {
            const created = await createScene();
            const image = validImage();

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ name: "Renamed", image });

            expect(response.statusCode).toBe(200);
            expect(response.body.name).toBe("Renamed");
            expect(response.body.images).toEqual([image]);
        });

        // PR #493 review: a scene can have multiple images that each pass the
        // per-image cap yet together exceed Vercel's 4.5MB request/response cap.
        it("rejects an image that would push the scene over its total image size budget", async () => {
            const created = await createScene();
            const first = validImage({ src: `data:image/png;base64,${"A".repeat(MAX_IMAGE_SRC_LENGTH - 100)}` });
            const firstResponse = await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: first });
            expect(firstResponse.statusCode).toBe(200);

            const second = validImage({ src: `data:image/png;base64,${"A".repeat(MAX_IMAGE_SRC_LENGTH - 100)}` });
            const response = await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: second });

            expect(response.statusCode).toBe(400);
            expect(response.body.error).toMatch(/size limit/i);

            const reloaded = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(reloaded.body.images).toEqual([first]);
        });
    });

    // PR #493 review: a rename and an image save racing each other must not
    // clobber one another. An artificial delay widens the read-save window so
    // this reproduces deterministically instead of depending on real timing.
    describe("PATCH /api/scenes/:sceneId concurrency - PR #493 review", () => {
        it("does not lose a concurrent rename or image save", async () => {
            const slowApp = buildApp(withArtificialDelay(env.newStore(), 30));
            const created = await request(slowApp).post("/api/scenes").send({});
            const image = validImage();

            const [renameResponse, imageResponse] = await Promise.all([
                request(slowApp).patch(`/api/scenes/${created.body.id}`).send({ name: "Renamed" }),
                request(slowApp).patch(`/api/scenes/${created.body.id}`).send({ image }),
            ]);

            expect(renameResponse.statusCode).toBe(200);
            expect(imageResponse.statusCode).toBe(200);

            const final = await request(slowApp).get(`/api/scenes/${created.body.id}`);
            expect(final.body.name).toBe("Renamed");
            expect(final.body.images).toEqual([image]);
        });
    });

    // Issues #413-417: Position, Resize, Rotate, Flip, Crop an Image
    describe("PATCH /api/scenes/:sceneId with updateImage - Issues 413-417", () => {
        async function createSceneWithImage(overrides = {}) {
            const created = await createScene();
            const image = validImage(overrides);
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image });
            return { sceneId: created.body.id, image };
        }

        it("updates position and size (Issues 413, 414)", async () => {
            const { sceneId, image } = await createSceneWithImage();

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, x: 40, y: 60, width: 200, height: 100 } });

            expect(response.statusCode).toBe(200);
            expect(response.body.images[0]).toMatchObject({ x: 40, y: 60, width: 200, height: 100 });
        });

        it("updates rotation (Issue 415)", async () => {
            const { sceneId, image } = await createSceneWithImage();

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, rotation: 90 } });

            expect(response.statusCode).toBe(200);
            expect(response.body.images[0].rotation).toBe(90);
        });

        it("updates flipX/flipY (Issue 416)", async () => {
            const { sceneId, image } = await createSceneWithImage();

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, flipX: true, flipY: true } });

            expect(response.statusCode).toBe(200);
            expect(response.body.images[0]).toMatchObject({ flipX: true, flipY: true });
        });

        it("sets a crop rect that fits within the image (Issue 417)", async () => {
            const { sceneId, image } = await createSceneWithImage({ width: 100, height: 50 });

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, cropX: 10, cropY: 5, cropWidth: 50, cropHeight: 25 } });

            expect(response.statusCode).toBe(200);
            expect(response.body.images[0]).toMatchObject({ cropX: 10, cropY: 5, cropWidth: 50, cropHeight: 25 });
        });

        it("rejects a crop rect that doesn't fit within the image", async () => {
            const { sceneId, image } = await createSceneWithImage({ width: 100, height: 50 });

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, cropX: 60, cropY: 0, cropWidth: 50, cropHeight: 25 } });

            expect(response.statusCode).toBe(400);
            expect(response.body.error).toMatch(/fit within the image/i);
        });

        it("rejects an incomplete crop rect (all four fields required together)", async () => {
            const { sceneId, image } = await createSceneWithImage();

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, cropX: 10, cropY: 5, cropWidth: 20 } });

            expect(response.statusCode).toBe(400);
        });

        it("validates crop against a width/height changing in the same request", async () => {
            const { sceneId, image } = await createSceneWithImage({ width: 100, height: 50 });

            const response = await request(app).patch(`/api/scenes/${sceneId}`).send({
                updateImage: { id: image.id, width: 40, cropX: 0, cropY: 0, cropWidth: 50, cropHeight: 25 },
            });

            expect(response.statusCode).toBe(400);
        });

        it("rejects an unknown field", async () => {
            const { sceneId, image } = await createSceneWithImage();

            const response = await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, src: "data:image/png;base64,EVIL" } });

            expect(response.statusCode).toBe(400);
        });

        it("never lets updateImage change id or src", async () => {
            const { sceneId, image } = await createSceneWithImage();

            await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, x: 5 } });

            const reloaded = await request(app).get(`/api/scenes/${sceneId}`);
            expect(reloaded.body.images[0].id).toBe(image.id);
            expect(reloaded.body.images[0].src).toBe(image.src);
        });

        it("keeps updates after the scene is reloaded", async () => {
            const { sceneId, image } = await createSceneWithImage();
            await request(app)
                .patch(`/api/scenes/${sceneId}`)
                .send({ updateImage: { id: image.id, rotation: 45 } });

            const reloaded = await request(app).get(`/api/scenes/${sceneId}`);
            expect(reloaded.body.images[0].rotation).toBe(45);
        });

        it("returns 404 when updating an image that doesn't exist", async () => {
            const created = await createScene();
            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ updateImage: { id: crypto.randomUUID(), rotation: 10 } });

            expect(response.statusCode).toBe(404);
        });
    });

    // Issue #418: Remove an Image from a Scene
    describe("PATCH /api/scenes/:sceneId with removeImageId - Issue 418", () => {
        it("removes the requested image and leaves the others intact", async () => {
            const created = await createScene();
            const keep = validImage();
            const remove = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: keep });
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: remove });

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ removeImageId: remove.id });

            expect(response.statusCode).toBe(200);
            expect(response.body.images).toEqual([keep]);
        });

        it("keeps the removal after the scene is reloaded", async () => {
            const created = await createScene();
            const image = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image });
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ removeImageId: image.id });

            const reloaded = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(reloaded.body.images).toEqual([]);
        });

        it("is a no-op success when the image is already gone (safe to retry)", async () => {
            const created = await createScene();
            const image = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image });
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ removeImageId: image.id });

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ removeImageId: image.id });

            expect(response.statusCode).toBe(200);
            expect(response.body.images).toEqual([]);
        });

        it("returns 404 when removing from an unknown scene", async () => {
            const response = await request(app)
                .patch(`/api/scenes/${UNKNOWN_ID}`)
                .send({ removeImageId: crypto.randomUUID() });

            expect(response.statusCode).toBe(404);
        });
    });

    // Issue #419: Reorder Image Layers
    describe("PATCH /api/scenes/:sceneId with reorderImageIds - Issue 419", () => {
        it("reorders images to match the given id order", async () => {
            const created = await createScene();
            const first = validImage();
            const second = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: first });
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: second });

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ reorderImageIds: [second.id, first.id] });

            expect(response.statusCode).toBe(200);
            expect(response.body.images).toEqual([second, first]);
        });

        it("keeps the new order after the scene is reloaded", async () => {
            const created = await createScene();
            const first = validImage();
            const second = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: first });
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: second });
            await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ reorderImageIds: [second.id, first.id] });

            const reloaded = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(reloaded.body.images.map((img) => img.id)).toEqual([second.id, first.id]);
        });

        it("rejects an order that drops an existing image", async () => {
            const created = await createScene();
            const first = validImage();
            const second = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: first });
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: second });

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ reorderImageIds: [first.id] });

            expect(response.statusCode).toBe(400);

            const reloaded = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(reloaded.body.images).toEqual([first, second]);
        });

        it("rejects an order that includes an id not on the scene", async () => {
            const created = await createScene();
            const first = validImage();
            await request(app).patch(`/api/scenes/${created.body.id}`).send({ image: first });

            const response = await request(app)
                .patch(`/api/scenes/${created.body.id}`)
                .send({ reorderImageIds: [first.id, crypto.randomUUID()] });

            expect(response.statusCode).toBe(400);
        });
    });

    // Issue #424: Delete a Scene
    describe("DELETE /api/scenes/:sceneId - Issue 424", () => {
        it("deletes only the requested scene", async () => {
            const keep = await createScene({ name: "Keep" });
            const remove = await createScene({ name: "Remove" });

            const response = await request(app).delete(`/api/scenes/${remove.body.id}`);
            expect(response.statusCode).toBe(204);

            const list = await request(app).get("/api/scenes");
            expect(list.body.scenes.map((s) => s.id)).toEqual([keep.body.id]);
        });

        it("returns 404 when deleting an unknown scene", async () => {
            const response = await request(app).delete(`/api/scenes/${UNKNOWN_ID}`);
            expect(response.statusCode).toBe(404);
        });
    });
});

// CodeQL flagged the file store's path construction as taking uncontrolled
// data: this proves it now re-validates the id itself rather than trusting a
// caller, even though the route-level `router.param` check already blocks
// malformed ids from ever reaching the store in normal operation.
describe("createFileSceneStore path safety", () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-scenes-pathsafety-"));
        store = createFileSceneStore(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("rejects a traversal attempt instead of reading outside the scenes directory", async () => {
        await expect(store.get("../../etc/passwd")).rejects.toThrow(/invalid sceneid/i);
        await expect(store.remove("../../etc/passwd")).rejects.toThrow(/invalid sceneid/i);
    });

    it("rejects saving a scene with a malformed id", async () => {
        await expect(store.save({ id: "../../evil", name: "x", images: [], annotations: [] }))
            .rejects.toThrow(/invalid sceneid/i);
    });
});

describe("resolveSceneStore", () => {
    it("refuses to store scenes on Vercel when Redis is not configured", async () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
        const app = buildApp(resolveSceneStore({ VERCEL: "1" }));
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Scene storage is not configured"));
        consoleError.mockRestore();

        const list = await request(app).get("/api/scenes");
        expect(list.statusCode).toBe(503);

        const create = await request(app).post("/api/scenes").send({});
        expect(create.statusCode).toBe(503);
    });

    it("uses local files outside Vercel when Redis is not configured", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-scenes-resolve-"));
        try {
            const app = buildApp(resolveSceneStore({ SCENES_DIR: dir }));
            const created = await request(app).post("/api/scenes").send({});
            expect(created.statusCode).toBe(201);
            expect(fs.existsSync(path.join(dir, `${created.body.id}.json`))).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
