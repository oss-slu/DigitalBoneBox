// Tests for the Scene Editor's "Import bone images" control. Issue #466 (parent #463).
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
    { id: "a", src: "/api/images/ilium_image1.jpg", x: 0, y: 0, width: 235, height: 371, rotation: 0 },
    { id: "b", src: "/api/images/ilium_image2.jpg", x: 275, y: 0, width: 268, height: 360, rotation: 0 },
];

// In-memory stand-in for the scenes API, /combined-data, and the import route.
function createFakeBackend() {
    const scene = {
        id: "scene-1",
        name: "Pelvis Study",
        images: [],
        annotations: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const calls = [];
    const respond = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(JSON.stringify(body)),
    });

    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ method, url, body });

        if (url === "/combined-data") return respond(200, COMBINED_DATA);
        if (url.startsWith("/api/bone-data/")) {
            const boneId = new URLSearchParams(url.split("?")[1]).get("boneId");
            const images = boneId === "ilium"
                ? ILIUM_IMAGES.map((image) => ({ filename: image.src.split("/").pop(), url: image.src }))
                : [];
            return respond(200, { id: boneId, name: boneId, description: [], images });
        }
        if (url === "/api/scenes" && method === "GET") {
            return respond(200, {
                scenes: [{
                    id: scene.id,
                    name: scene.name,
                    imageCount: scene.images.length,
                    annotationCount: 0,
                    updatedAt: scene.updatedAt,
                }],
            });
        }
        if (url === "/api/scenes/scene-1" && method === "GET") return respond(200, scene);
        if (url === "/api/scenes/scene-1/import-legacy" && method === "POST") {
            const chosen = ILIUM_IMAGES.filter((image) => body.filenames.includes(image.src.split("/").pop()));
            scene.images.push(...chosen);
            return respond(200, {
                scene,
                imported: { boneId: body.boneId, name: "Ilium", count: chosen.length },
                warnings: [],
            });
        }
        return respond(404, { error: "Not found" });
    });

    return { fetch, calls, scene };
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

let backend;

beforeEach(async () => {
    document.body.innerHTML = bodyHtml;
    backend = createFakeBackend();
    global.fetch = backend.fetch;
    jest.resetModules();
    require("../js/scenes.js").initializeSceneEditor();

    // Enter the editor and open the scene.
    $("text-button-SceneEditor").click();
    await waitFor(() => expect(document.querySelector(".scene-list-item")).not.toBeNull());
    document.querySelector(".scene-list-item").click();
    await waitFor(() => expect($("scene-title").textContent).toBe("Pelvis Study"));
});

async function openImportForm() {
    $("scene-import-toggle").click();
    await waitFor(() => expect($("scene-import-select").disabled).toBe(false));
}

async function chooseBone(boneId) {
    $("scene-import-select").value = boneId;
    $("scene-import-select").dispatchEvent(new Event("change"));
}

const imageChoices = () => [...$("scene-import-image-list").querySelectorAll("input[type=checkbox]")];

describe("Scene editor: import bone images - Issue 466", () => {
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
        await openImportForm();
        await chooseBone("ilium");
        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        $("scene-import-form").requestSubmit();

        await waitFor(() => expect($("scene-canvas").querySelectorAll("image")).toHaveLength(2));
        expect($("scene-meta").textContent).toBe("2 images · 0 annotations");
        expect($("scene-import-form").hidden).toBe(true);
        expect(backend.calls).toContainEqual({
            method: "POST",
            url: "/api/scenes/scene-1/import-legacy",
            body: { boneId: "ilium", filenames: ["ilium_image1.jpg", "ilium_image2.jpg"] },
        });
        await waitFor(() => expect($("scene-editor-status").textContent).toBe("Imported 2 images from Ilium."));
    });

    it("imports only the selected image", async () => {
        await openImportForm();
        await chooseBone("ilium");
        await waitFor(() => expect(imageChoices()).toHaveLength(2));
        imageChoices()[0].checked = false;
        $("scene-import-form").requestSubmit();

        await waitFor(() => expect($("scene-canvas").querySelectorAll("image")).toHaveLength(1));
        expect(backend.calls.find((call) => call.url.endsWith("/import-legacy")).body)
            .toEqual({ boneId: "ilium", filenames: ["ilium_image2.jpg"] });
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

        expect(backend.calls.some((call) => call.url.endsWith("/import-legacy"))).toBe(false);
    });
});