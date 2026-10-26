// Tests for adding and editing annotations in the Scene Editor (Issue #426:
// #427-#438). Each change edits the open working copy; Save stores it, and
// reopening the scene shows exactly what was saved.
const fs = require("fs");
const path = require("path");

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "boneset.html"), "utf8");
// The page's markup without its scripts. Parsed and stripped as a DOM rather
// than with a regex, which can't reliably remove every <script> (CodeQL
// js/incomplete-multi-character-sanitization).
const pageDocument = new DOMParser().parseFromString(pageHtml, "text/html");
pageDocument.querySelectorAll("script").forEach((script) => script.remove());
const bodyHtml = pageDocument.body.innerHTML;

const V0 = "2026-10-01T00:00:00.000Z";

// In-memory stand-in for the parts of /api/scenes these tests use.
function createFakeBackend() {
    const scenes = new Map();
    let version = 0;
    const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });

    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : undefined;
        const id = decodeURIComponent(url.match(/^\/api\/scenes\/?([^/]*)/)[1]) || null;
        if (!id) {
            return respond(200, {
                scenes: [...scenes.values()].map((s) => ({
                    id: s.id, name: s.name, imageCount: s.images.length, annotationCount: s.annotations.length, updatedAt: s.updatedAt,
                })),
            });
        }
        const scene = scenes.get(id);
        if (!scene) return respond(404, { error: "Scene not found" });
        if (method === "GET") return respond(200, scene);
        if (method === "PUT") {
            if (body.baseUpdatedAt && body.baseUpdatedAt !== scene.updatedAt) return respond(412, { error: "Changed", updatedAt: scene.updatedAt });
            scene.images = body.images;
            scene.annotations = body.annotations;
            scene.updatedAt = new Date(Date.parse(V0) + (version += 1) * 1000).toISOString();
            return respond(200, scene);
        }
        return respond(405, { error: "Method not allowed" });
    });

    return {
        fetch,
        scenes,
        seed(scene) {
            scenes.set(scene.id, { images: [], annotations: [], name: scene.id, updatedAt: V0, ...scene });
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
const canvasSvg = () => document.querySelector("#scene-canvas svg");
const annotations = () => scenesModule.getActiveScene().annotations;
const stored = () => backend.scenes.get("scene-1").annotations;
const annotationNode = (index) => document.querySelector(`#scene-canvas [data-scene-annotation-index="${index}"]`);

// jsdom gives the SVG no on-screen size, so the editor maps client
// coordinates 1:1 onto the scene's 960x600 viewBox.
function mouse(type, target, [x, y]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
}
// A full press, as a browser sends it: the click follows mousedown and mouseup.
function clickAt(target, point) {
    mouse("mousedown", target, point);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: point[0], clientY: point[1] }));
    mouse("click", target, point);
}
function drag(target, from, to) {
    mouse("mousedown", target, from);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: to[0], clientY: to[1] }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: to[0], clientY: to[1] }));
}
function key(name, options = {}) {
    $("scene-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...options }));
}
function selectAnnotation(index) {
    clickAt(annotationNode(index), [0, 0]);
}
function typeText(text) {
    $("scene-annotation-text").focus();
    $("scene-annotation-text").value = text;
    $("scene-annotation-text").dispatchEvent(new Event("input", { bubbles: true }));
}
function setField(id, value, eventType) {
    $(id).value = String(value);
    $(id).dispatchEvent(new Event(eventType, { bubbles: true }));
}

let backend;
let scenesModule;

function startEditor() {
    document.body.innerHTML = bodyHtml;
    global.fetch = backend.fetch;
    jest.resetModules();
    scenesModule = require("../js/scenes.js");
    scenesModule.initializeSceneEditor();
}

async function openScene() {
    click("text-button-SceneEditor");
    await waitFor(() => expect(document.querySelector(".scene-list-item")).not.toBeNull());
    [...document.querySelectorAll(".scene-list-item")].find((b) => b.textContent.includes("Plate")).click();
    await waitFor(() => expect($("scene-title").textContent).toBe("Plate"));
}

async function saveAndWait() {
    click("scene-save");
    await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
}

/** Saves, then loads the scene again in a fresh editor, as reopening the page would. */
async function saveAndReopen() {
    await saveAndWait();
    startEditor();
    await openScene();
}

beforeEach(() => {
    backend = createFakeBackend();
    if (!global.crypto) global.crypto = {};
    let uuid = 0;
    jest.spyOn(global.crypto, "randomUUID").mockImplementation(() => `uuid-${(uuid += 1)}`);
});

afterEach(() => {
    jest.restoreAllMocks();
});

async function openBlankScene(content = {}) {
    backend.seed({ id: "scene-1", name: "Plate", ...content });
    startEditor();
    await openScene();
}

async function addLabel(point, text) {
    click("scene-tool-text");
    clickAt(canvasSvg(), point);
    if (text !== undefined) typeText(text);
}

describe("Text labels (#427-#430)", () => {
    it("draws a blank scene's canvas while a tool is in use, so a label can be placed on it", async () => {
        await openBlankScene();
        expect($("scene-canvas").hidden).toBe(true);

        click("scene-tool-text");

        expect($("scene-canvas").hidden).toBe(false);
        expect($("scene-tool-text").getAttribute("aria-pressed")).toBe("true");
        expect($("scene-tool-hint").textContent).toMatch(/Click the canvas/);
        key("Escape");
        expect($("scene-tool-text").getAttribute("aria-pressed")).toBe("false");
        expect($("scene-canvas").hidden).toBe(true);
    });

    it("places a selectable label at the click and keeps short, long, and multi-line text after reopening (#427)", async () => {
        await openBlankScene();
        await addLabel([100, 120]);

        expect(annotations()).toEqual([expect.objectContaining({ type: "text", text: "New label", x: 100, y: 120 })]);
        expect($("scene-annotation-toolbar").hidden).toBe(false);
        expect($("scene-annotation-label").textContent).toBe("Selected label:");
        expect(document.activeElement).toBe($("scene-annotation-text"));
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);

        typeText("Ilium");
        await addLabel([100, 200], "Anterior superior iliac spine of the ilium");
        await addLabel([100, 300], "Iliac\ncrest");
        // Labels are scene objects, never painted into an image.
        expect(backend.scenes.get("scene-1").images).toEqual([]);

        await saveAndReopen();

        expect(stored().map((a) => a.text)).toEqual(["Ilium", "Anterior superior iliac spine of the ilium", "Iliac\ncrest"]);
        expect(canvasSvg().querySelector(".scene-layer-annotations text").textContent).toBe("Ilium");
        expect([...annotationNode(2).querySelectorAll("tspan")].map((t) => t.textContent)).toEqual(["Iliac", "crest"]);
        selectAnnotation(0);
        expect($("scene-annotation-text").value).toBe("Ilium");
    });

    it("edits a label several times and keeps the last text (#428)", async () => {
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10 }] });
        selectAnnotation(0);

        typeText("Ilum");
        typeText("Ischium");
        expect(annotationNode(0).textContent).toBe("Ischium");
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        await saveAndReopen();
        expect(stored()[0].text).toBe("Ischium");

        selectAnnotation(0);
        typeText("Pubis");
        await saveAndReopen();
        expect(stored()[0].text).toBe("Pubis");
    });

    it("explains an empty label and keeps the last text instead of storing an empty one (#428)", async () => {
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10 }] });
        selectAnnotation(0);

        typeText("   ");

        expect($("scene-annotation-text-error").hidden).toBe(false);
        expect($("scene-annotation-text-error").textContent).toMatch(/needs some text/);
        expect($("scene-annotation-text").getAttribute("aria-invalid")).toBe("true");
        expect(annotations()[0].text).toBe("Ilium");
        expect(scenesModule.hasUnsavedChanges()).toBe(false);

        $("scene-annotation-text").dispatchEvent(new Event("blur"));
        expect($("scene-annotation-text").value).toBe("Ilium");
        expect($("scene-annotation-text-error").hidden).toBe(true);
    });

    it("opens a label's text for editing on double-click", async () => {
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10 }] });
        mouse("dblclick", annotationNode(0), [0, 0]);
        expect(document.activeElement).toBe($("scene-annotation-text"));
        expect($("scene-annotation-toolbar").hidden).toBe(false);
    });

    it("moves and resizes a label near the edge and keeps the change (#429)", async () => {
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10, fontSize: 20 }] });
        selectAnnotation(0);

        drag(annotationNode(0), [15, 15], [5, 595]);
        expect(annotations()[0]).toMatchObject({ x: 0, y: 590 });
        // The click a browser sends after the drag's mouseup doesn't deselect the label.
        mouse("click", annotationNode(0), [5, 595]);
        expect($("scene-annotation-toolbar").hidden).toBe(false);

        // The label is 60 wide at 20px; dragging its corner 60 to the right doubles it.
        drag(document.querySelector("[data-annotation-handle=\"resize\"]"), [63, 613], [123, 613]);
        expect(annotations()[0]).toMatchObject({ x: 0, y: 590, fontSize: 40 });
        expect($("scene-annotation-size").value).toBe("40");

        setField("scene-annotation-size", 2, "change");
        expect(annotations()[0].fontSize).toBe(8);

        setField("scene-annotation-size", 24, "change");
        await saveAndReopen();
        expect(stored()[0]).toMatchObject({ x: 0, y: 590, fontSize: 24 });
    });

    it("nudges the selected label with the arrow keys", async () => {
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10 }] });
        selectAnnotation(0);
        key("ArrowRight");
        key("ArrowDown", { shiftKey: true });
        expect(annotations()[0]).toMatchObject({ x: 11, y: 20 });
    });

    it("deletes one label from several and leaves the others (#430)", async () => {
        await openBlankScene({
            annotations: [
                { id: "a", type: "text", text: "Ilium", x: 10, y: 10 },
                { id: "b", type: "text", text: "Ischium", x: 10, y: 40 },
                { id: "c", type: "text", text: "Pubis", x: 10, y: 70 },
            ],
        });
        backend.seed({ id: "scene-2", name: "Other", annotations: [{ id: "b", type: "text", text: "Ischium", x: 0, y: 0 }] });
        selectAnnotation(1);

        click("scene-annotation-delete");

        expect(annotations().map((a) => a.id)).toEqual(["a", "c"]);
        expect($("scene-annotation-toolbar").hidden).toBe(true);
        await saveAndReopen();
        expect(stored()).toEqual([
            { id: "a", type: "text", text: "Ilium", x: 10, y: 10 },
            { id: "c", type: "text", text: "Pubis", x: 10, y: 70 },
        ]);
        expect(backend.scenes.get("scene-2").annotations).toHaveLength(1);
    });

    it("deletes the selected label with the Delete key", async () => {
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 10, y: 10 }] });
        selectAnnotation(0);
        key("Delete");
        expect(annotations()).toEqual([]);
    });
});

describe("Lines, pointer lines, and arrows (#431-#433)", () => {
    it("draws a line by dragging and keeps lines at different lengths and angles (#431)", async () => {
        await openBlankScene();

        click("scene-tool-line");
        drag(canvasSvg(), [100, 100], [300, 100]);
        click("scene-tool-line");
        drag(canvasSvg(), [50, 400], [80, 350]);

        expect(annotations()).toEqual([
            expect.objectContaining({ type: "line", x1: 100, y1: 100, x2: 300, y2: 100 }),
            expect.objectContaining({ type: "line", x1: 50, y1: 400, x2: 80, y2: 350 }),
        ]);
        expect($("scene-annotation-label").textContent).toBe("Selected line:");
        expect(document.querySelectorAll("[data-annotation-handle=\"point\"]")).toHaveLength(2);
        await saveAndReopen();
        expect(stored()).toHaveLength(2);
        expect(canvasSvg().querySelectorAll(".scene-layer-annotations polyline")).toHaveLength(2);
    });

    it("ignores a click with the line tool instead of adding a zero-length line", async () => {
        await openBlankScene();
        click("scene-tool-line");
        drag(canvasSvg(), [100, 100], [101, 100]);
        expect(annotations()).toEqual([]);
        expect($("scene-tool-line").getAttribute("aria-pressed")).toBe("true");
    });

    // An exception thrown inside an event listener doesn't reach dispatchEvent's
    // caller; jsdom reports it as an "error" event on the window instead.
    function collectListenerErrors() {
        const errors = [];
        const onError = (event) => {
            errors.push(event.error);
            event.preventDefault();
        };
        window.addEventListener("error", onError);
        return { errors, stop: () => window.removeEventListener("error", onError) };
    }

    it("cancels a line drag with Escape, leaving no listener behind and adding nothing", async () => {
        await openBlankScene();
        const listenerErrors = collectListenerErrors();

        click("scene-tool-line");
        mouse("mousedown", canvasSvg(), [100, 100]);
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 150 }));
        key("Escape");
        // The button is still held: the drag goes on after Escape.
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 200 }));
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: 300, clientY: 200 }));
        // The click a browser sends after that mouseup. The blank scene's canvas
        // is gone once the tool is cancelled, so it lands on the canvas region.
        mouse("click", $("scene-canvas"), [300, 200]);
        listenerErrors.stop();

        expect(listenerErrors.errors).toEqual([]);
        expect(annotations()).toEqual([]);
        expect(document.querySelector(".scene-draft")).toBeNull();
        expect($("scene-tool-line").getAttribute("aria-pressed")).toBe("false");
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("switches tools during a line drag without finishing the line, and the new tool still draws", async () => {
        await openBlankScene();
        const listenerErrors = collectListenerErrors();

        click("scene-tool-line");
        mouse("mousedown", canvasSvg(), [100, 100]);
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 150 }));
        click("scene-tool-arrow");
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300, clientY: 200 }));
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: 300, clientY: 200 }));

        expect(listenerErrors.errors).toEqual([]);
        expect(annotations()).toEqual([]);
        expect($("scene-tool-arrow").getAttribute("aria-pressed")).toBe("true");

        drag(canvasSvg(), [400, 100], [500, 100]);
        listenerErrors.stop();
        expect(listenerErrors.errors).toEqual([]);
        expect(annotations()).toEqual([expect.objectContaining({ type: "arrow", x1: 400, y1: 100, x2: 500, y2: 100 })]);
    });

    it("moves a line's endpoints and the whole line, then deletes it (#431)", async () => {
        await openBlankScene({ annotations: [{ id: "l", type: "line", x1: 100, y1: 100, x2: 300, y2: 100 }] });
        selectAnnotation(0);

        drag(document.querySelector("[data-point-index=\"1\"]"), [300, 100], [300, 250]);
        expect(annotations()[0]).toMatchObject({ x1: 100, y1: 100, x2: 300, y2: 250 });
        drag(annotationNode(0), [200, 175], [210, 185]);
        expect(annotations()[0]).toMatchObject({ x1: 110, y1: 110, x2: 310, y2: 260 });
        setField("scene-annotation-width", 50, "change");
        expect(annotations()[0].strokeWidth).toBe(20);
        await saveAndReopen();
        expect(stored()[0]).toMatchObject({ x1: 110, y1: 110, x2: 310, y2: 260, strokeWidth: 20 });

        selectAnnotation(0);
        click("scene-annotation-delete");
        await saveAndReopen();
        expect(stored()).toEqual([]);
    });

    it("connects a pointer line to a label, keeps them together when the label moves, and after reopening (#432)", async () => {
        await openBlankScene({ annotations: [{ id: "label", type: "text", text: "Ilium", x: 100, y: 100, fontSize: 20 }] });
        selectAnnotation(0);

        click("scene-annotation-pointer");
        expect($("scene-tool-hint").textContent).toMatch(/feature the label points to/);
        clickAt(canvasSvg(), [400, 110]);

        // It starts on the label's right edge (the label is 60 x 20).
        expect(annotations()[1]).toMatchObject({ type: "line", labelId: "label", x1: 160, y1: 110, x2: 400, y2: 110 });
        expect($("scene-annotation-label").textContent).toBe("Selected pointer line:");

        drag(document.querySelector("[data-point-index=\"1\"]"), [400, 110], [420, 200]);
        expect(annotations()[1]).toMatchObject({ x1: 160, y1: 110, x2: 420, y2: 200 });

        selectAnnotation(0);
        drag(annotationNode(0), [110, 105], [140, 125]);
        // The label end moves with the label; the pointed-at end stays.
        expect(annotations()[1]).toMatchObject({ x1: 190, y1: 130, x2: 420, y2: 200 });

        await saveAndReopen();
        expect(stored()[1]).toMatchObject({ labelId: "label", x1: 190, y1: 130, x2: 420, y2: 200 });
        selectAnnotation(0);
        key("ArrowLeft", { shiftKey: true });
        expect(annotations()[1]).toMatchObject({ x1: 180, y1: 130, x2: 420, y2: 200 });
    });

    it("keeps a pointer line on its label's edge when the label grows, and deletes it with the label (#432)", async () => {
        await openBlankScene({
            annotations: [
                { id: "label", type: "text", text: "Ilium", x: 100, y: 100, fontSize: 20 },
                { id: "p", type: "line", labelId: "label", x1: 160, y1: 110, x2: 400, y2: 110 },
                { id: "other", type: "line", x1: 0, y1: 0, x2: 50, y2: 50 },
            ],
        });
        selectAnnotation(0);

        setField("scene-annotation-size", 40, "change");
        // The label is now 120 x 40, so its right edge is at x = 220.
        expect(annotations()[1]).toMatchObject({ x1: 220, y1: 110, x2: 400, y2: 110 });

        click("scene-annotation-delete");
        expect(annotations().map((a) => a.id)).toEqual(["other"]);
    });

    it("moves an imported label's imported pointer lines with it", async () => {
        const source = { boneId: "ilium", annotationId: "a1" };
        await openBlankScene({
            annotations: [
                { id: "label", type: "text", text: "Ilium", x: 100, y: 100, fontSize: 20, source: { type: "legacy-label", ...source } },
                { id: "p", type: "arrow", x1: 400, y1: 300, x2: 150, y2: 115, source: { type: "legacy-pointer-line", ...source } },
            ],
        });
        selectAnnotation(0);
        drag(annotationNode(0), [110, 105], [120, 105]);
        expect(annotations()[1]).toMatchObject({ x1: 400, y1: 300, x2: 160, y2: 115 });
    });

    it("draws arrows pointing in different directions with a clear head, and keeps them (#433)", async () => {
        await openBlankScene();
        for (const [from, to] of [[[100, 100], [300, 100]], [[300, 300], [100, 300]], [[500, 100], [500, 400]]]) {
            click("scene-tool-arrow");
            drag(canvasSvg(), from, to);
        }

        expect(annotations().map((a) => [a.type, a.x1, a.y1, a.x2, a.y2])).toEqual([
            ["arrow", 100, 100, 300, 100],
            ["arrow", 300, 300, 100, 300],
            ["arrow", 500, 100, 500, 400],
        ]);
        expect($("scene-annotation-label").textContent).toBe("Selected arrow:");
        const polylines = canvasSvg().querySelectorAll(".scene-layer-annotations polyline");
        expect([...polylines].every((line) => /url\(#scene-arrowhead-/.test(line.getAttribute("marker-end")))).toBe(true);

        drag(document.querySelector("[data-point-index=\"0\"]"), [500, 100], [450, 100]);
        expect(annotations()[2]).toMatchObject({ x1: 450, y1: 100, x2: 500, y2: 400 });
        await saveAndReopen();
        expect(stored()[2]).toMatchObject({ type: "arrow", x1: 450, y1: 100, x2: 500, y2: 400 });
        selectAnnotation(1);
        click("scene-annotation-delete");
        await saveAndReopen();
        expect(stored()).toHaveLength(2);
    });
});

describe("Highlight polygons (#434-#437)", () => {
    function drawPolygon(points, finish = () => click("scene-polygon-finish")) {
        click("scene-tool-polygon");
        for (const point of points) clickAt(canvasSvg(), point);
        finish();
    }

    it("places corners one by one and finishes only when asked, with a transparent fill (#434)", async () => {
        await openBlankScene();
        click("scene-tool-polygon");
        expect($("scene-polygon-finish").hidden).toBe(false);
        clickAt(canvasSvg(), [100, 100]);
        clickAt(canvasSvg(), [200, 100]);
        expect($("scene-polygon-finish").disabled).toBe(true);
        key("Enter");
        expect(annotations()).toEqual([]);

        clickAt(canvasSvg(), [150, 200]);
        expect(document.querySelectorAll(".scene-draft-point")).toHaveLength(3);
        expect($("scene-polygon-finish").disabled).toBe(false);
        click("scene-polygon-finish");

        expect(annotations()).toEqual([expect.objectContaining({
            type: "polygon", points: [[100, 100], [200, 100], [150, 200]], fillOpacity: 0.35,
        })]);
        const polygon = canvasSvg().querySelector(".scene-layer-annotations polygon");
        expect(Number(polygon.getAttribute("fill-opacity"))).toBeLessThan(1);
        expect($("scene-annotation-label").textContent).toBe("Selected highlight:");
    });

    it("creates triangles, quadrilaterals, and irregular shapes, finished by button, Enter, or the first corner (#434)", async () => {
        await openBlankScene();
        drawPolygon([[0, 0], [100, 0], [50, 80]]);
        drawPolygon([[200, 0], [300, 0], [300, 100], [200, 100]], () => key("Enter"));
        drawPolygon([[400, 0], [480, 20], [520, 90], [470, 160], [420, 120]], () => clickAt(document.querySelector("[data-draft-start]"), [400, 0]));

        expect(annotations().map((a) => a.points.length)).toEqual([3, 4, 5]);
        await saveAndReopen();
        expect(stored().map((a) => a.points.length)).toEqual([3, 4, 5]);
        expect(canvasSvg().querySelectorAll(".scene-layer-annotations polygon")).toHaveLength(3);
    });

    it("ignores the repeated click of a double-click and finishes on it", async () => {
        await openBlankScene();
        click("scene-tool-polygon");
        clickAt(canvasSvg(), [0, 0]);
        clickAt(canvasSvg(), [100, 0]);
        clickAt(canvasSvg(), [50, 80]);
        clickAt(canvasSvg(), [50, 80]);
        mouse("dblclick", canvasSvg(), [50, 80]);
        expect(annotations()[0].points).toEqual([[0, 0], [100, 0], [50, 80]]);
    });

    it("removes the last corner with Backspace and cancels with Escape", async () => {
        await openBlankScene();
        click("scene-tool-polygon");
        clickAt(canvasSvg(), [0, 0]);
        clickAt(canvasSvg(), [100, 0]);
        key("Backspace");
        expect(document.querySelectorAll(".scene-draft-point")).toHaveLength(1);
        key("Escape");
        expect(document.querySelectorAll(".scene-draft-point")).toHaveLength(0);
        expect(annotations()).toEqual([]);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("moves corners and the whole polygon and keeps the shape (#435)", async () => {
        await openBlankScene({ annotations: [{ id: "p", type: "polygon", points: [[100, 100], [200, 100], [200, 200], [100, 200]] }] });
        selectAnnotation(0);
        expect(document.querySelectorAll("[data-annotation-handle=\"point\"]")).toHaveLength(4);

        drag(document.querySelector("[data-point-index=\"2\"]"), [200, 200], [260, 240]);
        drag(annotationNode(0), [150, 150], [160, 140]);

        expect(annotations()[0].points).toEqual([[110, 90], [210, 90], [270, 230], [110, 190]]);
        await saveAndReopen();
        expect(stored()[0].points).toEqual([[110, 90], [210, 90], [270, 230], [110, 190]]);
    });

    it("edits an imported region in its own point format", async () => {
        await openBlankScene({
            annotations: [{ id: "r", type: "polygon", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }], fill: "#00ff00", opacity: 0.4 }],
        });
        selectAnnotation(0);
        drag(document.querySelector("[data-point-index=\"1\"]"), [40, 0], [60, 10]);
        expect(annotations()[0].points).toEqual([{ x: 0, y: 0 }, { x: 60, y: 10 }, { x: 0, y: 40 }]);
        expect($("scene-annotation-opacity").value).toBe("0.4");
    });

    it("changes a highlight's color and opacity, visible before saving and kept after (#436)", async () => {
        await openBlankScene({
            annotations: [{ id: "p", type: "polygon", points: [[0, 0], [100, 0], [0, 100]], fill: "#ffd700", fillOpacity: 0.35 }],
        });
        selectAnnotation(0);
        expect($("scene-annotation-opacity-field").hidden).toBe(false);
        expect($("scene-annotation-size-field").hidden).toBe(true);

        setField("scene-annotation-color", "#3366ff", "input");
        setField("scene-annotation-opacity", "0.6", "input");

        const polygon = canvasSvg().querySelector(".scene-layer-annotations polygon");
        expect(polygon.getAttribute("fill")).toBe("#3366ff");
        expect(polygon.getAttribute("fill-opacity")).toBe("0.6");
        await saveAndReopen();
        expect(stored()[0]).toMatchObject({ fill: "#3366ff", stroke: "#3366ff", fillOpacity: 0.6 });
        selectAnnotation(0);
        expect($("scene-annotation-color").value).toBe("#3366ff");
        expect($("scene-annotation-opacity").value).toBe("0.6");
    });

    it("never makes a highlight fully opaque, and replaces an imported region's whole-shape opacity (#436)", async () => {
        await openBlankScene({ annotations: [{ id: "r", type: "polygon", points: [[0, 0], [10, 0], [0, 10]], fill: "#00ff00", opacity: 0.4 }] });
        selectAnnotation(0);
        setField("scene-annotation-opacity", "1", "input");
        expect(annotations()[0].fillOpacity).toBe(0.8);
        expect(annotations()[0].opacity).toBeUndefined();
    });

    it("colors labels and lines too", async () => {
        await openBlankScene({
            annotations: [
                { id: "a", type: "text", text: "Ilium", x: 0, y: 0 },
                { id: "l", type: "arrow", x1: 0, y1: 50, x2: 100, y2: 50 },
            ],
        });
        selectAnnotation(0);
        setField("scene-annotation-color", "#aa0000", "input");
        selectAnnotation(1);
        setField("scene-annotation-color", "#00aa00", "input");
        expect(annotations()[0].color).toBe("#aa0000");
        expect(annotations()[1].stroke).toBe("#00aa00");
    });

    it("deletes one polygon from a scene with several polygons and annotations (#437)", async () => {
        const square = (id, x) => ({ id, type: "polygon", points: [[x, 0], [x + 50, 0], [x + 50, 50], [x, 50]] });
        await openBlankScene({
            annotations: [square("p1", 0), { id: "t", type: "text", text: "Ilium", x: 0, y: 100 }, square("p2", 100), square("p3", 200)],
        });
        selectAnnotation(2);
        click("scene-annotation-delete");
        expect(annotations().map((a) => a.id)).toEqual(["p1", "t", "p3"]);
        await saveAndReopen();
        expect(stored().map((a) => a.id)).toEqual(["p1", "t", "p3"]);
    });
});

describe("Annotation layers (#438)", () => {
    const overlapping = [
        { id: "poly", type: "polygon", points: [[0, 0], [200, 0], [200, 200], [0, 200]] },
        { id: "line", type: "line", x1: 0, y1: 100, x2: 200, y2: 100 },
        { id: "text", type: "text", text: "Ilium", x: 50, y: 90 },
    ];
    const images = [
        { id: "img-a", src: "/images/a.png", x: 0, y: 0, width: 100, height: 100 },
        { id: "img-b", src: "/images/b.png", x: 50, y: 50, width: 100, height: 100 },
    ];
    const drawnOrder = () => [...canvasSvg().querySelectorAll(".scene-layer-annotations > :not(.scene-annotation-hit)")]
        .map((node) => annotations()[Number(node.dataset.sceneAnnotationIndex)].id);

    it("changes which overlapping annotation is on top, right away, without touching image order", async () => {
        await openBlankScene({ images: images.map((image) => ({ ...image })), annotations: overlapping.map((a) => ({ ...a })) });
        selectAnnotation(0);
        expect($("scene-annotation-back").disabled).toBe(true);
        expect($("scene-annotation-backward").disabled).toBe(true);

        click("scene-annotation-forward");
        expect(drawnOrder()).toEqual(["line", "poly", "text"]);
        click("scene-annotation-front");
        expect(drawnOrder()).toEqual(["line", "text", "poly"]);
        expect($("scene-annotation-front").disabled).toBe(true);
        expect($("scene-annotation-toolbar").hidden).toBe(false);

        selectAnnotation(1);
        click("scene-annotation-back");
        expect(drawnOrder()).toEqual(["text", "line", "poly"]);
        click("scene-annotation-forward");
        expect(drawnOrder()).toEqual(["line", "text", "poly"]);
        expect(scenesModule.getActiveScene().images.map((image) => image.id)).toEqual(["img-a", "img-b"]);

        await saveAndReopen();
        expect(stored().map((a) => a.id)).toEqual(["line", "text", "poly"]);
        expect(drawnOrder()).toEqual(["line", "text", "poly"]);
        expect(backend.scenes.get("scene-1").images.map((image) => image.id)).toEqual(["img-a", "img-b"]);
    });
});

describe("Annotations linked to an image", () => {
    it("stores a moved imported label relative to its image, so it still follows the image", async () => {
        const image = { id: "img", src: "/images/a.png", x: 0, y: 0, width: 200, height: 100 };
        await openBlankScene({
            images: [image],
            annotations: [{
                id: "a", type: "text", text: "Ilium", x: 20, y: 20, fontSize: 10,
                sourceImageId: "img", sourceImageFrame: { x: 0, y: 0, width: 100, height: 50 },
            }],
        });
        // The image is twice its imported size, so the label is drawn at (40, 40), 20px tall.
        selectAnnotation(0);
        drag(annotationNode(0), [50, 50], [70, 60]);

        expect(annotations()[0]).toMatchObject({ x: 30, y: 25, fontSize: 10, sourceImageFrame: { x: 0, y: 0, width: 100, height: 50 } });
        const text = canvasSvg().querySelector(".scene-layer-annotations text");
        expect(Number(text.getAttribute("x"))).toBeCloseTo(60);
        expect(Number(text.getAttribute("y"))).toBeCloseTo(50);
    });
});

describe("Annotation selection", () => {
    it("selects either an image or an annotation, never both", async () => {
        await openBlankScene({
            images: [{ id: "img", src: "/images/a.png", x: 300, y: 300, width: 100, height: 100 }],
            annotations: [{ id: "a", type: "text", text: "Ilium", x: 0, y: 0 }],
        });
        selectAnnotation(0);
        clickAt(document.querySelector("[data-scene-image-index=\"0\"]"), [350, 350]);
        expect($("scene-image-toolbar").hidden).toBe(false);
        expect($("scene-annotation-toolbar").hidden).toBe(true);

        selectAnnotation(0);
        expect($("scene-image-toolbar").hidden).toBe(true);
        expect($("scene-annotation-toolbar").hidden).toBe(false);

        clickAt(canvasSvg(), [900, 500]);
        expect($("scene-annotation-toolbar").hidden).toBe(true);
    });

    it("clears the selection and tool when another scene is opened", async () => {
        backend.seed({ id: "scene-2", name: "Another", annotations: [] });
        await openBlankScene({ annotations: [{ id: "a", type: "text", text: "Ilium", x: 0, y: 0 }] });
        selectAnnotation(0);
        [...document.querySelectorAll(".scene-list-item")].find((b) => b.textContent.includes("Another")).click();
        await waitFor(() => expect($("scene-title").textContent).toBe("Another"));
        expect($("scene-annotation-toolbar").hidden).toBe(true);
        expect($("scene-canvas-empty").hidden).toBe(false);
    });
});
