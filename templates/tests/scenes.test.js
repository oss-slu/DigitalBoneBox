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
        const id = decodeURIComponent(url.replace(/^\/api\/scenes\/?/, "")) || null;
        calls.push({ method, id, body });

        const index = overrides.findIndex((o) => o.method === method && (!o.id || o.id === id));
        if (index !== -1) {
            const [override] = overrides.splice(index, 1);
            if (override.delay) await new Promise((r) => setTimeout(r, override.delay));
            if (override.network) throw new TypeError("Failed to fetch");
            if (override.status) return respond(override.status, { error: override.error || "Forced error" });
        }

        const now = new Date(Date.now() + counter).toISOString();
        if (!id && method === "GET") return respond(200, { scenes: [...scenes.values()].map(summary) });
        if (!id && method === "POST") {
            counter += 1;
            let name = "Untitled Scene";
            for (let n = 2; nameTaken(name); n += 1) name = `Untitled Scene ${n}`;
            const scene = { id: `scene-${counter}`, name, images: [], annotations: [], createdAt: now, updatedAt: now };
            scenes.set(scene.id, scene);
            return respond(201, scene);
        }

        const scene = scenes.get(id);
        if (!scene) return respond(404, { error: "Scene not found" });
        if (method === "GET") return respond(200, scene);
        if (method === "PATCH") {
            const hasKnownField = body && (
                body.name !== undefined ||
                body.image !== undefined ||
                body.updateImage !== undefined ||
                body.removeImageId !== undefined ||
                body.reorderImageIds !== undefined
            );
            if (!hasKnownField) {
                return respond(400, {
                    error: "name, image, updateImage, removeImageId, or reorderImageIds is required",
                });
            }
            if (body.name !== undefined) {
                const name = (body.name || "").trim();
                if (!name) return respond(400, { error: "Scene name cannot be empty" });
                if (nameTaken(name, id)) return respond(409, { error: "Name taken" });
                scene.name = name;
            }
            if (body.image !== undefined) {
                const alreadyPresent = scene.images.some((img) => img.id === body.image.id);
                if (!alreadyPresent) scene.images.push(body.image);
            }
            if (body.updateImage !== undefined) {
                const { id: imageId, ...fields } = body.updateImage;
                const target = scene.images.find((img) => img.id === imageId);
                if (!target) return respond(404, { error: "Image not found" });
                Object.assign(target, fields);
            }
            if (body.removeImageId !== undefined) {
                scene.images = scene.images.filter((img) => img.id !== body.removeImageId);
            }
            if (body.reorderImageIds !== undefined) {
                const ids = body.reorderImageIds;
                const currentIds = scene.images.map((img) => img.id);
                const isSamePermutation =
                    Array.isArray(ids) &&
                    ids.length === currentIds.length &&
                    [...ids].sort().join() === [...currentIds].sort().join();
                if (!isSamePermutation) {
                    return respond(400, { error: "reorderImageIds must match the scene's current images" });
                }
                scene.images = ids.map((imgId) => scene.images.find((img) => img.id === imgId));
            }
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
        await waitFor(() => expect($("scene-import-error").hidden).toBe(false));

        expect($("scene-import-error").textContent).toMatch(/notes\.pdf/);
        expect($("scene-import-error").textContent).toMatch(/unsupported/i);
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(0);
        expect($("scene-meta").textContent).toContain("0 images");
    });

    it("still adds the supported files when a multi-file import includes an unsupported one", async () => {
        await openNewScene();

        setFiles([
            { name: "ilium.png", type: "image/png" },
            { name: "notes.pdf", type: "application/pdf" },
        ]);
        await waitFor(() => expect($("scene-import-error").hidden).toBe(false));

        expect($("scene-meta").textContent).toContain("1 image");
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1);
        expect($("scene-import-error").textContent).toMatch(/notes\.pdf/);
    });

    it("selects an image on click and deselects it on a second click", async () => {
        await openNewScene();
        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1));

        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await waitFor(() => expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1));

        document.querySelector(".scene-image-object").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
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

        await openByName("Other");

        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1);
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
    });

    // Issue #412: persisting an imported image so it survives a reload.
    it("persists an imported image by PATCHing the scene", async () => {
        await openNewScene();

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() =>
            expect(backend.calls.some((c) => c.method === "PATCH" && c.body && c.body.image)).toBe(true)
        );

        const patchCall = backend.calls.find((c) => c.method === "PATCH" && c.body && c.body.image);
        expect(patchCall.body.image).toMatchObject({ src: "data:image/png;base64,AAAA" });
        expect(typeof patchCall.body.image.id).toBe("string");

        const storedScene = [...backend.scenes.values()][0];
        expect(storedScene.images).toHaveLength(1);
    });

    it("rejects a file over the size cap client-side without contacting the server", async () => {
        await openNewScene();

        setFiles([{ name: "huge.png", type: "image/png", size: 3 * 1024 * 1024 }]);
        await waitFor(() => expect($("scene-import-error").hidden).toBe(false));

        expect($("scene-import-error").textContent).toMatch(/huge\.png/);
        expect($("scene-import-error").textContent).toMatch(/too large/i);
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(0);
        expect(backend.calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("keeps a save-failed image visible and lets the user retry", async () => {
        await openNewScene();
        backend.fail("PATCH", 500);

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));

        // Still visible locally even though persistence failed.
        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1);
        expect($("scene-workspace-error-text").textContent).toMatch(/could not be saved/i);

        click("scene-workspace-retry");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(true));

        expect(backend.calls.filter((c) => c.method === "PATCH" && c.body && c.body.image)).toHaveLength(2);
    });

    // PR #493 review: the scene list's image count was only ever refreshed by
    // a full re-list, so it kept showing "0 images" after an import until the
    // page was reloaded.
    it("updates the scene list's image count after an import without waiting for a reload", async () => {
        await openNewScene();
        const title = $("scene-title").textContent;

        setFiles([{ name: "ilium.png", type: "image/png" }]);
        await waitFor(() => expect($("scene-meta").textContent).toContain("1 image"));

        expect(listButton(title).textContent).toMatch(/1 image/);
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

        await openByName(originalTitle);
        await waitFor(() => expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1));
    });
});

function selectImage(index) {
    document
        .querySelector(`[data-scene-image-index="${index}"]`)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

// Issues #418/#419: removing an image and reordering the stack.
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

        selectImage(0);
        expect($("scene-image-toolbar").hidden).toBe(true);
    });

    it("disables bring-forward at the top and send-backward at the bottom of the stack", async () => {
        await openSceneWithTwoImages();

        selectImage(0);
        expect($("scene-image-backward").disabled).toBe(true);
        expect($("scene-image-forward").disabled).toBe(false);

        selectImage(0); // deselect
        selectImage(1);
        expect($("scene-image-forward").disabled).toBe(true);
        expect($("scene-image-backward").disabled).toBe(false);
    });

    it("removes the selected image, persists it, and updates the scene list count", async () => {
        await openSceneWithTwoImages();
        selectImage(0);

        click("scene-image-remove");
        await waitFor(() => expect(document.querySelectorAll(".scene-image-object")).toHaveLength(1));

        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-b"]);
        expect($("scene-image-toolbar").hidden).toBe(true);
        expect(listButton("Pair").textContent).toMatch(/1 image/);

        const patchCall = backend.calls.find((c) => c.method === "PATCH" && c.body && c.body.removeImageId);
        expect(patchCall.body.removeImageId).toBe("img-a");
        expect([...backend.scenes.values()][0].images.map((img) => img.id)).toEqual(["img-b"]);
    });

    it("restores the image and offers a retry if removal fails", async () => {
        await openSceneWithTwoImages();
        selectImage(0);
        backend.fail("PATCH", 500);

        click("scene-image-remove");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));

        expect(document.querySelectorAll(".scene-image-object")).toHaveLength(2);
        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-a", "img-b"]);

        click("scene-workspace-retry");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(true));
        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-b"]);
    });

    it("brings an image forward and sends it backward, persisting the new order", async () => {
        await openSceneWithTwoImages();
        selectImage(0);

        click("scene-image-forward");
        await waitFor(() =>
            expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-b", "img-a"])
        );
        let reorderCall = backend.calls.filter((c) => c.method === "PATCH" && c.body && c.body.reorderImageIds).pop();
        expect(reorderCall.body.reorderImageIds).toEqual(["img-b", "img-a"]);

        click("scene-image-backward");
        await waitFor(() =>
            expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-a", "img-b"])
        );
        reorderCall = backend.calls.filter((c) => c.method === "PATCH" && c.body && c.body.reorderImageIds).pop();
        expect(reorderCall.body.reorderImageIds).toEqual(["img-a", "img-b"]);
    });

    it("reverts the order and offers a retry if reordering fails", async () => {
        await openSceneWithTwoImages();
        selectImage(0);
        backend.fail("PATCH", 500);

        click("scene-image-forward");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-a", "img-b"]);

        click("scene-workspace-retry");
        await waitFor(() =>
            expect(scenesModule.getActiveScene().images.map((img) => img.id)).toEqual(["img-b", "img-a"])
        );
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
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].rotation).toBe(90));

        click("scene-image-rotate-left-15");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].rotation).toBe(75));

        click("scene-image-rotate-left-90");
        click("scene-image-rotate-left-90");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].rotation).toBe(255));

        const lastPatch = backend.calls.filter((c) => c.method === "PATCH" && c.body.updateImage).pop();
        expect(lastPatch.body.updateImage).toMatchObject({ id: "img-a", rotation: 255 });
    });

    it("toggles flipX and flipY independently and persists each", async () => {
        await openSceneWithOneImage();

        click("scene-image-flip-horizontal");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].flipX).toBe(true));
        expect(scenesModule.getActiveScene().images[0].flipY).toBeFalsy();

        click("scene-image-flip-vertical");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].flipY).toBe(true));

        click("scene-image-flip-horizontal");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].flipX).toBe(false));

        const patchCalls = backend.calls.filter((c) => c.method === "PATCH" && c.body.updateImage);
        expect(patchCalls.map((c) => c.body.updateImage)).toEqual([
            { id: "img-a", flipX: true },
            { id: "img-a", flipY: true },
            { id: "img-a", flipX: false },
        ]);
    });

    it("reverts a failed rotation and offers a retry", async () => {
        await openSceneWithOneImage();
        backend.fail("PATCH", 500);

        click("scene-image-rotate-right-90");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect(scenesModule.getActiveScene().images[0].rotation).toBeFalsy();

        click("scene-workspace-retry");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].rotation).toBe(90));
    });

    it("reverts a failed flip and offers a retry", async () => {
        await openSceneWithOneImage();
        backend.fail("PATCH", 500);

        click("scene-image-flip-horizontal");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect(scenesModule.getActiveScene().images[0].flipX).toBeFalsy();

        click("scene-workspace-retry");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].flipX).toBe(true));
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

    it("moves the selected image by the drag delta and persists the new position", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        const imageNode = document.querySelector("[data-scene-image-index=\"0\"]");

        drag(imageNode, { x: 0, y: 0 }, { x: 30, y: 20 });

        await waitFor(() => expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 130, y: 120 }));
        const patchCall = backend.calls.filter((c) => c.method === "PATCH" && c.body.updateImage).pop();
        expect(patchCall.body.updateImage).toMatchObject({ id: "img-a", x: 130, y: 120 });
    });

    it("does not move the image or fire a save for a mousedown/mouseup with no real movement", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        const imageNode = document.querySelector("[data-scene-image-index=\"0\"]");

        drag(imageNode, { x: 0, y: 0 }, { x: 0, y: 0 });

        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 100, y: 100 });
        expect(backend.calls.some((c) => c.method === "PATCH" && c.body.updateImage)).toBe(false);
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

        await waitFor(() => {
            const image = scenesModule.getActiveScene().images[0];
            expect(image.width).toBeCloseTo(240);
            expect(image.height).toBeCloseTo(120);
            expect(image.x).toBeCloseTo(80);
            expect(image.y).toBeCloseTo(90);
        });
    });

    it("reverts a failed move and offers a retry", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        backend.fail("PATCH", 500);
        const imageNode = document.querySelector("[data-scene-image-index=\"0\"]");

        drag(imageNode, { x: 0, y: 0 }, { x: 30, y: 20 });
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 100, y: 100 });

        click("scene-workspace-retry");
        await waitFor(() => expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 130, y: 120 }));
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

    it("drags the se handle to shrink the crop rect and persists it on release", async () => {
        await openSceneWithOneImage(); // 200x100
        mockSvgScale();
        click("scene-image-crop-start");
        const handle = document.querySelector("[data-corner=\"se\"]");

        drag(handle, { x: 0, y: 0 }, { x: -50, y: -20 });

        await waitFor(() => {
            const image = scenesModule.getActiveScene().images[0];
            expect(image).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 150, cropHeight: 80 });
        });
        const patchCall = backend.calls.filter((c) => c.method === "PATCH" && c.body.updateImage).pop();
        expect(patchCall.body.updateImage).toMatchObject({ id: "img-a", cropWidth: 150, cropHeight: 80 });
    });

    it("drags the nw handle, anchoring at the opposite corner of the crop rect", async () => {
        await openSceneWithOneImage(); // 200x100
        mockSvgScale();
        click("scene-image-crop-start");
        const handle = document.querySelector("[data-corner=\"nw\"]");

        drag(handle, { x: 0, y: 0 }, { x: 40, y: 20 });

        await waitFor(() => {
            const image = scenesModule.getActiveScene().images[0];
            expect(image).toMatchObject({ cropX: 40, cropY: 20, cropWidth: 160, cropHeight: 80 });
        });
    });

    it("resets the crop back to fully visible and persists it", async () => {
        await openSceneWithOneImage();
        mockSvgScale();
        click("scene-image-crop-start");
        drag(document.querySelector("[data-corner=\"se\"]"), { x: 0, y: 0 }, { x: -50, y: -20 });
        await waitFor(() => expect(scenesModule.getActiveScene().images[0].cropWidth).toBe(150));

        click("scene-image-crop-reset");

        await waitFor(() => {
            const image = scenesModule.getActiveScene().images[0];
            expect(image).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 200, cropHeight: 100 });
        });
    });

    it("exits crop mode without an extra save when nothing was dragged", async () => {
        await openSceneWithOneImage();
        click("scene-image-crop-start");
        const callsBefore = backend.calls.length;

        click("scene-image-crop-done");

        expect(backend.calls.length).toBe(callsBefore);
        expect($("scene-image-toolbar").hidden).toBe(false);
        expect(document.querySelectorAll(".scene-crop-outline")).toHaveLength(0);
    });
});
