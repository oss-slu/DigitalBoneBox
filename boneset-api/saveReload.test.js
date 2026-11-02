// Issue #482 (parent #477): Test Save and Reload.
// Saves a complex scene, "closes" it by starting a fresh app on the same
// storage, reloads it, and compares every image and annotation. Also covers
// discarding unsaved changes and saves that fail.
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

// A scene that uses every kind of edit the Scene Editor supports.
function complexScene() {
    return {
        images: [
            // Moved and resized, no other changes
            { id: "img-plain", src: "data:image/png;base64,AAAA", x: 40, y: 60, width: 320, height: 240, rotation: 0 },
            // Rotated
            { id: "img-rotated", src: "data:image/png;base64,BBBB", x: 400, y: 20, width: 200, height: 150, rotation: 45 },
            // Flipped both ways, negative rotation
            {
                id: "img-flipped", src: "data:image/png;base64,CCCC", x: 10, y: 320, width: 180, height: 180,
                rotation: -90, flipX: true, flipY: true,
            },
            // Cropped
            {
                id: "img-cropped", src: "data:image/png;base64,DDDD", x: 250, y: 300, width: 300, height: 200,
                rotation: 0, cropX: 25, cropY: 10, cropWidth: 150, cropHeight: 120,
            },
            // Imported from the legacy viewer, with decimal values
            {
                id: "img-legacy", src: "/api/images/ilium_image1.jpg", x: 612.5, y: 48.25, width: 235, height: 371,
                rotation: 12.5, source: { type: "legacy-image", boneId: "ilium", filename: "ilium_image1.jpg" },
            },
        ],
        annotations: [
            {
                id: "ann-label", type: "text", text: "Iliac crest", x: 70, y: 80, fontSize: 18, color: "#1d3557",
                sourceImageId: "img-legacy", sourceImageFrame: { x: 612.5, y: 48.25, width: 235, height: 371 },
            },
            { id: "ann-label-2", type: "text", text: "Anterior superior iliac spine", x: 410, y: 190, fontSize: 14, color: "#e63946" },
            { id: "ann-line", type: "line", points: [[100, 100], [180, 140], [220, 210]], color: "#1d3557", strokeWidth: 2 },
            { id: "ann-region", type: "polygon", points: [[300, 320], [360, 330], [340, 400]], fill: "#ff000055", stroke: "#990000" },
        ],
    };
}

const IMAGE_FIELDS = [
    "id", "src", "x", "y", "width", "height", "rotation", "flipX", "flipY",
    "cropX", "cropY", "cropWidth", "cropHeight", "source",
];
const ANNOTATION_FIELDS = [
    "id", "type", "text", "x", "y", "fontSize", "color", "points", "strokeWidth",
    "fill", "stroke", "sourceImageId", "sourceImageFrame",
];

// Compares each object field by field, so a failure names the exact object and
// field that changed (e.g. "img-rotated.rotation") instead of one big diff.
function expectSameObjects(actual, expected, fields) {
    expect(actual.map((item) => item.id)).toEqual(expected.map((item) => item.id)); // order
    expected.forEach((want, index) => {
        const got = actual[index];
        for (const field of fields) {
            expect({ object: `${want.id}.${field}`, value: got[field] })
                .toEqual({ object: `${want.id}.${field}`, value: want[field] });
        }
    });
}

describe("Save and reload a complex scene - Issue 482", () => {
    let dir;
    let app;

    // "Closing" the scene: a new app and store reading the same saved files,
    // like restarting the server or opening the scene on another visit.
    const reopen = (sceneId) => request(buildApp(createFileSceneStore(dir))).get(`/api/scenes/${sceneId}`);
    const save = (sceneId, body) => request(app).put(`/api/scenes/${sceneId}`).send(body);

    async function createSavedScene(name = "Pelvis Study") {
        const created = await request(app).post("/api/scenes").send({ name });
        const saved = await save(created.body.id, { ...complexScene(), baseUpdatedAt: created.body.updatedAt });
        expect(saved.statusCode).toBe(200);
        return saved.body;
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-save-reload-"));
        app = buildApp(createFileSceneStore(dir));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reopens a saved scene successfully", async () => {
        const saved = await createSavedScene();

        const reopened = await reopen(saved.id);
        expect(reopened.statusCode).toBe(200);
        expect(reopened.body).toMatchObject({ id: saved.id, name: "Pelvis Study" });
        expect(reopened.body.images).toHaveLength(5);
        expect(reopened.body.annotations).toHaveLength(4);
    });

    it("keeps every image's position, size, orientation, crop, and order", async () => {
        const saved = await createSavedScene();

        const reopened = await reopen(saved.id);
        expectSameObjects(reopened.body.images, complexScene().images, IMAGE_FIELDS);
    });

    it("keeps every annotation's content, position, style, and order", async () => {
        const saved = await createSavedScene();

        const reopened = await reopen(saved.id);
        expectSameObjects(reopened.body.annotations, complexScene().annotations, ANNOTATION_FIELDS);
    });

    it("loads back exactly what was saved, with nothing added or lost", async () => {
        const saved = await createSavedScene();

        const reopened = await reopen(saved.id);
        expect(reopened.body).toEqual(saved);
    });

    it("keeps a new layer order and edits after a second save and reload", async () => {
        const saved = await createSavedScene();
        const edited = complexScene();
        edited.images.reverse();
        edited.images[0] = { ...edited.images[0], x: 5, y: 5, rotation: 180 };
        edited.annotations = [edited.annotations[3], edited.annotations[0], { ...edited.annotations[1], text: "ASIS" }];

        const second = await save(saved.id, { ...edited, baseUpdatedAt: saved.updatedAt });
        expect(second.statusCode).toBe(200);

        const reopened = await reopen(saved.id);
        expectSameObjects(reopened.body.images, edited.images, IMAGE_FIELDS);
        expectSameObjects(reopened.body.annotations, edited.annotations, ANNOTATION_FIELDS);
    });

    it("keeps reloading the same content after being opened several times", async () => {
        const saved = await createSavedScene();

        const first = await reopen(saved.id);
        const second = await reopen(saved.id);
        const third = await reopen(saved.id);
        expect(second.body).toEqual(first.body);
        expect(third.body).toEqual(first.body);
    });
});

describe("Discarding unsaved changes - Issue 482", () => {
    let dir;
    let app;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-save-reload-"));
        app = buildApp(createFileSceneStore(dir));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reopens the last saved version when edits are discarded instead of saved", async () => {
        const created = await request(app).post("/api/scenes").send({ name: "Discard Test" });
        const saved = await request(app).put(`/api/scenes/${created.body.id}`)
            .send({ ...complexScene(), baseUpdatedAt: created.body.updatedAt });

        // The editor changes its working copy, then the user discards it - so it's never sent.
        const workingCopy = JSON.parse(JSON.stringify(saved.body));
        workingCopy.images[1].rotation = 270;
        workingCopy.images.pop();
        workingCopy.annotations[0].text = "Unsaved label";

        const reopened = await request(buildApp(createFileSceneStore(dir))).get(`/api/scenes/${created.body.id}`);
        expect(reopened.body).toEqual(saved.body);
        expect(reopened.body.images[1].rotation).toBe(45);
        expect(reopened.body.images).toHaveLength(5);
        expect(reopened.body.annotations[0].text).toBe("Iliac crest");
    });
});

describe("Failed saves leave the saved scene unchanged - Issue 482", () => {
    let dir;
    let app;
    let saved;
    let failWrites;

    // Same file store, but with a switch that makes writes fail like a full
    // disk or an unreachable database.
    function flakyStore() {
        const store = createFileSceneStore(dir);
        return {
            ...store,
            async save(scene) {
                if (failWrites) throw new Error("Simulated storage failure");
                return store.save(scene);
            },
        };
    }

    const reopen = (sceneId) => request(buildApp(createFileSceneStore(dir))).get(`/api/scenes/${sceneId}`);

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-save-reload-"));
        failWrites = false;
        app = buildApp(flakyStore());
        const created = await request(app).post("/api/scenes").send({ name: "Failure Test" });
        const response = await request(app).put(`/api/scenes/${created.body.id}`)
            .send({ ...complexScene(), baseUpdatedAt: created.body.updatedAt });
        saved = response.body;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reports an error and keeps the old version when storage fails", async () => {
        jest.spyOn(console, "error").mockImplementation(() => {}); // the route logs the failure
        failWrites = true;
        const changed = { ...complexScene(), images: [], annotations: [] };

        const response = await request(app).put(`/api/scenes/${saved.id}`).send({ ...changed, baseUpdatedAt: saved.updatedAt });
        expect(response.statusCode).toBeGreaterThanOrEqual(500);

        const reopened = await reopen(saved.id);
        expect(reopened.body).toEqual(saved);
    });

    it("rejects invalid content and keeps the old version", async () => {
        const bad = complexScene();
        bad.images[3] = { ...bad.images[3], cropWidth: 1000 }; // crop doesn't fit the image

        const response = await request(app).put(`/api/scenes/${saved.id}`).send({ ...bad, baseUpdatedAt: saved.updatedAt });
        expect(response.statusCode).toBe(400);

        const reopened = await reopen(saved.id);
        expect(reopened.body).toEqual(saved);
    });

    it("refuses a save from an out-of-date copy and keeps the newer version", async () => {
        const newer = complexScene();
        newer.annotations[0].text = "Saved from another tab";
        const first = await request(app).put(`/api/scenes/${saved.id}`).send({ ...newer, baseUpdatedAt: saved.updatedAt });
        expect(first.statusCode).toBe(200);

        // A second tab still has the original version open and tries to save over it.
        const stale = await request(app).put(`/api/scenes/${saved.id}`)
            .send({ ...complexScene(), images: [], baseUpdatedAt: saved.updatedAt });
        expect(stale.statusCode).toBe(412);

        const reopened = await reopen(saved.id);
        expect(reopened.body).toEqual(first.body);
        expect(reopened.body.annotations[0].text).toBe("Saved from another tab");
    });

    it("saves normally again once storage recovers", async () => {
        jest.spyOn(console, "error").mockImplementation(() => {});
        failWrites = true;
        await request(app).put(`/api/scenes/${saved.id}`).send({ ...complexScene(), baseUpdatedAt: saved.updatedAt });
        failWrites = false;

        const edited = complexScene();
        edited.images[0].x = 999;
        const retry = await request(app).put(`/api/scenes/${saved.id}`).send({ ...edited, baseUpdatedAt: saved.updatedAt });
        expect(retry.statusCode).toBe(200);

        const reopened = await reopen(saved.id);
        expect(reopened.body.images[0].x).toBe(999);
    });
});