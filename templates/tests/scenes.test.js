const fs = require("fs");
const path = require("path");

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "boneset.html"), "utf8");
const bodyHtml = pageHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, "");

// In-memory stand-in for /api/scenes. `fail(method, status)` makes the next
// matching request fail; `delay(method, ms)` slows the next matching request.
function createFakeBackend() {
    const scenes = new Map();
    const overrides = [];
    const calls = [];
    let counter = 0;
    let version = 0;

    const respond = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(JSON.stringify(body)),
    });
    const summary = (s) => ({
        id: s.id,
        name: s.name,
        imageCount: s.images.length,
        annotationCount: s.annotations.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    });
    const nameTaken = (name, exceptId) =>
        [...scenes.values()].some((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());

    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : undefined;
        const [, rawId = "", action = null] = url.match(/^\/api\/scenes\/?([^/]*)(?:\/(.+))?$/);
        const id = decodeURIComponent(rawId) || null;
        calls.push(action ? { method, id, action, body } : { method, id, body });

        const index = overrides.findIndex((o) => o.method === method && (!o.id || o.id === id));
        if (index !== -1) {
            const [override] = overrides.splice(index, 1);
            if (override.delay) await new Promise((r) => setTimeout(r, override.delay));
            if (override.network) throw new TypeError("Failed to fetch");
            if (override.status) return respond(override.status, { error: override.error || "Forced error" });
        }

        // Every write gets a strictly later version, like the real server.
        const now = new Date(Date.parse("2026-10-01T00:00:00.000Z") + (version += 1) * 1000).toISOString();
        const nextFreeName = (base) => {
            let name = base;
            for (let n = 2; nameTaken(name); n += 1) name = `${base} ${n}`;
            return name;
        };
        if (!id && method === "GET") return respond(200, { scenes: [...scenes.values()].map(summary) });
        if (!id && method === "POST") {
            if (body.name && nameTaken(body.name)) return respond(409, { error: "Name taken" });
            counter += 1;
            const scene = {
                id: `scene-${counter}`,
                name: body.name || nextFreeName("Untitled Scene"),
                images: body.images || [],
                annotations: body.annotations || [],
                ...(body.importLog ? { importLog: body.importLog } : {}),
                createdAt: now,
                updatedAt: now,
            };
            scenes.set(scene.id, scene);
            return respond(201, scene);
        }

        const scene = scenes.get(id);
        if (!scene) return respond(404, { error: "Scene not found" });
        if (action === "duplicate" && method === "POST") {
            counter += 1;
            const copy = {
                ...JSON.parse(JSON.stringify(scene)),
                id: `scene-${counter}`,
                name: nextFreeName(`${scene.name} copy`),
                createdAt: now,
                updatedAt: now,
            };
            scenes.set(copy.id, copy);
            return respond(201, copy);
        }
        if (action) return respond(404, { error: "Not found" });
        if (method === "GET") return respond(200, scene);
        if (method === "PATCH") {
            const name = (body.name || "").trim();
            if (!name) return respond(400, { error: "Scene name cannot be empty" });
            if (nameTaken(name, id)) return respond(409, { error: "Name taken" });
            scene.name = name;
            scene.updatedAt = now;
            return respond(200, scene);
        }
        if (method === "PUT") {
            if (!Array.isArray(body.images) || !Array.isArray(body.annotations)) {
                return respond(400, { error: "images and annotations must be arrays" });
            }
            if (body.baseUpdatedAt && body.baseUpdatedAt !== scene.updatedAt) {
                return respond(412, { error: "Scene has changed", updatedAt: scene.updatedAt });
            }
            scene.images = body.images;
            scene.annotations = body.annotations;
            if (body.importLog !== undefined) scene.importLog = body.importLog;
            scene.updatedAt = now;
            return respond(200, scene);
        }
        if (method === "DELETE") {
            scenes.delete(id);
            return { ok: true, status: 204, json: async () => null };
        }
        return respond(405, { error: "Method not allowed" });
    });

    return {
        fetch,
        calls,
        scenes,
        seed(scene) {
            counter += 1;
            const full = {
                id: `scene-${counter}`,
                images: [],
                annotations: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                ...scene,
            };
            scenes.set(full.id, full);
            return full;
        },
        fail(method, status, { id, error } = {}) {
            overrides.push({ method, status, id, error });
        },
        failNetwork(method, { id } = {}) {
            overrides.push({ method, id, network: true });
        },
        delay(method, ms, { id } = {}) {
            overrides.push({ method, id, delay: ms });
        },
        // Another user saving a scene from somewhere else.
        changeElsewhere(id, change) {
            const scene = scenes.get(id);
            change(scene);
            scene.updatedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + (version += 1) * 1000).toISOString();
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
const click = (id) => $(id).click();
const listNames = () => [...document.querySelectorAll(".scene-list-name")].map((n) => n.textContent);
const listButton = (name) =>
    [...document.querySelectorAll(".scene-list-item")].find((b) => b.querySelector(".scene-list-name").textContent === name);
const storedScene = (name) => [...backend.scenes.values()].find((s) => s.name === name);
const storedImages = (name) => storedScene(name).images;

let backend;
let scenesModule;

beforeEach(() => {
    document.body.innerHTML = bodyHtml;
    backend = createFakeBackend();
    global.fetch = backend.fetch;
    jest.resetModules();
    scenesModule = require("../js/scenes.js");
    scenesModule.initializeSceneEditor();
});

afterEach(() => {
    jest.restoreAllMocks();
});

async function enterEditor() {
    click("text-button-SceneEditor");
    await waitFor(() => expect($("scene-library-message").hidden).toBe(true));
}

async function openByName(name) {
    listButton(name).click();
    await waitFor(() => expect($("scene-title").textContent).toBe(name));
}

describe("Scene editor: entering and leaving", () => {
    it("opens separately from the viewer and returns to it", async () => {
        expect($("scene-editor-view").hidden).toBe(true);
        expect($("editor-view").hidden).toBe(false);

        await enterEditor();
        expect($("scene-editor-view").hidden).toBe(false);
        expect($("editor-view").hidden).toBe(true);
        expect(backend.calls).toEqual([{ method: "GET", id: null, body: undefined }]);

        click("scene-editor-back");
        expect($("scene-editor-view").hidden).toBe(true);
        expect($("editor-view").hidden).toBe(false);
    });

    it("keeps the open scene when re-entering the editor", async () => {
        backend.seed({ name: "Pelvis" });
        await enterEditor();
        await openByName("Pelvis");

        click("scene-editor-back");
        await enterEditor();
        expect($("scene-title").textContent).toBe("Pelvis");
        expect(listButton("Pelvis").getAttribute("aria-current")).toBe("true");
    });

    it("does not load full scenes until one is selected", async () => {
        backend.seed({ name: "A" });
        backend.seed({ name: "B" });
        await enterEditor();
        expect(backend.calls.filter((c) => c.id)).toEqual([]);
    });
});

describe("Scene editor: create (#421)", () => {
    it("shows an empty library and creates distinct blank scenes", async () => {
        await enterEditor();
        expect($("scene-library-empty").hidden).toBe(false);

        click("scene-empty-new");
        await waitFor(() => expect($("scene-title").textContent).toBe("Untitled Scene"));
        expect($("scene-canvas-empty").hidden).toBe(false);
        const firstId = scenesModule.getActiveScene().id;

        click("scene-new");
        await waitFor(() => expect($("scene-title").textContent).toBe("Untitled Scene 2"));
        expect(scenesModule.getActiveScene().id).not.toBe(firstId);
        expect($("scene-canvas-empty").hidden).toBe(false);
        expect(listNames()).toEqual(["Untitled Scene", "Untitled Scene 2"]);
        expect($("scene-library-empty").hidden).toBe(true);
        expect(backend.calls.filter((c) => c.method === "POST").every((c) => JSON.stringify(c.body) === "{}")).toBe(true);
    });

    it("shows the storage message when the API returns 503", async () => {
        await enterEditor();
        backend.fail("POST", 503);
        click("scene-new");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect($("scene-workspace-error-text").textContent).toMatch(/Scene storage is not configured/);
    });
});

describe("Scene editor: open (#422, #425)", () => {
    it("lists counts and renders saved objects without changing them", async () => {
        const images = [{ id: "i1", src: "/api/images/ilium.png", x: 10, y: 20, width: 300, height: 200, rotation: 15, flipX: true }];
        const annotations = [
            { id: "a1", type: "text", text: "Ilium", x: 40, y: 30, color: "#003366" },
            { id: "a2", type: "polygon", points: [[0, 0], [100, 0], [100, 100]], fill: "#ff000055" },
            { id: "a3", type: "arrow", x1: 0, y1: 0, x2: 50, y2: 50 },
            { id: "a4", type: "future-tool", data: 1 },
        ];
        const seeded = backend.seed({ name: "Dense", images, annotations });
        await enterEditor();

        expect(listButton("Dense").textContent).toMatch(/1 image · 4 annotations/);
        await openByName("Dense");

        const svg = $("scene-canvas").querySelector("svg");
        expect(svg.querySelectorAll("image")).toHaveLength(1);
        expect(svg.querySelector("image").getAttribute("transform")).toMatch(/rotate\(15/);
        expect(svg.querySelector("text").textContent).toBe("Ilium");
        expect(svg.querySelectorAll("polygon")).toHaveLength(1);
        expect(svg.querySelectorAll("polyline")).toHaveLength(1);
        expect($("scene-canvas-note").textContent).toMatch(/1 object can't be displayed yet/);
        expect(scenesModule.getActiveScene().annotations).toEqual(seeded.annotations);
    });

    it("shows the newest selection when an older request finishes later", async () => {
        backend.seed({ name: "Slow" });
        backend.seed({ name: "Fast" });
        await enterEditor();

        backend.delay("GET", 60, { id: "scene-1" });
        listButton("Slow").click();
        listButton("Fast").click();
        await waitFor(() => expect($("scene-title").textContent).toBe("Fast"));
        await new Promise((r) => setTimeout(r, 100));
        expect($("scene-title").textContent).toBe("Fast");
    });

    it("explains a scene deleted elsewhere and refreshes the library", async () => {
        backend.seed({ name: "Gone" });
        await enterEditor();
        backend.scenes.clear();

        listButton("Gone").click();
        await waitFor(() => expect($("scene-workspace-error-text").textContent).toMatch(/no longer available/));
        await waitFor(() => expect(listNames()).toEqual([]));
        expect($("scene-workspace-scene").hidden).toBe(true);
    });

    it("offers a retry when the library fails to load", async () => {
        backend.failNetwork("GET");
        click("text-button-SceneEditor");
        await waitFor(() => expect($("scene-library-retry").hidden).toBe(false));
        expect($("scene-library-message-text").textContent).toMatch(/Couldn't reach the server/);

        backend.seed({ name: "Back" });
        click("scene-library-retry");
        await waitFor(() => expect(listNames()).toEqual(["Back"]));
    });
});

describe("Scene editor: rename (#423)", () => {
    beforeEach(async () => {
        backend.seed({ name: "Original" });
        backend.seed({ name: "Other" });
        await enterEditor();
        await openByName("Original");
    });

    it("updates the title and list only after the server accepts the name", async () => {
        click("scene-rename");
        $("scene-rename-input").value = "  Thorax  ";
        $("scene-rename-form").requestSubmit();

        await waitFor(() => expect($("scene-title").textContent).toBe("Thorax"));
        expect(listNames()).toContain("Thorax");
        expect(backend.calls.find((c) => c.method === "PATCH").body).toEqual({ name: "Thorax" });
    });

    it("rejects an empty name without sending a request", async () => {
        click("scene-rename");
        $("scene-rename-input").value = "   ";
        $("scene-rename-form").requestSubmit();

        expect($("scene-rename-error").hidden).toBe(false);
        expect($("scene-rename-error").textContent).toMatch(/up to 100 characters/);
        expect(backend.calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("explains a duplicate name and keeps the old name", async () => {
        click("scene-rename");
        $("scene-rename-input").value = "other";
        $("scene-rename-form").requestSubmit();

        await waitFor(() => expect($("scene-rename-error").textContent).toMatch(/already uses that name/));
        expect($("scene-rename-form").hidden).toBe(false);
        expect(scenesModule.getActiveScene().name).toBe("Original");
        expect(listNames()).toContain("Original");
    });
});

describe("Scene editor: delete (#424)", () => {
    beforeEach(async () => {
        backend.seed({ name: "Keep" });
        backend.seed({ name: "Remove" });
        await enterEditor();
        await openByName("Remove");
    });

    it("does nothing when the confirmation is cancelled", () => {
        const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
        click("scene-delete");
        expect(confirm).toHaveBeenCalledWith(expect.stringContaining("\"Remove\""));
        expect(backend.calls.some((c) => c.method === "DELETE")).toBe(false);
        expect(listNames()).toEqual(["Keep", "Remove"]);
    });

    it("removes only the confirmed scene after the server succeeds", async () => {
        jest.spyOn(window, "confirm").mockReturnValue(true);
        click("scene-delete");
        await waitFor(() => expect(listNames()).toEqual(["Keep"]));
        expect($("scene-workspace-scene").hidden).toBe(true);
        expect(backend.scenes.size).toBe(1);
    });

    it("keeps the row when the delete fails", async () => {
        jest.spyOn(window, "confirm").mockReturnValue(true);
        backend.fail("DELETE", 500);
        click("scene-delete");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect(listNames()).toEqual(["Keep", "Remove"]);
        expect($("scene-title").textContent).toBe("Remove");
    });
});

describe("describeError", () => {
    it("maps each status to a user-facing message", () => {
        const { describeError, SceneApiError } = scenesModule;
        expect(describeError(new SceneApiError(429, "x"), "open")).toMatch(/Too many requests/);
        expect(describeError(new SceneApiError(503, "x"), "create")).toMatch(/Scene storage is not configured/);
        expect(describeError(new SceneApiError(0, "x"), "load")).toMatch(/Couldn't reach the server/);
        expect(describeError(new SceneApiError(500, "x"), "delete")).toMatch(/Try again/);
    });
});

// Issues #411/#412: importing an image into a scene, selecting it once rendered,
// and persisting it.
describe("Scene editor: importing images - Issue 411", () => {
    let originalImage;
    let originalFileReader;

    beforeEach(() => {
        // jsdom doesn't implement real file reading or image loading, so both are
        // stubbed: FileReader "reads" a fixed data URL and Image "loads" fixed
        // dimensions, both asynchronously via a real setTimeout (fake timers are
        // not enabled in this suite, so this resolves naturally).
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
    });

    afterEach(() => {
        window.Image = originalImage;
        window.FileReader = originalFileReader;
    });

    function setFiles(files) {
        const input = $("scene-import-input");
        Object.defineProperty(input, "files", { value: files, configurable: true });
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    async function openNewScene() {
        await enterEditor();
        click("scene-new");
        await waitFor(() => expect($("scene-workspace-scene").hidden).toBe(false));
    }

    it("adds a supported image to the scene and renders it as a selectable object", async () => {
        await openNewScene();

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect($("scene-meta").textContent).toContain("1 image"));

        const nodes = document.querySelectorAll(".scene-image-object");
        expect(nodes).toHaveLength(1);
        expect(nodes[0].getAttribute("data-scene-image-index")).toBe("0");
        expect($("scene-canvas").hidden).toBe(false);
        expect($("scene-canvas-empty").hidden).toBe(true);
    });

    it("shows a clear message and adds nothing for an unsupported file type", async () => {
        await openNewScene();

        setFiles([{ name: "notes.pdf", type: "application/pdf" }]);
        await waitFor(() => expect($("scene-image-import-error").hidden).toBe(false));

        expect($("scene-image-import-error").textContent).toMatch(/notes\.pdf/);
        expect($("scene-image-import-error").textContent).toMatch(/unsupported/i);
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(0);
        expect($("scene-meta").textContent).toContain("0 images");
    });

    it("still adds the supported files when a multi-file import includes an unsupported one", async () => {
        await openNewScene();

        setFiles([
            { name: "ilium.png", type: "image/png" },
            { name: "notes.pdf", type: "application/pdf" },
        ]);
        await waitFor(() => expect($("scene-image-import-error").hidden).toBe(false));

        expect($("scene-meta").textContent).toContain("1 image");
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1);
        expect($("scene-image-import-error").textContent).toMatch(/notes\.pdf/);
    });

    it("selects an image on click and keeps it selected on a second click (Issue 440)", async () => {
        await openNewScene();
        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1));

        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await waitFor(() => expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1));

        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);
    });

    it("clears the selection when clicking empty canvas background", async () => {
        await openNewScene();
        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1));

        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await waitFor(() => expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1));

        $("scene-canvas").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
    });

    it("resets the selection when a different scene is opened", async () => {
        // Seeded with its own pre-existing image so the assertion below proves the
        // selection was actually reset, not just that the other scene is empty.
        backend.seed({
            name: "Other",
            images: [{ src: "/images/other.png", x: 0, y: 0, width: 100, height: 100 }],
        });
        await openNewScene();
        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1));
        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await waitFor(() => expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1));

        jest.spyOn(window, "confirm").mockReturnValue(true);
        await openByName("Other");

        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1);
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
    });

    // Issue #412: an imported image is part of the working copy and is stored
    // by the next Save (Issue #452), not by its own request.
    it("keeps an imported image in the working copy until the scene is saved", async () => {
        await openNewScene();
        const title = $("scene-title").textContent;
        const writesBefore = backend.calls.length;

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect($("scene-meta").textContent).toContain("1 image"));
        expect(backend.calls.length).toBe(writesBefore);
        expect(storedImages(title)).toHaveLength(0);
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        await waitFor(() => expect($("scene-editor-status").textContent).toBe("1 image added to the scene. Save to keep it."));

        click("scene-save");
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
        const put = backend.calls.find((c) => c.method === "PUT");
        expect(put.body.images).toEqual([expect.objectContaining({ src: "data:image/png;base64,AAAA" })]);
        expect(typeof put.body.images[0].id).toBe("string");
        expect(storedImages(title)).toHaveLength(1);
    });

    it("rejects a file over the size cap client-side without contacting the server", async () => {
        await openNewScene();

        setFiles([{ name: "huge.png", type: "image/png", size: 3 * 1024 * 1024 }]);
        await waitFor(() => expect($("scene-image-import-error").hidden).toBe(false));

        expect($("scene-image-import-error").textContent).toMatch(/huge\.png/);
        expect($("scene-image-import-error").textContent).toMatch(/too large/i);
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(0);
        expect(backend.calls.some((c) => ["PATCH", "PUT"].includes(c.method))).toBe(false);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("updates the scene list's image count once the import is saved", async () => {
        await openNewScene();
        const title = $("scene-title").textContent;

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect($("scene-meta").textContent).toContain("1 image"));
        expect(listButton(title).textContent).toMatch(/0 images/);

        click("scene-save");
        await waitFor(() => expect(listButton(title).textContent).toMatch(/1 image/));
    });

    // PR #493 review: switching scenes while an earlier file in the same
    // import was still being read could land the image on whichever scene
    // happened to be open when the read finished, not the one import started on.
    it("does not add an imported image to the wrong scene when the user switches scenes mid-import", async () => {
        backend.seed({ name: "Other" });
        await openNewScene();
        const originalTitle = $("scene-title").textContent;

        // Slowed down so switching scenes reliably finishes first.
        window.FileReader = class {
            readAsDataURL(_file) {
                setTimeout(() => {
                    this.result = "data:image/png;base64,AAAA";
                    if (this.onload) this.onload();
                }, 30);
            }
        };

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await openByName("Other");

        // Give the slow read time to finish while "Other" is the open scene,
        // then check state directly - a DOM check alone wouldn't catch a push
        // onto the wrong in-memory scene unless something happens to re-render
        // it afterward, which isn't guaranteed.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(scenesModule.getActiveScene().images).toHaveLength(0);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);

        // It was never saved to the scene it started on either.
        await openByName(originalTitle);
        expect(scenesModule.getActiveScene().images).toHaveLength(0);
        expect(storedImages(originalTitle)).toHaveLength(0);
    });
});

function selectImage(index) {
    document
        .querySelector(`[data-scene-image-index="${index}"]`)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const sceneWrites = () => backend.calls.filter((c) => ["PATCH", "PUT"].includes(c.method));

async function saveAndWait() {
    click("scene-save");
    await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
}

// Issues #418/#419: removing an image and reordering the stack. Each edit
// changes the working copy only; Save stores it.
describe("Scene editor: remove and reorder images", () => {
    async function openSceneWithTwoImages() {
        backend.seed({
            name: "Pair",
            images: [
                { id: "img-a", src: "/images/a.png", x: 0, y: 0, width: 100, height: 100 },
                { id: "img-b", src: "/images/b.png", x: 50, y: 50, width: 100, height: 100 },
            ],
        });
        await enterEditor();
        await openByName("Pair");
    }

    it("shows the image toolbar only while an image is selected", async () => {
        await openSceneWithTwoImages();
        expect($("scene-image-toolbar").hidden).toBe(true);

        selectImage(0);
        expect($("scene-image-toolbar").hidden).toBe(false);

        $("scene-canvas").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect($("scene-image-toolbar").hidden).toBe(true);
    });

    it("disables bring-forward at the top and send-backward at the bottom of the stack", async () => {
        await openSceneWithTwoImages();

        selectImage(0);
        expect($("scene-image-backward").disabled).toBe(true);
        expect($("scene-image-forward").disabled).toBe(false);

        selectImage(1);
        expect($("scene-image-forward").disabled).toBe(true);
        expect($("scene-image-backward").disabled).toBe(false);
    });

    it("removes the selected image from the working copy, and Save stores it", async () => {
        await openSceneWithTwoImages();
        selectImage(0);

        click("scene-image-remove");
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1);
        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-b"]);
        expect($("scene-image-toolbar").hidden).toBe(true);
        expect(sceneWrites()).toEqual([]);
        expect(storedImages("Pair").map((img) => img.id)).toEqual(["img-a", "img-b"]);

        await saveAndWait();
        expect(storedImages("Pair").map((img) => img.id)).toEqual(["img-b"]);
        expect(listButton("Pair").textContent).toMatch(/1 image/);
    });

    it("brings an image forward and sends it backward in the working copy", async () => {
        await openSceneWithTwoImages();
        selectImage(0);

        click("scene-image-forward");
        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-b", "img-a"]);
        click("scene-image-backward");
        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-a", "img-b"]);
        click("scene-image-forward");
        expect(sceneWrites()).toEqual([]);

        await saveAndWait();
        expect(storedImages("Pair").map((img) => img.id)).toEqual(["img-b", "img-a"]);
    });
});

// Issues #415/#416: rotating and flipping an image.
describe("Scene editor: rotate and flip images", () => {
    async function openSceneWithOneImage() {
        backend.seed({
            name: "Solo",
            images: [{ id: "img-a", src: "/images/a.png", x: 0, y: 0, width: 100, height: 50 }],
        });
        await enterEditor();
        await openByName("Solo");
        selectImage(0);
    }

    it("rotates by the stepper amount and wraps into [0, 360)", async () => {
        await openSceneWithOneImage();

        click("scene-image-rotate-right-90");
        expect(scenesModule.getActiveScene().images[0].rotation).toBe(90);
        click("scene-image-rotate-left-15");
        expect(scenesModule.getActiveScene().images[0].rotation).toBe(75);
        click("scene-image-rotate-left-90");
        click("scene-image-rotate-left-90");
        expect(scenesModule.getActiveScene().images[0].rotation).toBe(255);
        expect(sceneWrites()).toEqual([]);

        await saveAndWait();
        expect(storedImages("Solo")[0]).toMatchObject({ id: "img-a", rotation: 255 });
    });

    it("toggles flipX and flipY independently", async () => {
        await openSceneWithOneImage();

        click("scene-image-flip-horizontal");
        expect(scenesModule.getActiveScene().images[0].flipX).toBe(true);
        expect(scenesModule.getActiveScene().images[0].flipY).toBeFalsy();
        click("scene-image-flip-vertical");
        expect(scenesModule.getActiveScene().images[0].flipY).toBe(true);
        click("scene-image-flip-horizontal");
        expect(scenesModule.getActiveScene().images[0].flipX).toBe(false);

        await saveAndWait();
        expect(storedImages("Solo")[0]).toMatchObject({ flipX: false, flipY: true });
    });
});

// Issues #413/#414: dragging a selected image to move or resize it. jsdom
// doesn't implement real SVG layout, so `getBoundingClientRect` is mocked to
// a fixed size matching the scene's default 960x600 viewBox (a single small
// image never grows it), giving an exact 1:1 scene-unit-per-pixel scale that
// makes the expected numbers easy to check.
describe("Scene editor: move and resize images", () => {
    async function openSceneWithOneImage() {
        backend.seed({
            name: "Solo",
            images: [{ id: "img-a", src: "/images/a.png", x: 100, y: 100, width: 200, height: 100 }],
        });
        await enterEditor();
        await openByName("Solo");
        selectImage(0);
    }

    function mockSvgScale() {
        const svg = document.querySelector("#scene-canvas svg");
        svg.getBoundingClientRect = () => ({ width: 960, height: 600 });
        return svg;
    }

    function drag(target, from, to) {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: from.x, clientY: from.y }));
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: to.x, clientY: to.y }));
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: to.x, clientY: to.y }));
    }

    it("moves the selected image by the drag delta and marks the scene unsaved", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        const imageNode = document.querySelector("[data-scene-image-index=\"0\"]");

        drag(imageNode, { x: 0, y: 0 }, { x: 30, y: 20 });

        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 130, y: 120 });
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        expect(sceneWrites()).toEqual([]);
        await saveAndWait();
        expect(storedImages("Solo")[0]).toMatchObject({ x: 130, y: 120 });
    });

    it("does not move the image or mark a change for a mousedown/mouseup with no real movement", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        const imageNode = document.querySelector("[data-scene-image-index=\"0\"]");

        drag(imageNode, { x: 0, y: 0 }, { x: 0, y: 0 });

        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 100, y: 100 });
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("keeps the image selected after a move drag instead of the resulting click deselecting it", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        const imageNode = document.querySelector("[data-scene-image-index=\"0\"]");

        drag(imageNode, { x: 0, y: 0 }, { x: 30, y: 20 });

        // The drag's own re-renders replace the <image> DOM node, so the
        // original reference is now detached and can't bubble anywhere; the
        // simulated click (which real browsers fire after mouseup on the
        // same element regardless of movement in between, something jsdom
        // doesn't synthesize from dispatched mousedown/mouseup alone) has to
        // target the current node instead.
        document
            .querySelector("[data-scene-image-index=\"0\"]")
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);
    });

    it("resizes from a corner handle, preserving aspect ratio, anchored at the center", async () => {
        await openSceneWithOneImage(); // 200x100 at (100,100) -> center (200,150)
        mockSvgScale();
        const handle = document.querySelector("[data-corner=\"se\"]");

        drag(handle, { x: 0, y: 0 }, { x: 40, y: 0 });

        const image = scenesModule.getActiveScene().images[0];
        expect(image.width).toBeCloseTo(240);
        expect(image.height).toBeCloseTo(120);
        expect(image.x).toBeCloseTo(80);
        expect(image.y).toBeCloseTo(90);
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    });
});

// Issue #417: non-destructive cropping.
describe("Scene editor: crop an image", () => {
    async function openSceneWithOneImage() {
        backend.seed({
            name: "Solo",
            images: [{ id: "img-a", src: "/images/a.png", x: 100, y: 100, width: 200, height: 100 }],
        });
        await enterEditor();
        await openByName("Solo");
        selectImage(0);
    }

    function mockSvgScale() {
        const svg = document.querySelector("#scene-canvas svg");
        svg.getBoundingClientRect = () => ({ width: 960, height: 600 });
        return svg;
    }

    function drag(target, from, to) {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: from.x, clientY: from.y }));
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: to.x, clientY: to.y }));
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: to.x, clientY: to.y }));
    }

    it("toggles the toolbar between Crop and Done/Reset", async () => {
        await openSceneWithOneImage();
        expect($("scene-image-crop-start").hidden).toBe(false);
        expect($("scene-image-crop-done").hidden).toBe(true);

        click("scene-image-crop-start");
        expect($("scene-image-crop-start").hidden).toBe(true);
        expect($("scene-image-crop-done").hidden).toBe(false);
        expect($("scene-image-crop-reset").hidden).toBe(false);

        click("scene-image-crop-done");
        expect($("scene-image-crop-start").hidden).toBe(false);
        expect($("scene-image-crop-done").hidden).toBe(true);
    });

    it("shows the full image uncropped with a draft crop outline while in crop mode", async () => {
        await openSceneWithOneImage();
        click("scene-image-crop-start");

        expect(document.querySelector("image").hasAttribute("clip-path")).toBe(false);
        expect(document.querySelectorAll(".scene-crop-outline")).toHaveLength(1);
    });

    it("drags the se handle to shrink the crop rect, and Save stores it", async () => {
        await openSceneWithOneImage(); // 200x100
        mockSvgScale();
        click("scene-image-crop-start");
        const handle = document.querySelector("[data-corner=\"se\"]");

        drag(handle, { x: 0, y: 0 }, { x: -50, y: -20 });

        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 150, cropHeight: 80 });
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
        await saveAndWait();
        expect(storedImages("Solo")[0]).toMatchObject({ cropWidth: 150, cropHeight: 80 });
    });

    it("drags the nw handle, anchoring at the opposite corner of the crop rect", async () => {
        await openSceneWithOneImage(); // 200x100
        mockSvgScale();
        click("scene-image-crop-start");
        const handle = document.querySelector("[data-corner=\"nw\"]");

        drag(handle, { x: 0, y: 0 }, { x: 40, y: 20 });

        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ cropX: 40, cropY: 20, cropWidth: 160, cropHeight: 80 });
    });

    it("resets the crop back to fully visible", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        click("scene-image-crop-start");
        drag(document.querySelector("[data-corner=\"se\"]"), { x: 0, y: 0 }, { x: -50, y: -20 });
        expect(scenesModule.getActiveScene().images[0].cropWidth).toBe(150);

        click("scene-image-crop-reset");

        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 200, cropHeight: 100 });
    });

    it("exits crop mode without marking a change when nothing was dragged", async () => {
        await openSceneWithOneImage();
        click("scene-image-crop-start");
        const callsBefore = backend.calls.length;

        click("scene-image-crop-done");

        expect(backend.calls.length).toBe(callsBefore);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
        expect($("scene-image-toolbar").hidden).toBe(false);
        expect(document.querySelectorAll(".scene-crop-outline")).toHaveLength(0);
    });
});

// PR #493 review: an imported label follows its image through an edit made in
// the editor, and still lines up after the scene is reloaded from the server.
describe("Scene editor: imported annotations follow their image", () => {
    function labelCenter() {
        const node = document.querySelector(".scene-layer-annotations text");
        const fontSize = Number(node.getAttribute("font-size"));
        return [
            Number(node.getAttribute("x")) + (node.textContent.length * fontSize * 0.6) / 2,
            Number(node.getAttribute("y")) + fontSize / 2,
        ];
    }

    it("rotates a linked label with its image and keeps it there after saving and reopening the scene", async () => {
        const frame = { x: 100, y: 100, width: 200, height: 100 };
        backend.seed({ name: "Other" });
        backend.seed({
            name: "Linked",
            images: [{ id: "img-a", src: "/api/images/ilium.png", ...frame }],
            annotations: [{
                id: "label-1",
                type: "text",
                text: "Ilium",
                x: 150,
                y: 110,
                fontSize: 10,
                sourceImageId: "img-a",
                sourceImageFrame: frame,
                source: { type: "legacy-label" },
            }],
        });
        await enterEditor();
        await openByName("Linked");
        const [x0, y0] = labelCenter();
        expect(x0).toBeCloseTo(165);
        expect(y0).toBeCloseTo(115);

        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await waitFor(() => expect($("scene-image-toolbar").hidden).toBe(false));
        click("scene-image-rotate-right-90");

        // 90° about the image center (200, 150).
        let [x, y] = labelCenter();
        expect(x).toBeCloseTo(235);
        expect(y).toBeCloseTo(115);

        await saveAndWait();
        await openByName("Other");
        await openByName("Linked");
        [x, y] = labelCenter();
        expect(x).toBeCloseTo(235);
        expect(y).toBeCloseTo(115);
        const stored = [...backend.scenes.values()].find((s) => s.name === "Linked");
        expect(stored.annotations[0]).toMatchObject({ sourceImageId: "img-a", sourceImageFrame: frame, x: 150, y: 110 });
    });

    it("notes annotations whose source image was removed instead of dropping them", async () => {
        const frame = { x: 0, y: 0, width: 100, height: 100 };
        backend.seed({
            name: "Orphan",
            images: [],
            annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10, sourceImageId: "gone", sourceImageFrame: frame }],
        });
        await enterEditor();
        await openByName("Orphan");
        expect(document.querySelectorAll(".scene-layer-annotations text")).toHaveLength(1);
        expect($("scene-canvas-note").hidden).toBe(false);
        expect($("scene-canvas-note").textContent).toMatch(/1 imported annotation no longer has its source image/);
    });
});

// Issues #451-#456: the open scene is a working copy. Save stores it as one
// versioned write; a change made elsewhere since it was loaded is a conflict.
describe("Scene editor: save, load, update, duplicate - Issues 451-456", () => {
    const IMAGE = { id: "img-a", src: "/images/a.png", x: 0, y: 0, width: 100, height: 50 };
    let pelvis;

    beforeEach(async () => {
        pelvis = backend.seed({
            name: "Pelvis",
            images: [{ ...IMAGE }],
            annotations: [{ id: "note", type: "text", text: "Ilium", x: 5, y: 5 }],
            updatedAt: "2026-09-01T00:00:00.000Z",
        });
        backend.seed({ name: "Other" });
        await enterEditor();
        await openByName("Pelvis");
    });

    function rotate() {
        selectImage(0);
        click("scene-image-rotate-right-90");
    }

    it("shows Saved with Save disabled until something changes (Issue 453)", async () => {
        expect($("scene-save-status").textContent).toBe("Saved");
        expect($("scene-save-status").dataset.state).toBe("saved");
        expect($("scene-save").disabled).toBe(true);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);

        rotate();
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        expect($("scene-save-status").dataset.state).toBe("unsaved");
        expect($("scene-save").disabled).toBe(false);
        await waitFor(() => expect($("scene-editor-status").textContent).toBe("Unsaved changes."));
    });

    it("stores the whole working copy in one PUT based on the loaded version (Issue 452)", async () => {
        rotate();
        click("scene-image-flip-horizontal");

        await saveAndWait();

        const puts = backend.calls.filter((c) => c.method === "PUT");
        expect(puts).toEqual([{
            method: "PUT",
            id: pelvis.id,
            body: {
                images: [{ ...IMAGE, rotation: 90, flipX: true }],
                annotations: pelvis.annotations,
                baseUpdatedAt: "2026-09-01T00:00:00.000Z",
            },
        }]);
        expect($("scene-save").disabled).toBe(true);
        await waitFor(() => expect($("scene-editor-status").textContent).toBe("Saved Pelvis."));
    });

    it("saves again from the version it just stored, without a false conflict (Issue 454)", async () => {
        rotate();
        await saveAndWait();
        const firstVersion = storedScene("Pelvis").updatedAt;

        click("scene-image-rotate-right-90");
        await saveAndWait();

        const puts = backend.calls.filter((c) => c.method === "PUT");
        expect(puts[1].body.baseUpdatedAt).toBe(firstVersion);
        expect(storedScene("Pelvis").images[0].rotation).toBe(180);
        expect($("scene-workspace-error").hidden).toBe(true);
    });

    it("loads exactly what was saved (Issue 453)", async () => {
        rotate();
        await saveAndWait();
        const saved = JSON.parse(JSON.stringify(storedScene("Pelvis")));

        await openByName("Other");
        await openByName("Pelvis");
        expect(scenesModule.getActiveScene()).toEqual(saved);
        expect($("scene-save-status").textContent).toBe("Saved");
    });

    it("keeps an edit made while the save was in flight unsaved", async () => {
        rotate();
        backend.delay("PUT", 40);
        click("scene-save");
        expect($("scene-save-status").textContent).toBe("Saving…");
        expect($("scene-save").disabled).toBe(true);
        click("scene-image-flip-vertical");

        await waitFor(() => expect(storedScene("Pelvis").images[0].rotation).toBe(90));
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Unsaved changes"));
        expect(storedScene("Pelvis").images[0].flipY).toBeUndefined();
        expect(scenesModule.getActiveScene().images[0].flipY).toBe(true);
    });

    describe("unsaved-changes warning (related to #444)", () => {
        it("asks before opening another scene, and keeps the copy when cancelled", async () => {
            rotate();
            const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);

            listButton("Other").click();
            expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to \"Pelvis\"?");
            expect($("scene-title").textContent).toBe("Pelvis");
            expect(scenesModule.getActiveScene().images[0].rotation).toBe(90);
            expect(backend.calls.filter((c) => c.method === "GET" && c.id).map((c) => c.id)).toEqual([pelvis.id]);
        });

        it("discards the copy without storing it when the user agrees", async () => {
            rotate();
            jest.spyOn(window, "confirm").mockReturnValue(true);

            await openByName("Other");
            await openByName("Pelvis");
            expect(scenesModule.getActiveScene().images[0].rotation).toBeUndefined();
            expect(sceneWrites()).toEqual([]);
        });

        it("asks before creating a new scene", () => {
            rotate();
            const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
            click("scene-new");
            expect(confirm).toHaveBeenCalled();
            expect(backend.calls.some((c) => c.method === "POST")).toBe(false);
        });

        it("does not ask when there is nothing to lose", async () => {
            const confirm = jest.spyOn(window, "confirm");
            await openByName("Other");
            expect(confirm).not.toHaveBeenCalled();
        });

        it("asks the browser to confirm leaving the page only while there are unsaved changes", async () => {
            const leave = () => {
                const event = new Event("beforeunload", { cancelable: true });
                window.dispatchEvent(event);
                return event.defaultPrevented;
            };
            expect(leave()).toBe(false);
            rotate();
            expect(leave()).toBe(true);
            await saveAndWait();
            expect(leave()).toBe(false);
        });

        it("mentions unsaved changes when deleting", () => {
            rotate();
            const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
            click("scene-delete");
            expect(confirm.mock.calls[0][0]).toMatch(/Your unsaved changes will also be lost\.$/);
        });
    });

    describe("save failures (Issue 456)", () => {
        it("keeps the changes and offers a retry when the save fails", async () => {
            rotate();
            backend.fail("PUT", 500);

            click("scene-save");
            await waitFor(() => expect($("scene-save-status").textContent).toBe("Save failed"));
            expect($("scene-save-status").dataset.state).toBe("failed");
            expect($("scene-workspace-error-text").textContent).toBe(
                "Something went wrong on the server. Try again. Your changes are still here."
            );
            expect($("scene-workspace-retry").textContent).toBe("Retry save");
            expect(scenesModule.getActiveScene().images[0].rotation).toBe(90);
            expect($("scene-save").disabled).toBe(false);

            click("scene-workspace-retry");
            await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
            expect(storedScene("Pelvis").images[0].rotation).toBe(90);
            expect($("scene-workspace-error").hidden).toBe(true);
        });

        it("keeps the failure prompt through later edits, redraws, and a list refresh", async () => {
            rotate();
            backend.failNetwork("PUT");
            click("scene-save");
            await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
            const prompt = $("scene-workspace-error-text").textContent;
            expect(prompt).toMatch(/Couldn't reach the server/);

            click("scene-image-flip-horizontal");
            click("scene-fit-toggle");
            selectImage(0);
            click("scene-library-retry");
            await waitFor(() => expect($("scene-library-message").hidden).toBe(true));

            expect($("scene-workspace-error").hidden).toBe(false);
            expect($("scene-workspace-error-text").textContent).toBe(prompt);
            expect($("scene-workspace-retry").textContent).toBe("Retry save");
            expect($("scene-save-status").textContent).toBe("Save failed");
        });

        it("explains a scene that is too large to save", async () => {
            rotate();
            backend.fail("PUT", 413);
            click("scene-save");
            await waitFor(() => expect($("scene-workspace-error-text").textContent).toMatch(/too large to save/));
        });

        it("offers to overwrite or reload when the scene changed elsewhere", async () => {
            rotate();
            backend.changeElsewhere(pelvis.id, (scene) => {
                scene.annotations = [];
            });
            const theirVersion = storedScene("Pelvis").updatedAt;

            click("scene-save");
            await waitFor(() => expect($("scene-workspace-error-text").textContent)
                .toBe("This scene was changed somewhere else after you opened it. " +
                    "Overwrite it with your version, or reload the saved version and lose your changes."));
            expect($("scene-workspace-retry").textContent).toBe("Overwrite with my version");
            expect($("scene-workspace-secondary").hidden).toBe(false);
            expect(storedScene("Pelvis").annotations).toEqual([]);

            click("scene-workspace-retry");
            await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
            const puts = backend.calls.filter((c) => c.method === "PUT");
            expect(puts.map((c) => c.body.baseUpdatedAt)).toEqual(["2026-09-01T00:00:00.000Z", theirVersion]);
            expect(storedScene("Pelvis").annotations).toHaveLength(1);
        });

        it("reloads the other version when the user chooses to lose their changes", async () => {
            rotate();
            backend.changeElsewhere(pelvis.id, (scene) => {
                scene.annotations = [];
            });
            click("scene-save");
            await waitFor(() => expect($("scene-workspace-secondary").hidden).toBe(false));
            expect($("scene-workspace-secondary").textContent).toBe("Reload saved version");

            click("scene-workspace-secondary");
            await waitFor(() => expect(scenesModule.getActiveScene().annotations).toEqual([]));
            expect(scenesModule.getActiveScene().images[0].rotation).toBeUndefined();
            expect(scenesModule.hasUnsavedChanges()).toBe(false);
            expect($("scene-workspace-error").hidden).toBe(true);
        });

        it("does not mistake its own rename for a change made elsewhere", async () => {
            rotate();
            click("scene-rename");
            $("scene-rename-input").value = "Hip";
            $("scene-rename-form").requestSubmit();
            await waitFor(() => expect($("scene-title").textContent).toBe("Hip"));
            expect($("scene-save-status").textContent).toBe("Unsaved changes");

            await saveAndWait();
            expect(storedScene("Hip").images[0].rotation).toBe(90);
        });

        it("still reports a change made elsewhere even after renaming", async () => {
            rotate();
            backend.changeElsewhere(pelvis.id, (scene) => {
                scene.annotations = [];
            });
            click("scene-rename");
            $("scene-rename-input").value = "Hip";
            $("scene-rename-form").requestSubmit();
            await waitFor(() => expect($("scene-title").textContent).toBe("Hip"));

            click("scene-save");
            await waitFor(() => expect($("scene-workspace-error-text").textContent).toMatch(/changed somewhere else/));
            expect(storedScene("Hip").annotations).toEqual([]);
        });

        describe("when the scene was deleted elsewhere", () => {
            beforeEach(async () => {
                rotate();
                backend.scenes.delete(pelvis.id);
                click("scene-save");
                await waitFor(() => expect($("scene-workspace-retry").textContent).toBe("Save as new scene"));
            });

            it("keeps the working copy and offers to save it as a new scene or discard it", () => {
                expect($("scene-workspace-error-text").textContent)
                    .toMatch(/no longer available.*Your unsaved changes are still here\./);
                expect($("scene-workspace-secondary").textContent).toBe("Discard changes");
                expect(scenesModule.getActiveScene().images[0].rotation).toBe(90);
            });

            it("saves it as a new scene, with its content, in one request", async () => {
                const postsBefore = backend.calls.filter((c) => c.method === "POST").length;
                click("scene-workspace-retry");
                await waitFor(() => expect($("scene-editor-status").textContent).toBe("Saved as Pelvis."));

                const posts = backend.calls.filter((c) => c.method === "POST").slice(postsBefore);
                expect(posts).toHaveLength(1);
                expect(posts[0].body).toEqual({
                    name: "Pelvis",
                    images: [{ ...IMAGE, rotation: 90 }],
                    annotations: pelvis.annotations,
                });
                const created = storedScene("Pelvis");
                expect(created.id).not.toBe(pelvis.id);
                expect(created.images[0].rotation).toBe(90);
                expect(scenesModule.getActiveScene().id).toBe(created.id);
                expect($("scene-save-status").textContent).toBe("Saved");
                expect($("scene-workspace-error").hidden).toBe(true);

                // Later saves go to the new scene.
                click("scene-image-flip-horizontal");
                await saveAndWait();
                expect(storedScene("Pelvis").images[0].flipX).toBe(true);
            });

            it("uses a default name when the old name was taken in the meantime", async () => {
                backend.seed({ name: "Pelvis" });
                click("scene-workspace-retry");
                await waitFor(() => expect($("scene-editor-status").textContent).toBe("Saved as Untitled Scene."));
                expect(storedScene("Untitled Scene").images[0].rotation).toBe(90);
            });

            it("keeps both choices and creates nothing when saving as new fails", async () => {
                const scenesBefore = backend.scenes.size;
                backend.fail("POST", 500);
                click("scene-workspace-retry");
                await waitFor(() => expect($("scene-workspace-error-text").textContent)
                    .toMatch(/^Something went wrong on the server/));

                expect(backend.scenes.size).toBe(scenesBefore);
                expect($("scene-workspace-retry").textContent).toBe("Save as new scene");
                expect($("scene-workspace-secondary").textContent).toBe("Discard changes");
                expect(scenesModule.getActiveScene().images[0].rotation).toBe(90);

                click("scene-workspace-retry");
                await waitFor(() => expect($("scene-editor-status").textContent).toBe("Saved as Pelvis."));
            });

            it("closes the scene when the user discards the changes", async () => {
                click("scene-workspace-secondary");
                await waitFor(() => expect(listNames()).toEqual(["Other"]));
                expect($("scene-workspace-scene").hidden).toBe(true);
                expect(scenesModule.hasUnsavedChanges()).toBe(false);
            });
        });
    });

    describe("duplicate (Issue 455)", () => {
        it("opens an independent copy of the saved scene", async () => {
            click("scene-duplicate");
            await waitFor(() => expect($("scene-title").textContent).toBe("Pelvis copy"));

            const copy = scenesModule.getActiveScene();
            expect(copy.id).not.toBe(pelvis.id);
            expect(copy.images).toEqual(pelvis.images);
            expect(listNames()).toEqual(["Pelvis", "Other", "Pelvis copy"]);

            rotate();
            await saveAndWait();
            expect(storedScene("Pelvis copy").images[0].rotation).toBe(90);
            expect(storedScene("Pelvis").images[0].rotation).toBeUndefined();
        });

        it("asks first when there are unsaved changes, since the copy is of the saved version", async () => {
            rotate();
            const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
            click("scene-duplicate");
            expect(confirm.mock.calls[0][0]).toMatch(/copies the last saved version/);
            expect(backend.calls.some((c) => c.action === "duplicate")).toBe(false);

            confirm.mockReturnValue(true);
            click("scene-duplicate");
            await waitFor(() => expect($("scene-title").textContent).toBe("Pelvis copy"));
            expect(scenesModule.getActiveScene().images[0].rotation).toBeUndefined();
        });

        it("keeps the scene open and offers a retry when duplicating fails", async () => {
            backend.fail("POST", 500);
            click("scene-duplicate");
            await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
            expect($("scene-title").textContent).toBe("Pelvis");
            expect($("scene-workspace-retry").hidden).toBe(false);
        });
    });
});
