const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const {
    createScenesRouter,
    createFileSceneStore,
    createRedisSceneStore,
    resolveSceneStore,
    MAX_SCENE_OBJECTS,
} = require("./scenes");

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
        async set(key, value) {
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
    app.use(express.json({ limit: "2mb" }));
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

        it("returns 404 for an unknown scene", async () => {
            const response = await request(app).get(`/api/scenes/${UNKNOWN_ID}`);
            expect(response.statusCode).toBe(404);
        });

        it("returns 400 for a malformed scene id", async () => {
            const response = await request(app).get("/api/scenes/..%2F..%2Fserver");
            expect(response.statusCode).toBe(400);
        });
    });

    // Issues #452, #453, #454: Save, load, and update scene contents
    describe("PUT /api/scenes/:sceneId - Issues 452, 453, 454", () => {
        const content = {
            images: [{ id: "img1", src: "/api/images/ilium.png", x: 10, y: 20, width: 300, height: 400, rotation: 15, flipX: true }],
            annotations: [
                { id: "a1", type: "text", text: "Ilium", x: 0.2, y: 0.1 },
                { id: "a2", type: "polygon", points: [[0, 0], [1, 0], [1, 1]], fill: "#ff000055" },
            ],
        };

        it("saves contents through the API and reopens them unchanged", async () => {
            const created = await createScene({ name: "Bony Pelvis" });

            const saved = await request(app).put(`/api/scenes/${created.body.id}`).send(content);
            expect(saved.statusCode).toBe(200);
            expect(saved.body.images).toEqual(content.images);
            expect(saved.body.annotations).toEqual(content.annotations);

            const reopened = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(reopened.statusCode).toBe(200);
            expect(reopened.body).toEqual(saved.body);
            expect(reopened.body.id).toBe(created.body.id);
            expect(reopened.body.createdAt).toBe(created.body.createdAt);
        });

        it("keeps saved contents for a separate server instance using the same storage", async () => {
            const created = await createScene();
            await request(app).put(`/api/scenes/${created.body.id}`).send(content);

            const otherInstance = buildApp(env.newStore());
            const reopened = await request(otherInstance).get(`/api/scenes/${created.body.id}`);
            expect(reopened.statusCode).toBe(200);
            expect(reopened.body.annotations).toEqual(content.annotations);
        });

        it("replaces earlier contents on a later save and updates the list counts", async () => {
            const created = await createScene();
            await request(app).put(`/api/scenes/${created.body.id}`).send(content);
            const second = await request(app)
                .put(`/api/scenes/${created.body.id}`)
                .send({ images: [], annotations: [content.annotations[0]] });

            expect(second.body.images).toEqual([]);
            expect(second.body.annotations).toEqual([content.annotations[0]]);

            const list = await request(app).get("/api/scenes");
            expect(list.body.scenes[0]).toMatchObject({ imageCount: 0, annotationCount: 1 });
        });

        it("ignores id and createdAt sent by the client", async () => {
            const created = await createScene();
            const response = await request(app)
                .put(`/api/scenes/${created.body.id}`)
                .send({ ...content, id: UNKNOWN_ID, createdAt: "1999-01-01T00:00:00.000Z" });

            expect(response.body.id).toBe(created.body.id);
            expect(response.body.createdAt).toBe(created.body.createdAt);
        });

        it("can rename while saving, and rejects a duplicate name", async () => {
            await createScene({ name: "Taken" });
            const created = await createScene({ name: "Mine" });

            const renamed = await request(app)
                .put(`/api/scenes/${created.body.id}`)
                .send({ ...content, name: "Renamed" });
            expect(renamed.body.name).toBe("Renamed");

            const dup = await request(app)
                .put(`/api/scenes/${created.body.id}`)
                .send({ ...content, name: "taken" });
            expect(dup.statusCode).toBe(409);
        });

        it("rejects missing or malformed contents without changing the scene", async () => {
            const created = await createScene();
            const url = `/api/scenes/${created.body.id}`;

            const missing = await request(app).put(url).send({ images: [] });
            expect(missing.statusCode).toBe(400);

            const notObjects = await request(app).put(url).send({ images: ["x"], annotations: [] });
            expect(notObjects.statusCode).toBe(400);

            const tooMany = await request(app)
                .put(url)
                .send({ images: [], annotations: Array.from({ length: MAX_SCENE_OBJECTS + 1 }, () => ({})) });
            expect(tooMany.statusCode).toBe(400);

            const unchanged = await request(app).get(url);
            expect(unchanged.body).toEqual(created.body);
        });

        it("returns 404 when saving an unknown scene", async () => {
            const response = await request(app).put(`/api/scenes/${UNKNOWN_ID}`).send(content);
            expect(response.statusCode).toBe(404);
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
