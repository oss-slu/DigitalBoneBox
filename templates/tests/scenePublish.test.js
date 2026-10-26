// Draft and published scenes in the Scene Editor and bone viewer.
// Issues #458 (Define Draft Scenes) and #459 (Publish and Unpublish Scenes).
const fs = require("fs");
const path = require("path");

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "boneset.html"), "utf8");
const bodyHtml = pageHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, "");

// Small in-memory stand-in for /api/scenes with draft/published statuses.
function createFakeBackend() {
    const scenes = new Map();
    const calls = [];
    let counter = 0;
    let failNext = null;
    const respond = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(JSON.stringify(body)),
    });
    const statusOf = (s) => (s.status === "published" ? "published" : "draft");
    const summary = (s) => ({
        id: s.id, name: s.name, status: statusOf(s), publishedAt: s.publishedAt || null,
        imageCount: s.images.length, annotationCount: s.annotations.length,
        sources: s.sources || [], createdAt: s.createdAt, updatedAt: s.updatedAt,
    });

    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push({ method, url, body });
        if (failNext && failNext === method) {
            failNext = null;
            return respond(500, { error: "Server error" });
        }
        const [pathPart, query = ""] = url.split("?");
        const match = pathPart.match(/^\/api\/scenes\/?([^/]*)(?:\/(.+))?$/);
        if (!match) return respond(404, { error: "Not found" });
        const id = decodeURIComponent(match[1]) || null;
        const action = match[2] || null;
        const now = new Date(Date.UTC(2026, 9, 1, 0, 0, counter)).toISOString();

        if (!id && method === "GET") {
            const wanted = new URLSearchParams(query).get("status");
            const listed = [...scenes.values()].filter((s) => !wanted || statusOf(s) === wanted);
            return respond(200, { scenes: listed.map(summary) });
        }
        if (!id && method === "POST") {
            counter += 1;
            const scene = {
                id: `scene-${counter}`, name: body.name || `Untitled Scene ${counter}`, status: "draft",
                images: [], annotations: [], createdAt: now, updatedAt: now,
            };
            scenes.set(scene.id, scene);
            return respond(201, scene);
        }
        const scene = scenes.get(id);
        if (!scene) return respond(404, { error: "Scene not found" });
        if (action === "status" && method === "PATCH") {
            scene.status = body.status;
            if (body.status === "published") scene.publishedAt = now;
            else delete scene.publishedAt;
            return respond(200, summary(scene));
        }
        if (action) return respond(404, { error: "Not found" });
        if (method === "GET") return respond(200, scene);
        if (method === "PUT") {
            counter += 1;
            Object.assign(scene, { images: body.images, annotations: body.annotations, updatedAt: now });
            return respond(200, scene);
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
                id: `scene-${counter}`, images: [], annotations: [],
                createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...scene,
            };
            scenes.set(full.id, full);
            return full;
        },
        failNext(method) {
            failNext = method;
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
const listBadge = (name) => {
    const item = [...document.querySelectorAll(".scene-list-item")]
        .find((b) => b.querySelector(".scene-list-name").textContent === name);
    return item.querySelector(".scene-status-badge");
};
const statusCalls = () => backend.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/status"));

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

async function openNewScene() {
    await enterEditor();
    click("scene-new");
    await waitFor(() => expect($("scene-workspace-scene").hidden).toBe(false));
}

async function publish() {
    click("scene-publish");
    await waitFor(() => expect($("scene-status-badge").textContent).toBe("Published"));
}

function makeUnsavedChange() {
    scenesModule.updateActiveScene((scene) => {
        scene.annotations.push({ id: "note", type: "text", text: "New label", x: 10, y: 10 });
    });
}

describe("Scene editor: drafts (Issue 458)", () => {
    it("marks a new scene as a draft in the title and the scene list", async () => {
        await openNewScene();

        expect($("scene-status-badge").textContent).toBe("Draft");
        expect($("scene-status-badge").dataset.status).toBe("draft");
        expect($("scene-status-note").textContent).toMatch(/only visible in the scene editor/i);
        expect(listBadge("Untitled Scene 1").textContent).toBe("Draft");
        expect($("scene-publish").textContent).toBe("Publish");
        expect($("scene-publish").disabled).toBe(false);
    });

    it("shows a scene saved before statuses existed as a draft", async () => {
        backend.seed({ name: "Old Scene" }); // no status field
        await enterEditor();

        expect(listBadge("Old Scene").textContent).toBe("Draft");
    });

    it("shows which scenes in the list are published", async () => {
        backend.seed({ name: "Finished", status: "published" });
        backend.seed({ name: "In Progress", status: "draft" });
        await enterEditor();

        expect(listBadge("Finished").textContent).toBe("Published");
        expect(listBadge("Finished").dataset.status).toBe("published");
        expect(listBadge("In Progress").textContent).toBe("Draft");
    });
});

describe("Scene editor: publish and unpublish (Issue 459)", () => {
    it("publishes the open scene and updates the badge, note, list, and button", async () => {
        await openNewScene();

        await publish();

        expect(statusCalls()).toEqual([
            { method: "PATCH", url: "/api/scenes/scene-1/status", body: { status: "published" } },
        ]);
        expect($("scene-status-badge").dataset.status).toBe("published");
        expect($("scene-status-note").textContent).toMatch(/visible to everyone in the bone viewer/i);
        expect(listBadge("Untitled Scene 1").textContent).toBe("Published");
        expect($("scene-publish").textContent).toBe("Unpublish");
    });

    it("unpublishes a published scene, making it a draft again", async () => {
        await openNewScene();
        await publish();

        click("scene-publish");
        await waitFor(() => expect($("scene-status-badge").textContent).toBe("Draft"));

        expect(statusCalls()[1].body).toEqual({ status: "draft" });
        expect(listBadge("Untitled Scene 1").textContent).toBe("Draft");
        expect($("scene-publish").textContent).toBe("Publish");
    });

    it("doesn't mark the scene as having unsaved changes when publishing", async () => {
        await openNewScene();
        await publish();

        expect($("scene-save-status").textContent).toBe("Saved");
        expect($("scene-save").disabled).toBe(true);
    });

    it("asks the user to save before publishing, and allows it once saved", async () => {
        await openNewScene();
        makeUnsavedChange();

        expect($("scene-publish").disabled).toBe(true);
        expect($("scene-status-note").textContent).toBe("Save your changes before publishing.");

        click("scene-save");
        await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
        expect($("scene-publish").disabled).toBe(false);

        await publish();
        expect(statusCalls()).toHaveLength(1);
    });

    it("can unpublish while there are unsaved changes, and keeps those changes", async () => {
        await openNewScene();
        await publish();
        makeUnsavedChange();
        expect($("scene-publish").disabled).toBe(false); // taking a scene down is always allowed

        click("scene-publish");
        await waitFor(() => expect($("scene-status-badge").textContent).toBe("Draft"));

        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        expect(scenesModule.getActiveScene().annotations.map((a) => a.id)).toEqual(["note"]);
    });

    it("shows an error with a retry when publishing fails, and leaves the scene a draft", async () => {
        await openNewScene();
        backend.failNext("PATCH");

        click("scene-publish");
        await waitFor(() => expect($("scene-workspace-error").hidden).toBe(false));
        expect($("scene-workspace-error-text").textContent).toMatch(/something went wrong/i);
        expect($("scene-status-badge").textContent).toBe("Draft");

        click("scene-workspace-retry");
        await waitFor(() => expect($("scene-status-badge").textContent).toBe("Published"));
        expect($("scene-workspace-error").hidden).toBe(true);
    });

    it("keeps the status when the scene is closed and opened again", async () => {
        await openNewScene();
        await publish();
        click("scene-new");
        await waitFor(() => expect($("scene-title").textContent).toBe("Untitled Scene 2"));
        expect($("scene-status-badge").textContent).toBe("Draft");

        [...document.querySelectorAll(".scene-list-item")]
            .find((b) => b.querySelector(".scene-list-name").textContent === "Untitled Scene 1").click();
        await waitFor(() => expect($("scene-title").textContent).toBe("Untitled Scene 1"));
        expect($("scene-status-badge").textContent).toBe("Published");
    });
});

describe("Bone viewer shows only published scenes (Issues 458, 459)", () => {
    it("asks for published scenes only, so drafts never appear as viewer links", async () => {
        backend.seed({ name: "Published Ilium", status: "published", sources: ["ilium"] });
        backend.seed({ name: "Draft Ilium", status: "draft", sources: ["ilium"] });
        backend.seed({ name: "Published Ischium", status: "published", sources: ["ischium"] });
        const { fetchScenesForItem } = require("../js/sceneLinks.js");

        const scenes = await fetchScenesForItem("ilium");

        expect(backend.calls.at(-1).url).toBe("/api/scenes?status=published");
        expect(scenes.map((s) => s.name)).toEqual(["Published Ilium"]);
    });
});