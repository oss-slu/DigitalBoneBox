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
            const name = (body.name || "").trim();
            if (!name) return respond(400, { error: "Scene name cannot be empty" });
            if (nameTaken(name, id)) return respond(409, { error: "Name taken" });
            scene.name = name;
            scene.updatedAt = now;
            return respond(200, scene);
        }
        if (method === "PUT") {
            if (!Array.isArray(body.images) || !Array.isArray(body.annotations)) {
                return respond(400, { error: "images must be an array" });
            }
            scene.images = body.images;
            scene.annotations = body.annotations;
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

describe("Scene editor: saving (#452, #454)", () => {
    beforeEach(async () => {
        backend.seed({
            name: "Editable",
            images: [{ id: "i1", src: "/x.png", x: 0, y: 0, width: 10, height: 10, customField: "keep me" }],
        });
        await enterEditor();
        await openByName("Editable");
    });

    it("sends both arrays with unrecognized fields preserved", async () => {
        const scene = scenesModule.getActiveScene();
        scene.annotations.push({ id: "a1", type: "text", text: "New", x: 1, y: 1 });
        scenesModule.markSceneChanged();
        expect($("scene-save-status").textContent).toBe("Unsaved changes");

        click("scene-save");
        await waitFor(() => expect($("scene-save-status").textContent).toBe("All changes saved"));
        const put = backend.calls.find((c) => c.method === "PUT");
        expect(Object.keys(put.body).sort()).toEqual(["annotations", "images"]);
        expect(put.body.images[0].customField).toBe("keep me");
        expect(listButton("Editable").textContent).toMatch(/1 annotation/);
    });

    it("keeps the canvas and offers a retry when saving fails", async () => {
        const scene = scenesModule.getActiveScene();
        scene.annotations.push({ id: "a1", type: "text", text: "New", x: 1, y: 1 });
        scenesModule.markSceneChanged();
        const canvasBefore = $("scene-canvas").innerHTML;

        backend.fail("PUT", 500);
        click("scene-save");
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Save failed"));
        expect($("scene-save").textContent).toBe("Retry save");
        expect($("scene-canvas").innerHTML).toBe(canvasBefore);
        expect(scenesModule.getActiveScene().annotations).toHaveLength(1);

        click("scene-save");
        await waitFor(() => expect($("scene-save-status").textContent).toBe("All changes saved"));
    });
});

describe("describeError", () => {
    it("maps each status to a user-facing message", () => {
        const { describeError, SceneApiError } = scenesModule;
        expect(describeError(new SceneApiError(429, "x"), "open")).toMatch(/Too many requests/);
        expect(describeError(new SceneApiError(503, "x"), "save")).toMatch(/Scene storage is not configured/);
        expect(describeError(new SceneApiError(0, "x"), "load")).toMatch(/Couldn't reach the server/);
        expect(describeError(new SceneApiError(500, "x"), "save")).toMatch(/Try again/);
    });
});
