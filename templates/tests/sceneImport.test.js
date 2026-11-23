// Tests for the Scene Editor's "Import bone images" control. Issue #466 (parent #463).
// A bone import only adds to the open working copy; the scene is stored by the
// next Save, with the user's other edits, as one versioned write (Issue #451).
const fs = require("fs");
const path = require("path");

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "boneset.html"), "utf8");
const bodyHtml = pageHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, "");

const COMBINED_DATA = {
    bonesets: [
        { id: "bony_pelvis", name: "Bony Pelvis" },
        { id: "lower_limb", name: "Lower Limb" },
    ],
    bones: [
        { id: "ilium", name: "Ilium", boneset: "bony_pelvis" },
        { id: "femur", name: "Femur", boneset: "lower_limb" },
    ],
    subbones: [{ id: "iliac_crest", name: "iliac crest", bone: "ilium" }],
};

const ILIUM_IMAGES = [
    { filename: "ilium_image1.jpg", x: 0, width: 235, height: 371 },
    { filename: "ilium_image2.jpg", x: 275, width: 268, height: 360 },
];

const V0 = "2026-10-01T00:00:00.000Z";

// In-memory stand-in for the scenes API, /combined-data, and the import route.
// Like the real server, the import route builds content without storing it,
// and PUT refuses a save whose baseUpdatedAt isn't the stored version (412).
function createFakeBackend(initialScenes) {
    const scenes = new Map(initialScenes.map((scene) => [scene.id, {
        images: [],
        annotations: [],
        createdAt: V0,
        updatedAt: V0,
        ...scene,
    }]));
    const calls = [];
    const gates = [];
    let version = 0;
    let importCounter = 0;
    const stamp = () => new Date(Date.parse(V0) + (version += 1) * 1000).toISOString();
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const respond = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => copy(body),
    });

    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method, url, body });

        const gateIndex = gates.findIndex((g) => g.method === method && url.endsWith(g.suffix));
        if (gateIndex !== -1) {
            const [gate] = gates.splice(gateIndex, 1);
            await gate.promise;
            if (gate.status) return respond(gate.status, { error: "Forced error" });
        }

        if (url === "/combined-data") return respond(200, COMBINED_DATA);
        if (url.startsWith("/api/bone-data/")) {
            const boneId = new URLSearchParams(url.split("?")[1]).get("boneId");
            const images = boneId === "ilium"
                ? ILIUM_IMAGES.map(({ filename }) => ({ filename, url: `/api/images/${filename}` }))
                : [];
            return respond(200, { id: boneId, name: boneId, description: [], images });
        }
        if (url === "/api/scenes" && method === "GET") {
            return respond(200, {
                scenes: [...scenes.values()].map((s) => ({
                    id: s.id,
                    name: s.name,
                    imageCount: s.images.length,
                    annotationCount: s.annotations.length,
                    updatedAt: s.updatedAt,
                })),
            });
        }

        const match = url.match(/^\/api\/scenes\/([^/]+)(\/import-legacy)?$/);
        const scene = match && scenes.get(decodeURIComponent(match[1]));
        if (match && match[2] && method === "POST") {
            importCounter += 1;
            const originY = body.originY || 0;
            const images = ILIUM_IMAGES
                .filter((image) => body.filenames.includes(image.filename))
                .map((image) => ({
                    id: `import-${importCounter}-${image.filename}`,
                    src: `/api/images/${image.filename}`,
                    x: image.x,
                    y: originY,
                    width: image.width,
                    height: image.height,
                    rotation: 0,
                    // Like the real server: `index` is the image's place in the bone's image list.
                    source: { type: "legacy-image", boneId: body.boneId, filename: image.filename, index: ILIUM_IMAGES.indexOf(image) },
                }));
            const include = body.annotations || {};
            const importedAnnotations = {
                labels: include.labels ? 6 : 0,
                lines: include.labels ? 9 : 0,
                regions: include.regions ? 4 : 0,
            };
            const total = importedAnnotations.labels + importedAnnotations.lines + importedAnnotations.regions;
            const annotations = Array.from({ length: images.length > 0 ? total : 0 }, (_, i) => ({
                id: `import-${importCounter}-annotation-${i}`,
                type: "text",
                text: `Label ${i}`,
                x: 10,
                y: originY + 10,
                sourceImageId: images[0].id,
                sourceImageFrame: { x: images[0].x, y: images[0].y, width: images[0].width, height: images[0].height },
            }));
            const warnings = include.regions
                ? [{ item: "colored regions", reason: "Older format: positions may differ slightly" }]
                : [];
            return respond(200, {
                images,
                annotations,
                importLogEntry: {
                    at: stamp(),
                    boneId: body.boneId,
                    images: images.map((image) => image.source.filename),
                    annotations: importedAnnotations,
                    warnings,
                },
                imported: { boneId: body.boneId, name: "Ilium", count: images.length },
                importedAnnotations,
                warnings,
            });
        }
        if (match && !match[2]) {
            if (!scene) return respond(404, { error: "Scene not found" });
            if (method === "GET") return respond(200, scene);
            if (method === "PUT") {
                if (body.baseUpdatedAt && body.baseUpdatedAt !== scene.updatedAt) {
                    return respond(412, { error: "Scene has changed", updatedAt: scene.updatedAt });
                }
                scene.images = body.images;
                scene.annotations = body.annotations;
                if (body.importLog !== undefined) scene.importLog = body.importLog;
                scene.updatedAt = stamp();
                return respond(200, scene);
            }
        }
        return respond(404, { error: "Not found" });
    });

    return {
        fetch,
        calls,
        scenes,
        scene: (id = "scene-1") => scenes.get(id),
        // Another user saving this scene from somewhere else.
        changeElsewhere(id, change) {
            const scene = scenes.get(id);
            change(scene);
            scene.updatedAt = stamp();
        },
        // Holds the next matching request until the returned function is called.
        hold(method, suffix, { status } = {}) {
            let release;
            const promise = new Promise((resolve) => {
                release = resolve;
            });
            gates.push({ method, suffix, promise, status });
            return () => release();
        },
    };
}

async function waitFor(check, timeout = 1000) {
    const start = Date.now();
    for (;;) {
        try {
            return check();
        } catch (error) {
            if (Date.now() - start > timeout) throw error;
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

const $ = (id) => document.getElementById(id);
const sceneButton = (id) => document.querySelector(`.scene-list-item[data-scene-id="${id}"]`);

let backend;
let scenesModule;

async function setup(initialScenes = [{ id: "scene-1", name: "Pelvis Study" }]) {
    document.body.innerHTML = bodyHtml;
    backend = createFakeBackend(initialScenes);
    global.fetch = backend.fetch;
    jest.resetModules();
    scenesModule = require("../js/scenes.js");
    scenesModule.initializeSceneEditor();

    $("text-button-SceneEditor").click();
    await waitFor(() => expect(sceneButton("scene-1")).not.toBeNull());
    await openScene("scene-1", initialScenes[0].name);
}

async function openScene(id, name) {
    sceneButton(id).click();
    await waitFor(() => expect($("scene-title").textContent).toBe(name));
}

async function openImportForm() {
    $("scene-import-toggle").click();
    await waitFor(() => expect($("scene-import-select").disabled).toBe(false));
}

async function chooseBone(boneId) {
    $("scene-import-select").value = boneId;
    $("scene-import-select").dispatchEvent(new Event("change"));
}

const imageChoices = () => [...$("scene-import-image-list").querySelectorAll("input[type=checkbox]")];
const importCalls = () => backend.calls.filter((call) => call.url.endsWith("/import-legacy"));
const writes = () => backend.calls.filter((call) => ["PUT", "PATCH", "POST"].includes(call.method) && !call.url.endsWith("/import-legacy"));

async function submitIliumImport() {
    await openImportForm();
    await chooseBone("ilium");
    await waitFor(() => expect(imageChoices()).toHaveLength(2));
    $("scene-import-form").requestSubmit();
}

async function importIlium() {
    const before = importCalls().length;
    await submitIliumImport();
    await waitFor(() => expect(importCalls()).toHaveLength(before + 1));
    await waitFor(() => expect($("scene-editor-status").textContent).toMatch(/^Imported 2 images/));
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe("Scene editor: import bone images - Issue 466", () => {
    beforeEach(() => setup());

    it("lists every boneset, bone, and bone part to choose from", async () => {
        expect($("scene-import-form").hidden).toBe(true);
        await openImportForm();

        expect($("scene-import-form").hidden).toBe(false);
        expect($("scene-import-toggle").getAttribute("aria-expanded")).toBe("true");
        const groups = [...$("scene-import-select").querySelectorAll("optgroup")].map((g) => g.label);
        expect(groups).toEqual(["Bony Pelvis", "Lower Limb"]);
        const values = [...$("scene-import-select").querySelectorAll("option")].map((o) => o.value);
        expect(values).toEqual(["", "bony_pelvis", "ilium", "iliac_crest", "lower_limb", "femur"]);
    });

    it("shows the chosen bone's images, all selected, in the viewer's order", async () => {
        await openImportForm();
        await chooseBone("ilium");

        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        expect($("scene-import-images").hidden).toBe(false);
        expect(imageChoices().map((c) => c.value)).toEqual(["ilium_image1.jpg", "ilium_image2.jpg"]);
        expect(imageChoices().every((c) => c.checked)).toBe(true);
        expect($("scene-import-image-list").querySelector("img").getAttribute("src")).toBe("/api/images/ilium_image1.jpg");
    });

    it("adds the chosen bone's images to the open scene", async () => {
        await submitIliumImport();

        await waitFor(() => expect($("scene-canvas").querySelectorAll("image")).toHaveLength(2));
        expect($("scene-meta").textContent).toBe("2 images · 19 annotations");
        expect($("scene-import-form").hidden).toBe(true);
        expect(importCalls()).toEqual([{
            method: "POST",
            url: "/api/scenes/scene-1/import-legacy",
            body: {
                boneId: "ilium",
                filenames: ["ilium_image1.jpg", "ilium_image2.jpg"],
                annotations: { labels: true, regions: true },
                originY: 0,
            },
        }]);
        await waitFor(() => expect($("scene-editor-status").textContent)
            .toBe("Imported 2 images and 19 annotations from Ilium. Save to keep the import. 1 import note below."));
    });

    it("imports only the selected image", async () => {
        await openImportForm();
        await chooseBone("ilium");
        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        imageChoices()[0].checked = false;
        $("scene-import-form").requestSubmit();

        await waitFor(() => expect($("scene-canvas").querySelectorAll("image")).toHaveLength(1));
        expect(importCalls()[0].body).toEqual({
            boneId: "ilium",
            filenames: ["ilium_image2.jpg"],
            annotations: { labels: true, regions: true },
            originY: 0,
        });
    });

    it("explains when the chosen bone has no images", async () => {
        await openImportForm();
        await chooseBone("femur");

        await waitFor(() => expect($("scene-import-error").hidden).toBe(false));
        expect($("scene-import-error").textContent).toMatch(/no images to import/);
        expect($("scene-import-images").hidden).toBe(true);
    });

    it("asks for a bone, then at least one image, before importing", async () => {
        await openImportForm();
        $("scene-import-form").requestSubmit();
        expect($("scene-import-error").textContent).toBe("Choose a bone to import.");

        await chooseBone("ilium");
        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        imageChoices().forEach((c) => { c.checked = false; });
        $("scene-import-form").requestSubmit();
        expect($("scene-import-error").textContent).toBe("Choose at least one image to import.");

        expect(importCalls()).toHaveLength(0);
    });
});

describe("Scene editor: import labels, pointer lines, and colored regions - Issue 467", () => {
    beforeEach(() => setup());

    it("offers labels and colored regions, both selected, once a bone is chosen", async () => {
        await openImportForm();
        expect($("scene-import-extras").hidden).toBe(true);

        await chooseBone("ilium");
        await waitFor(() => expect($("scene-import-extras").hidden).toBe(false));
        expect($("scene-import-labels").checked).toBe(true);
        expect($("scene-import-regions").checked).toBe(true);
    });

    it("sends only the selected kinds of annotation", async () => {
        await openImportForm();
        await chooseBone("ilium");
        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        $("scene-import-labels").checked = false;
        $("scene-import-form").requestSubmit();

        await waitFor(() => expect(importCalls()).toHaveLength(1));
        expect(importCalls()[0].body.annotations).toEqual({ labels: false, regions: true });
    });

    it("shows import notes instead of hiding what couldn't be converted exactly", async () => {
        await submitIliumImport();

        await waitFor(() => expect($("scene-canvas-note").hidden).toBe(false));
        expect($("scene-canvas-note").textContent)
            .toBe("Import notes: colored regions: Older format: positions may differ slightly.");
    });

    it("imports images only when both boxes are cleared", async () => {
        await openImportForm();
        await chooseBone("ilium");
        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        $("scene-import-labels").checked = false;
        $("scene-import-regions").checked = false;
        $("scene-import-form").requestSubmit();

        await waitFor(() => expect($("scene-editor-status").textContent)
            .toBe("Imported 2 images from Ilium. Save to keep the import."));
        expect(scenesModule.getActiveScene().annotations).toEqual([]);
    });
});

// Issue #451 decision: a legacy import changes only the working copy. It is
// stored by the normal Save, together with the user's other unsaved edits.
describe("Scene editor: a bone import changes only the working copy - Issues 451/452", () => {
    const EXISTING = { id: "existing", src: "/api/images/pelvis.jpg", x: 0, y: 0, width: 100, height: 200 };

    beforeEach(() => setup([
        { id: "scene-1", name: "Pelvis Study", images: [{ ...EXISTING }] },
        { id: "scene-2", name: "Other Scene" },
    ]));

    async function rotateExistingImage() {
        document.querySelector("[data-scene-image-index=\"0\"]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await waitFor(() => expect($("scene-image-toolbar").hidden).toBe(false));
        $("scene-image-rotate-right-90").click();
        expect(scenesModule.getActiveScene().images[0].rotation).toBe(90);
    }

    async function save() {
        $("scene-save").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
    }

    it("keeps an unsaved edit and the imported content together in the working copy", async () => {
        await rotateExistingImage();
        expect($("scene-save-status").textContent).toBe("Unsaved changes");

        await importIlium();

        const working = scenesModule.getActiveScene();
        expect(working.images.map((image) => image.id)).toEqual([
            "existing", "import-1-ilium_image1.jpg", "import-1-ilium_image2.jpg",
        ]);
        expect(working.images[0].rotation).toBe(90);
        // The new row starts below the existing image (bottom 200 + 40 gap).
        expect(importCalls()[0].body.originY).toBe(240);
        expect(working.images.slice(1).every((image) => image.y === 240)).toBe(true);
        expect(working.annotations).toHaveLength(19);
        expect(working.importLog).toEqual([expect.objectContaining({ boneId: "ilium" })]);
        expect($("scene-meta").textContent).toBe("3 images · 19 annotations");
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
        expect($("scene-save").disabled).toBe(false);
    });

    it("does not change the saved scene or its version", async () => {
        const storedBefore = JSON.parse(JSON.stringify(backend.scene()));

        await importIlium();

        expect(backend.scene()).toEqual(storedBefore);
        expect(backend.scene().updatedAt).toBe(V0);
        expect(writes()).toEqual([]);
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        // The list still shows what is stored, not the working copy.
        expect(sceneButton("scene-1").textContent).toContain("1 image");
    });

    it("saves the edit, the import, and its log together in one versioned write", async () => {
        await rotateExistingImage();
        await importIlium();

        await save();

        const puts = backend.calls.filter((call) => call.method === "PUT");
        expect(puts).toHaveLength(1);
        expect(puts[0].body.baseUpdatedAt).toBe(V0);
        expect(writes()).toHaveLength(1);
        const stored = backend.scene();
        expect(stored.images).toHaveLength(3);
        expect(stored.images[0]).toMatchObject({ id: "existing", rotation: 90 });
        expect(stored.annotations).toHaveLength(19);
        expect(stored.importLog).toEqual([expect.objectContaining({
            boneId: "ilium",
            images: ["ilium_image1.jpg", "ilium_image2.jpg"],
        })]);
        const savedVersion = stored.updatedAt;
        expect(savedVersion).not.toBe(V0);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
        expect($("scene-save").disabled).toBe(true);
        expect(sceneButton("scene-1").textContent).toContain("3 images");

        // The client now expects the version it just saved, so the next save
        // isn't mistaken for a stale copy.
        $("scene-image-flip-horizontal").click();
        await save();
        const lastPut = backend.calls.filter((call) => call.method === "PUT").pop();
        expect(lastPut.body.baseUpdatedAt).toBe(savedVersion);
        expect(backend.scene().images[0]).toMatchObject({ rotation: 90, flipX: true });
    });

    it("loads the saved import, with its log, after a page reload", async () => {
        await rotateExistingImage();
        await importIlium();
        await save();
        const stored = JSON.parse(JSON.stringify(backend.scene()));

        jest.resetModules();
        document.body.innerHTML = bodyHtml;
        scenesModule = require("../js/scenes.js");
        scenesModule.initializeSceneEditor();
        $("text-button-SceneEditor").click();
        await waitFor(() => expect(sceneButton("scene-1")).not.toBeNull());
        await openScene("scene-1", "Pelvis Study");

        expect(scenesModule.getActiveScene()).toEqual(stored);
        expect($("scene-meta").textContent).toBe("3 images · 19 annotations");
        expect($("scene-save-status").textContent).toBe("Saved");
    });

    it("keeps the import log to the server's last 50 entries", async () => {
        const oldLog = Array.from({ length: 50 }, (_, i) => ({ at: V0, boneId: `old-${i}` }));
        await setup([{ id: "scene-1", name: "Pelvis Study", importLog: oldLog }]);

        await importIlium();

        const log = scenesModule.getActiveScene().importLog;
        expect(log).toHaveLength(50);
        expect(log[0].boneId).toBe("old-1");
        expect(log[49].boneId).toBe("ilium");
    });

    it("leaves the server untouched when the import is discarded by opening another scene", async () => {
        const storedBefore = JSON.parse(JSON.stringify(backend.scene()));
        await rotateExistingImage();
        await importIlium();

        const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
        sceneButton("scene-2").click();
        expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to \"Pelvis Study\"?");
        expect($("scene-title").textContent).toBe("Pelvis Study");
        expect(scenesModule.getActiveScene().images).toHaveLength(3);

        confirm.mockReturnValue(true);
        await openScene("scene-2", "Other Scene");
        await openScene("scene-1", "Pelvis Study");

        expect(writes()).toEqual([]);
        expect(backend.scene()).toEqual(storedBefore);
        expect(scenesModule.getActiveScene()).toEqual(storedBefore);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("asks before the page is closed with an unsaved import, and not after saving it", async () => {
        const unload = () => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };
        expect(unload()).toBe(false);

        await importIlium();
        expect(unload()).toBe(true);
        expect(backend.scene().images).toHaveLength(1);

        await save();
        expect(unload()).toBe(false);
    });

    it("still reports a genuine change made elsewhere as a conflict, and can overwrite it", async () => {
        await rotateExistingImage();
        await importIlium();
        backend.changeElsewhere("scene-1", (scene) => {
            scene.images = [];
        });
        const theirVersion = backend.scene().updatedAt;

        $("scene-save").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Save failed"));
        expect($("scene-workspace-error-text").textContent).toMatch(/changed somewhere else after you opened it/);
        expect($("scene-workspace-retry").textContent).toBe("Overwrite with my version");
        expect($("scene-workspace-secondary").textContent).toBe("Reload saved version");
        expect(backend.scene().images).toEqual([]);
        expect(scenesModule.getActiveScene().images).toHaveLength(3);

        $("scene-workspace-retry").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
        const puts = backend.calls.filter((call) => call.method === "PUT");
        expect(puts.map((call) => call.body.baseUpdatedAt)).toEqual([V0, theirVersion]);
        expect(backend.scene().images).toHaveLength(3);
        expect(backend.scene().importLog).toHaveLength(1);
        expect($("scene-workspace-error").hidden).toBe(true);
    });

    it("drops the import when the user reloads the saved version after a conflict", async () => {
        await importIlium();
        backend.changeElsewhere("scene-1", (scene) => {
            scene.annotations = [{ id: "theirs", type: "text", text: "Theirs", x: 0, y: 0 }];
        });

        $("scene-save").click();
        await waitFor(() => expect($("scene-workspace-secondary").hidden).toBe(false));
        $("scene-workspace-secondary").click();

        await waitFor(() => expect(scenesModule.getActiveScene().annotations.map((a) => a.id)).toEqual(["theirs"]));
        expect(scenesModule.getActiveScene().images.map((image) => image.id)).toEqual(["existing"]);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
        expect(backend.scene().importLog).toBeUndefined();
        expect($("scene-workspace-error").hidden).toBe(true);
    });

    it("keeps the edit and the import after a failed save, and saves both on retry", async () => {
        await rotateExistingImage();
        await importIlium();
        const release = backend.hold("PUT", "/scene-1", { status: 500 });
        release();

        $("scene-save").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Save failed"));
        expect($("scene-workspace-error-text").textContent).toMatch(/Your changes are still here/);
        expect(scenesModule.getActiveScene().images).toHaveLength(3);
        expect(backend.scene().images).toHaveLength(1);

        $("scene-workspace-retry").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
        expect(backend.scene().images).toHaveLength(3);
        expect(backend.scene().images[0].rotation).toBe(90);
    });

    it("keeps an import that finishes during a save unsaved, so the next save includes it", async () => {
        await rotateExistingImage();
        const release = backend.hold("PUT", "/scene-1");
        $("scene-save").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saving…"));

        await importIlium();
        release();
        await waitFor(() => expect(backend.scene().images[0].rotation).toBe(90));
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Unsaved changes"));
        expect(backend.scene().images).toHaveLength(1);

        await save();
        expect(backend.scene().images).toHaveLength(3);
    });

    it("drops an import that finishes after a different scene was opened", async () => {
        const release = backend.hold("POST", "/import-legacy");
        await submitIliumImport();
        await waitFor(() => expect(importCalls()).toHaveLength(1));

        await openScene("scene-2", "Other Scene");
        release();
        await waitFor(() => expect($("scene-editor-status").textContent).toMatch(/import from Ilium was dropped/));

        expect(scenesModule.getActiveScene().id).toBe("scene-2");
        expect($("scene-meta").textContent).toContain("0 images");
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
        expect(backend.scene("scene-1").images).toHaveLength(1);
        expect(backend.scene("scene-2").images).toHaveLength(0);
        expect(writes()).toEqual([]);
    });
});

describe("Scene editor: bone import alongside direct image import", () => {
    let originalImage;
    let originalFileReader;

    beforeEach(async () => {
        // jsdom can't read files or load images, so both are stubbed the same
        // way templates/tests/scenes.test.js does for the direct-import tests.
        originalFileReader = window.FileReader;
        window.FileReader = class {
            readAsDataURL(_file) {
                setTimeout(() => {
                    this.result = "data:image/png;base64,AAAA";
                    if (this.onload) this.onload();
                }, 0);
            }
        };
        originalImage = window.Image;
        window.Image = class {
            constructor() {
                this.naturalWidth = 800;
                this.naturalHeight = 400;
            }
            set src(_value) {
                setTimeout(() => this.onload && this.onload(), 0);
            }
        };
        await setup();
    });

    afterEach(() => {
        window.Image = originalImage;
        window.FileReader = originalFileReader;
    });

    it("keeps a directly imported image through a bone import and saves all of them together", async () => {
        const input = $("scene-import-input");
        Object.defineProperty(input, "files", { value: [{ name: "photo.png", type: "image/png" }], configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => expect($("scene-meta").textContent).toContain("1 image"));
        expect(writes()).toEqual([]);

        await importIlium();
        expect($("scene-meta").textContent).toContain("3 images");
        const sources = scenesModule.getActiveScene().images.map((image) => image.src);
        expect(sources).toEqual(["data:image/png;base64,AAAA", "/api/images/ilium_image1.jpg", "/api/images/ilium_image2.jpg"]);
        expect(backend.scene().images).toHaveLength(0);

        $("scene-save").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
        expect(backend.scene().images.map((image) => image.src)).toEqual(sources);
    });
});

describe("Scene editor: the intended view of imported images - Issue 536", () => {
    const UPLOADED = { id: "uploaded", src: "/api/images/pelvis.jpg", x: 0, y: 400, width: 100, height: 200 };
    const LATERAL = { caption: "Right Pelvis (lateral aspect)", basis: "slide-caption" };
    const MEDIAL = { caption: "Right Pelvis(medial aspect)", basis: "slide-caption" };

    beforeEach(() => setup([{ id: "scene-1", name: "Pelvis Study", images: [{ ...UPLOADED }] }]));

    // Each click is at a different spot, so it selects the clicked image
    // instead of stepping down a stack of objects (#441).
    async function selectImage(index) {
        const node = document.querySelector(`[data-scene-image-index="${index}"]`);
        node.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100 * (index + 1), clientY: 100 * (index + 1) }));
        await waitFor(() => expect($("scene-image-toolbar").hidden).toBe(false));
        expect(scenesModule.getActiveScene().images[index]).toBeDefined();
        return $("scene-image-view").textContent;
    }

    it("records each imported image's view from its slide caption", async () => {
        await importIlium();

        const images = scenesModule.getActiveScene().images;
        expect(images.map((image) => image.source && image.source.view)).toEqual([undefined, LATERAL, MEDIAL]);
    });

    it("shows the selected image's view, and says clearly when it isn't recorded", async () => {
        await importIlium();

        expect(await selectImage(1)).toBe("View: Right Pelvis (lateral aspect) (from the slide caption)");
        expect(await selectImage(2)).toBe("View: Right Pelvis(medial aspect) (from the slide caption)");
        expect(await selectImage(0)).toBe("View: not recorded.");
    });

    it("keeps the views through save and reload", async () => {
        await importIlium();
        $("scene-save").click();
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
        expect(backend.scene().images.map((image) => image.source && image.source.view)).toEqual([undefined, LATERAL, MEDIAL]);

        jest.resetModules();
        document.body.innerHTML = bodyHtml;
        scenesModule = require("../js/scenes.js");
        scenesModule.initializeSceneEditor();
        $("text-button-SceneEditor").click();
        await waitFor(() => expect(sceneButton("scene-1")).not.toBeNull());
        await openScene("scene-1", "Pelvis Study");

        expect(scenesModule.getActiveScene().images.map((image) => image.source && image.source.view)).toEqual([undefined, LATERAL, MEDIAL]);
        expect(await selectImage(2)).toBe("View: Right Pelvis(medial aspect) (from the slide caption)");
    });
});
