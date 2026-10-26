// Issues #458 (Define Draft Scenes) and #459 (Publish and Unpublish Scenes),
// part of #457 (Control Scene and Annotation Visibility).
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { createScenesRouter, createFileSceneStore } = require("./scenes");

function buildApp(store) {
    const app = express();
    app.use(express.json({ limit: "6mb" }));
    app.use("/api/scenes", createScenesRouter(store));
    return app;
}

const content = () => ({
    images: [{ id: "img-1", src: "/api/images/ilium_image1.jpg", x: 10, y: 20, width: 235, height: 371, rotation: 15 }],
    annotations: [{ id: "ann-1", type: "text", text: "Iliac crest", x: 40, y: 50, fontSize: 16, color: "#1d3557" }],
});

describe("Scene drafts and publishing - Issues 458, 459", () => {
    let dir;
    let store;
    let app;

    const create = (body = {}) => request(app).post("/api/scenes").send(body);
    const setStatus = (id, status) => request(app).patch(`/api/scenes/${id}/status`).send({ status });
    const list = (query = "") => request(app).get(`/api/scenes${query}`);
    const names = (response) => response.body.scenes.map((scene) => scene.name);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-scene-status-"));
        store = createFileSceneStore(dir);
        app = buildApp(store);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe("drafts (#458)", () => {
        it("starts every new scene as a draft", async () => {
            const created = await create({ name: "Pelvis Study" });
            expect(created.statusCode).toBe(201);
            expect(created.body.status).toBe("draft");

            const listed = await list();
            expect(listed.body.scenes[0]).toMatchObject({ name: "Pelvis Study", status: "draft", publishedAt: null });
        });

        it("ignores a status sent when creating, so nothing is published by accident", async () => {
            const created = await create({ name: "Sneaky", status: "published" });
            expect(created.body.status).toBe("draft");
        });

        it("treats scenes saved before statuses existed as drafts", async () => {
            await store.save({
                id: "11111111-1111-4111-8111-111111111111", name: "Old Scene", images: [], annotations: [],
                createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
            });

            const listed = await list();
            expect(listed.body.scenes[0]).toMatchObject({ name: "Old Scene", status: "draft" });
            expect(names(await list("?status=published"))).toEqual([]);
        });

        it("leaves drafts out of the published list the general viewer uses", async () => {
            const draft = await create({ name: "Draft Scene" });
            const done = await create({ name: "Finished Scene" });
            await setStatus(done.body.id, "published");

            expect(names(await list("?status=published"))).toEqual(["Finished Scene"]);
            expect(names(await list("?status=draft"))).toEqual(["Draft Scene"]);
            expect(names(await list()).sort()).toEqual(["Draft Scene", "Finished Scene"]); // the editor sees both
            expect(draft.statusCode).toBe(201);
        });

        it("lets editors still open and save a draft", async () => {
            const created = await create({ name: "Work in Progress" });

            const opened = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(opened.statusCode).toBe(200);

            const saved = await request(app).put(`/api/scenes/${created.body.id}`)
                .send({ ...content(), baseUpdatedAt: created.body.updatedAt });
            expect(saved.statusCode).toBe(200);
            expect(saved.body.status).toBe("draft");
        });

        it("makes a duplicate of a published scene a draft", async () => {
            const original = await create({ name: "Published Original" });
            await setStatus(original.body.id, "published");

            const copy = await request(app).post(`/api/scenes/${original.body.id}/duplicate`).send({});
            expect(copy.statusCode).toBe(201);
            expect(copy.body.status).toBe("draft");
            expect(copy.body.publishedAt).toBeUndefined();
            expect(names(await list("?status=published"))).toEqual(["Published Original"]);
        });

        it("rejects an unknown status filter", async () => {
            const response = await list("?status=secret");
            expect(response.statusCode).toBe(400);
        });
    });

    describe("publish and unpublish (#459)", () => {
        it("publishes a scene so it appears in the published list", async () => {
            const created = await create({ name: "Ilium Study" });

            const response = await setStatus(created.body.id, "published");
            expect(response.statusCode).toBe(200);
            expect(response.body).toMatchObject({ id: created.body.id, name: "Ilium Study", status: "published" });
            expect(Date.parse(response.body.publishedAt)).not.toBeNaN();

            expect(names(await list("?status=published"))).toEqual(["Ilium Study"]);
            const opened = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(opened.body.status).toBe("published");
        });

        it("unpublishes a scene so it's no longer listed as published", async () => {
            const created = await create({ name: "Ilium Study" });
            await setStatus(created.body.id, "published");

            const response = await setStatus(created.body.id, "draft");
            expect(response.statusCode).toBe(200);
            expect(response.body).toMatchObject({ status: "draft", publishedAt: null });

            expect(names(await list("?status=published"))).toEqual([]);
            const opened = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(opened.body.status).toBe("draft");
            expect(opened.body.publishedAt).toBeUndefined();
        });

        it("doesn't change the scene's content or version when publishing", async () => {
            const created = await create({ name: "Content Check" });
            const saved = await request(app).put(`/api/scenes/${created.body.id}`)
                .send({ ...content(), baseUpdatedAt: created.body.updatedAt });

            await setStatus(created.body.id, "published");
            const opened = await request(app).get(`/api/scenes/${created.body.id}`);

            expect(opened.body.status).toBe("published");
            for (const field of ["name", "images", "annotations", "createdAt", "updatedAt"]) {
                expect(opened.body[field]).toEqual(saved.body[field]);
            }
        });

        it("still lets an open copy be saved after publishing, and it stays published", async () => {
            const created = await create({ name: "Keep Editing" });
            await setStatus(created.body.id, "published");

            // The editor loaded the scene before publishing; its version is still valid.
            const saved = await request(app).put(`/api/scenes/${created.body.id}`)
                .send({ ...content(), baseUpdatedAt: created.body.updatedAt });
            expect(saved.statusCode).toBe(200);
            expect(saved.body.status).toBe("published");
            expect(names(await list("?status=published"))).toEqual(["Keep Editing"]);
        });

        it("can publish and unpublish the same scene repeatedly", async () => {
            const created = await create({ name: "Back and Forth" });
            for (const status of ["published", "draft", "published"]) {
                const response = await setStatus(created.body.id, status);
                expect(response.body.status).toBe(status);
            }
            expect(names(await list("?status=published"))).toEqual(["Back and Forth"]);
        });

        it("rejects a status that isn't draft or published", async () => {
            const created = await create({ name: "Bad Status" });
            for (const body of [{ status: "archived" }, { status: "" }, {}]) {
                const response = await request(app).patch(`/api/scenes/${created.body.id}/status`).send(body);
                expect(response.statusCode).toBe(400);
            }
            const opened = await request(app).get(`/api/scenes/${created.body.id}`);
            expect(opened.body.status).toBe("draft");
        });

        it("returns 404 for a scene that doesn't exist", async () => {
            const response = await setStatus("00000000-0000-4000-8000-000000000000", "published");
            expect(response.statusCode).toBe(404);
        });
    });
});