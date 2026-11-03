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
/** A point on a drawn annotation, where a user would click it. */
function pointOn(node) {
    if (node.tagName === "text") return [Number(node.getAttribute("x")) + 1, Number(node.getAttribute("y")) + 1];
    const points = (node.getAttribute("points") || "").trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
    if (node.tagName === "polygon") {
        return [0, 1].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
    }
    return [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
}
function selectAnnotation(index) {
    const node = annotationNode(index);
    clickAt(node, pointOn(node));
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
        // A browser sends both clicks before the dblclick.
        clickAt(annotationNode(0), [12, 12]);
        clickAt(annotationNode(0), [12, 12]);
        mouse("dblclick", annotationNode(0), [12, 12]);
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

describe("Selecting objects (#440)", () => {
    // One of each object type. Annotations are drawn over images, and later
    // ones over earlier ones, so from the top down: highlight, arrow, line,
    // label, image.
    const content = {
        images: [{ id: "img", src: "/images/a.png", x: 300, y: 300, width: 100, height: 100 }],
        annotations: [
            { id: "label", type: "text", text: "Ilium", x: 0, y: 0 },
            { id: "line", type: "line", x1: 10, y1: 400, x2: 200, y2: 400 },
            { id: "arrow", type: "arrow", x1: 10, y1: 450, x2: 200, y2: 450 },
            { id: "poly", type: "polygon", points: [[500, 100], [600, 100], [550, 200]] },
        ],
    };
    const imageNode = () => document.querySelector("[data-scene-image-index=\"0\"]");
    const status = () => $("scene-editor-status").textContent;
    const outlines = () => document.querySelectorAll(".scene-selection-outline");
    /** Presses a key on the canvas; returns whether the editor handled it (prevented the default). */
    function press(name, options = {}) {
        return !$("scene-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options }));
    }

    it("selects each object type with a visible outline, and a second click keeps it selected", async () => {
        await openBlankScene(content);

        for (const index of [0, 1, 2, 3]) {
            selectAnnotation(index);
            expect($("scene-annotation-toolbar").hidden).toBe(false);
            expect($("scene-image-toolbar").hidden).toBe(true);
            expect(outlines()).toHaveLength(1);
            selectAnnotation(index);
            expect($("scene-annotation-toolbar").hidden).toBe(false);
        }
        clickAt(imageNode(), [350, 350]);
        expect($("scene-image-toolbar").hidden).toBe(false);
        expect($("scene-annotation-toolbar").hidden).toBe(true);
        expect(outlines()).toHaveLength(1);
        clickAt(imageNode(), [350, 350]);
        expect($("scene-image-toolbar").hidden).toBe(false);
    });

    it("says which object was selected and where it is in the stack", async () => {
        await openBlankScene(content);

        selectAnnotation(0);
        await waitFor(() => expect(status()).toBe("Selected label \"Ilium\", 4 of 5 objects."));
        selectAnnotation(3);
        await waitFor(() => expect(status()).toBe("Selected highlight, 1 of 5 objects."));
        clickAt(imageNode(), [350, 350]);
        await waitFor(() => expect(status()).toBe("Selected image, 5 of 5 objects."));
    });

    it("clears the selection with Escape or a click on empty canvas", async () => {
        await openBlankScene(content);

        clickAt(imageNode(), [350, 350]);
        expect(press("Escape")).toBe(false);
        expect($("scene-image-toolbar").hidden).toBe(true);
        expect(outlines()).toHaveLength(0);
        await waitFor(() => expect(status()).toBe("Nothing selected."));

        selectAnnotation(1);
        clickAt(canvasSvg(), [900, 550]);
        expect($("scene-annotation-toolbar").hidden).toBe(true);
        expect(outlines()).toHaveLength(0);
    });

    it("keeps an image selected when one of its corner handles is clicked without dragging", async () => {
        await openBlankScene(content);
        clickAt(imageNode(), [350, 350]);

        clickAt(document.querySelector("[data-corner=\"se\"]"), [400, 400]);

        expect($("scene-image-toolbar").hidden).toBe(false);
        expect(scenesModule.getActiveScene().images[0]).toMatchObject({ x: 300, y: 300, width: 100, height: 100 });
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("steps through the objects from the top with Tab and back with Shift+Tab, then lets focus leave", async () => {
        await openBlankScene(content);
        const selected = () => {
            if (!$("scene-image-toolbar").hidden) return "image";
            if (!$("scene-annotation-toolbar").hidden) return "annotation";
            return null;
        };
        const order = [];
        for (let step = 0; step < 5; step += 1) {
            expect(press("Tab")).toBe(true);
            await waitFor(() => expect(status()).toMatch(new RegExp(`, ${step + 1} of 5 objects\\.$`)));
            order.push(status());
        }
        expect(order.map((message) => message.replace(/, \d of 5 objects\.$/, ""))).toEqual([
            "Selected highlight",
            "Selected arrow",
            "Selected line",
            "Selected label \"Ilium\"",
            "Selected image",
        ]);
        expect(selected()).toBe("image");

        expect(press("Tab", { shiftKey: true })).toBe(true);
        await waitFor(() => expect(status()).toBe("Selected label \"Ilium\", 4 of 5 objects."));

        // Past the last object, Tab clears the selection and isn't held by the canvas.
        press("Tab");
        expect(press("Tab")).toBe(false);
        expect(selected()).toBeNull();
        // With nothing selected, Shift+Tab leaves the canvas too.
        expect(press("Tab", { shiftKey: true })).toBe(false);
    });

    it("leaves Tab alone while a drawing tool is in use", async () => {
        await openBlankScene(content);
        click("scene-tool-line");
        expect(press("Tab")).toBe(false);
        expect(outlines()).toHaveLength(0);
    });
});

describe("Selecting overlapping objects (#441)", () => {
    // A label on a highlight on an image: at (320, 315) all three overlap; at
    // (390, 390) the highlight and the image; at (285, 285) only the highlight.
    const content = {
        images: [{ id: "img", src: "/images/a.png", x: 300, y: 300, width: 100, height: 100 }],
        annotations: [
            { id: "poly", type: "polygon", points: [[280, 280], [420, 280], [420, 420], [280, 420]] },
            { id: "label", type: "text", text: "Ilium", x: 310, y: 310 },
        ],
    };
    const status = () => $("scene-editor-status").textContent;
    const hint = () => $("scene-selection-hint");
    const selected = () => {
        if (!$("scene-image-toolbar").hidden) return "image";
        if ($("scene-annotation-toolbar").hidden) return null;
        return $("scene-annotation-label").textContent.includes("label") ? "label" : "highlight";
    };
    function altClickAt(target, [x, y]) {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, altKey: true }));
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, altKey: true }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, altKey: true }));
    }

    it("selects the topmost object, then each one below on clicks in the same spot, wrapping to the top", async () => {
        await openBlankScene(content);
        const order = [];
        for (let i = 0; i < 4; i += 1) {
            // The browser reports the topmost node as clicked every time.
            clickAt(annotationNode(1), [320, 315]);
            order.push(selected());
        }
        expect(order).toEqual(["label", "highlight", "image", "label"]);
    });

    it("shows and announces a hint while objects overlap, and hides it for a single object", async () => {
        await openBlankScene(content);

        clickAt(annotationNode(1), [320, 315]);
        expect(hint().hidden).toBe(false);
        expect(hint().textContent).toBe(
            "3 objects overlap here. Click again in the same spot, or Alt+click, to select the next one down."
        );
        await waitFor(() => expect(status()).toBe(
            "Selected label \"Ilium\", 1 of 3 objects. 3 objects overlap here. Click again in the same spot, or Alt+click, to select the next one down."
        ));

        clickAt(annotationNode(0), [285, 285]);
        expect(selected()).toBe("highlight");
        expect(hint().hidden).toBe(true);

        clickAt(annotationNode(1), [320, 315]);
        key("Escape");
        expect(hint().hidden).toBe(true);
    });

    it("selects the topmost object again when the click is in a different spot", async () => {
        await openBlankScene(content);
        clickAt(annotationNode(0), [390, 390]);
        clickAt(annotationNode(0), [390, 390]);
        expect(selected()).toBe("image");

        clickAt(annotationNode(0), [395, 380]);
        expect(selected()).toBe("highlight");
    });

    it("steps down the stack with Alt+click from anywhere on it", async () => {
        await openBlankScene(content);

        altClickAt(annotationNode(0), [390, 390]);
        expect(selected()).toBe("image");
        // The image is under the label too, so the next Alt+click wraps to the top there.
        altClickAt(annotationNode(1), [320, 315]);
        expect(selected()).toBe("label");
        altClickAt(annotationNode(1), [322, 316]);
        expect(selected()).toBe("highlight");
    });

    it("keeps stepping down on quick clicks instead of a double-click jumping back to the label", async () => {
        await openBlankScene(content);
        clickAt(annotationNode(1), [320, 315]);
        clickAt(annotationNode(1), [320, 315]);
        mouse("dblclick", annotationNode(1), [320, 315]);
        expect(selected()).toBe("highlight");
        expect(document.activeElement).not.toBe($("scene-annotation-text"));

        clickAt(annotationNode(1), [320, 315]);
        expect(selected()).toBe("image");
    });

    it("clears the hint once the selected object is edited", async () => {
        await openBlankScene(content);
        clickAt(annotationNode(1), [320, 315]);
        expect(hint().hidden).toBe(false);

        key("ArrowRight");

        expect(hint().hidden).toBe(true);
        expect(selected()).toBe("label");
    });
});

describe("Moving and resizing selected objects (#442)", () => {
    // A crowded scene: image "a" under a highlight and a label, image "b" to
    // its right, and a line below.
    const content = () => ({
        images: [
            { id: "a", src: "/images/a.png", x: 300, y: 300, width: 100, height: 100 },
            { id: "b", src: "/images/b.png", x: 600, y: 300, width: 100, height: 100 },
        ],
        annotations: [
            { id: "poly", type: "polygon", points: [[280, 280], [420, 280], [420, 420], [280, 420]] },
            { id: "label", type: "text", text: "Ilium", x: 310, y: 310 },
            { id: "line", type: "line", x1: 10, y1: 500, x2: 200, y2: 500 },
        ],
    });
    const images = () => scenesModule.getActiveScene().images;
    const storedImages = () => backend.scenes.get("scene-1").images;
    const imageNode = (index) => document.querySelector(`[data-scene-image-index="${index}"]`);
    const status = () => $("scene-editor-status").textContent;
    /** Selects image "a" the way a user reaches it under the highlight: clicking twice in one spot. */
    function selectCoveredImage() {
        clickAt(annotationNode(0), [390, 390]);
        clickAt(annotationNode(0), [390, 390]);
        expect($("scene-image-toolbar").hidden).toBe(false);
    }

    it("moves, nudges, and resizes an image covered by a highlight, and keeps it after reopening", async () => {
        await openBlankScene(content());
        selectCoveredImage();

        // The press lands on the highlight, but the selected image is under it, so the image moves.
        drag(annotationNode(0), [390, 390], [440, 400]);
        expect(images()[0]).toMatchObject({ x: 350, y: 310 });
        expect($("scene-image-toolbar").hidden).toBe(false);

        key("ArrowRight");
        key("ArrowDown", { shiftKey: true });
        expect(images()[0]).toMatchObject({ x: 351, y: 320 });

        // The se handle is at (451, 420); dragging it 50 right scales 100 -> 150 about the center.
        drag(document.querySelector("[data-corner=\"se\"]"), [451, 420], [501, 420]);
        expect(images()[0]).toMatchObject({ x: 326, y: 295, width: 150, height: 150 });

        await saveAndReopen();
        expect(storedImages()[0]).toMatchObject({ x: 326, y: 295, width: 150, height: 150 });
        expect(storedImages()[1]).toEqual(content().images[1]);
        expect(stored()).toEqual(content().annotations);
    });

    it("never moves an object that isn't selected", async () => {
        await openBlankScene(content());
        selectCoveredImage();

        // Pressing and dragging on the line or on image "b" moves nothing.
        drag(annotationNode(2), [100, 500], [150, 550]);
        drag(imageNode(1), [650, 350], [700, 400]);

        expect(images()).toEqual(content().images);
        expect(annotations()).toEqual(content().annotations);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("moves a selected highlight when the press lands on the label drawn over it", async () => {
        await openBlankScene(content());
        clickAt(annotationNode(0), [390, 390]);

        drag(annotationNode(1), [320, 315], [330, 325]);

        expect(annotations()[0].points).toEqual([[290, 290], [430, 290], [430, 430], [290, 430]]);
        expect(annotations()[1]).toEqual(content().annotations[1]);
        expect(images()).toEqual(content().images);
    });

    it("removes the selected image with Delete or Backspace", async () => {
        await openBlankScene(content());
        selectCoveredImage();

        key("Delete");
        expect(images().map((image) => image.id)).toEqual(["b"]);
        expect($("scene-image-toolbar").hidden).toBe(true);
        await waitFor(() => expect(status()).toBe("Image removed. Save to keep the change."));

        clickAt(imageNode(0), [650, 350]);
        key("Backspace");
        expect(images()).toEqual([]);
        expect(annotations()).toEqual(content().annotations);
    });

    // Keys go wherever focus really is, as a browser sends them, instead of
    // straight to the canvas, so a selection that leaves focus elsewhere fails.
    function keyOnFocused(name, options = {}) {
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...options }));
    }

    it("focuses the canvas when an image is clicked, so the arrow keys and Delete edit it", async () => {
        await openBlankScene(content());
        $("scene-annotation-text").focus();

        clickAt(imageNode(1), [650, 350]);
        expect(document.activeElement).toBe($("scene-canvas"));

        keyOnFocused("ArrowLeft");
        keyOnFocused("ArrowUp", { shiftKey: true });
        expect(images()[1]).toMatchObject({ x: 599, y: 290 });
        keyOnFocused("Backspace");
        expect(images().map((image) => image.id)).toEqual(["a"]);
    });

    it("moves focus from a label's text field to the canvas when the label is clicked", async () => {
        await openBlankScene(content());
        selectAnnotation(1);
        typeText("Pubis");
        expect(document.activeElement).toBe($("scene-annotation-text"));

        // Away from the first click, so it doesn't step down to the highlight below (#441).
        clickAt(annotationNode(1), [320, 315]);
        expect(document.activeElement).toBe($("scene-canvas"));
        keyOnFocused("ArrowRight");
        expect(annotations()[1]).toMatchObject({ text: "Pubis", x: 311, y: 310 });

        // A double-click still opens the selected label's text for editing.
        annotationNode(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 320, clientY: 315 }));
        expect(document.activeElement).toBe($("scene-annotation-text"));

        clickAt(annotationNode(1), [330, 315]);
        expect(document.activeElement).toBe($("scene-canvas"));
        keyOnFocused("Delete");
        expect(annotations().map((annotation) => annotation.id)).toEqual(["poly", "line"]);
    });

    it("leaves the arrow keys and Delete alone while an image's crop is being edited", async () => {
        await openBlankScene(content());
        clickAt(imageNode(1), [650, 350]);
        click("scene-image-crop-start");

        key("ArrowLeft");
        key("Delete");

        expect(images()).toEqual(content().images);
    });
});

// Issue #446: the same edits made with pointer events, which is what a mouse
// sends in browsers that support them (and touch and pen, later). jsdom may
// not have PointerEvent, so the fields the editor reads are set by hand.
describe("Mouse editing with pointer events (#446)", () => {
    // Like a browser, `buttons` says which buttons are held: the pressed one
    // until it is let go.
    const BUTTONS_HELD = { 0: 1, 1: 4, 2: 2 };
    function pointer(type, target, [x, y], { pointerId = 1, button = 0, isPrimary = true, buttons } = {}) {
        const released = type === "pointerup" || type === "pointercancel";
        const held = buttons !== undefined ? buttons : released ? 0 : BUTTONS_HELD[button];
        const init = { bubbles: true, clientX: x, clientY: y, button, buttons: held, pointerId, pointerType: "mouse", isPrimary };
        const event = typeof PointerEvent === "function" ? new PointerEvent(type, init) : new MouseEvent(type, init);
        for (const [name, value] of Object.entries({ pointerId, isPrimary, pointerType: "mouse" })) {
            if (event[name] !== value) Object.defineProperty(event, name, { value });
        }
        target.dispatchEvent(event);
    }
    function pointerDrag(target, from, to, options) {
        pointer("pointerdown", target, from, options);
        pointer("pointermove", document, to, options);
        pointer("pointerup", document, to, options);
    }
    const imageNode = () => document.querySelector("#scene-canvas [data-scene-image-index=\"0\"]");
    const images = () => scenesModule.getActiveScene().images;
    async function openSceneWithImage() {
        await openBlankScene({ images: [{ id: "img-a", src: "/images/a.png", x: 100, y: 100, width: 200, height: 100 }] });
        clickAt(imageNode(), [150, 150]);
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);
    }

    it("moves and resizes an image and keeps the change", async () => {
        await openSceneWithImage();

        pointerDrag(imageNode(), [150, 150], [180, 170]);
        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
        pointerDrag(document.querySelector("[data-corner=\"se\"]"), [330, 220], [370, 220]);
        expect(images()[0].width).toBeCloseTo(240);
        expect(images()[0].height).toBeCloseTo(120);

        expect(scenesModule.hasUnsavedChanges()).toBe(true);
        await saveAndReopen();
        expect(backend.scenes.get("scene-1").images[0].width).toBeCloseTo(240);
    });

    it("crops an image", async () => {
        await openSceneWithImage();
        click("scene-image-crop-start");

        pointerDrag(document.querySelector("[data-corner=\"se\"]"), [300, 200], [250, 180]);

        expect(images()[0]).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 150, cropHeight: 80 });
    });

    it("draws a line, moves its end and the whole line", async () => {
        await openBlankScene();

        click("scene-tool-line");
        pointerDrag(canvasSvg(), [100, 100], [300, 100]);
        expect(annotations()).toEqual([expect.objectContaining({ type: "line", x1: 100, y1: 100, x2: 300, y2: 100 })]);

        pointerDrag(document.querySelector("[data-point-index=\"1\"]"), [300, 100], [300, 250]);
        expect(annotations()[0]).toMatchObject({ x2: 300, y2: 250 });
        pointerDrag(annotationNode(0), [200, 175], [210, 185]);
        expect(annotations()[0]).toMatchObject({ x1: 110, y1: 110, x2: 310, y2: 260 });
    });

    it("moves a label", async () => {
        await openBlankScene({ annotations: [{ id: "t", type: "text", text: "Ilium", x: 100, y: 100 }] });
        selectAnnotation(0);

        pointerDrag(annotationNode(0), [110, 100], [160, 140]);

        expect(annotations()[0]).toMatchObject({ x: 150, y: 140 });
    });

    it("handles each press once, ignoring the mouse events a browser sends after a pointer press", async () => {
        await openSceneWithImage();

        pointer("pointerdown", imageNode(), [150, 150]);
        mouse("mousedown", imageNode(), [150, 150]);
        pointer("pointermove", document, [180, 170]);
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 400 }));
        pointer("pointerup", document, [180, 170]);
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400, clientY: 400 }));

        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
    });

    it("doesn't edit with the right or middle mouse button", async () => {
        await openSceneWithImage();

        pointerDrag(imageNode(), [150, 150], [180, 170], { button: 2 });
        pointerDrag(imageNode(), [150, 150], [180, 170], { button: 1 });
        click("scene-tool-line");
        pointerDrag(canvasSvg(), [100, 100], [300, 100], { button: 2 });

        expect(images()[0]).toMatchObject({ x: 100, y: 100 });
        expect(annotations()).toEqual([]);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("follows only the pointer that started the drag", async () => {
        await openSceneWithImage();

        pointer("pointerdown", imageNode(), [150, 150], { pointerId: 1 });
        pointer("pointermove", document, [500, 500], { pointerId: 2 });
        pointer("pointerup", document, [500, 500], { pointerId: 2 });
        pointer("pointermove", document, [160, 155], { pointerId: 1 });
        pointer("pointerup", document, [160, 155], { pointerId: 1 });

        expect(images()[0]).toMatchObject({ x: 110, y: 105 });
    });

    it("stops a drag the browser cancels, keeping the move made so far", async () => {
        await openSceneWithImage();

        pointer("pointerdown", imageNode(), [150, 150]);
        pointer("pointermove", document, [180, 170]);
        pointer("pointercancel", document, [180, 170]);
        pointer("pointermove", document, [400, 400]);

        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    });

    it("ends a drag whose button was let go outside the window", async () => {
        await openSceneWithImage();

        pointer("pointerdown", imageNode(), [150, 150]);
        pointer("pointermove", document, [180, 170]);
        // Back over the page with the button already up: no pointerup came.
        pointer("pointermove", document, [400, 400], { buttons: 0 });
        pointer("pointermove", document, [500, 500], { buttons: 0 });

        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    });

    it("ends a drag when the window loses focus, keeping the move made so far", async () => {
        await openSceneWithImage();

        pointer("pointerdown", imageNode(), [150, 150]);
        pointer("pointermove", document, [180, 170]);
        window.dispatchEvent(new Event("blur"));
        pointer("pointermove", document, [400, 400]);

        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    });

    it("keeps an image selected after a drag instead of the click that follows deselecting it", async () => {
        await openSceneWithImage();

        pointerDrag(imageNode(), [150, 150], [180, 170]);
        // A browser clicks after the release; the image was redrawn, so the
        // click lands on the new node.
        mouse("click", imageNode(), [180, 170]);

        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);
    });

    it("completes the main editing workflow with a mouse: create, select, move, resize, delete", async () => {
        await openSceneWithImage();
        // A press the browser turns into a click, as a pointer press.
        const pointerClick = (target, point) => {
            pointer("pointerdown", target, point);
            pointer("pointerup", document, point);
            mouse("click", target, point);
        };

        // Image: move, resize, remove.
        pointerDrag(imageNode(), [150, 150], [160, 160]);
        pointerDrag(document.querySelector("[data-corner=\"se\"]"), [310, 210], [330, 210]);
        expect(images()[0].x).toBeCloseTo(100);
        expect(images()[0].y).toBeCloseTo(105);
        expect(images()[0].width).toBeCloseTo(220);
        click("scene-image-remove");
        expect(images()).toEqual([]);

        // Label: create, select, move, delete.
        click("scene-tool-text");
        pointerClick(canvasSvg(), [100, 100]);
        typeText("Ilium");
        $("scene-annotation-text").dispatchEvent(new Event("blur"));

        // A new label starts selected: click empty canvas to let it go, then select it.
        pointerClick(canvasSvg(), [600, 500]);
        expect($("scene-annotation-toolbar").hidden).toBe(true);
        pointerClick(annotationNode(0), [110, 100]);
        expect($("scene-annotation-toolbar").hidden).toBe(false);
        expect($("scene-annotation-label").textContent).toBe("Selected label:");
        pointerDrag(annotationNode(0), [110, 100], [160, 140]);
        expect(annotations()[0]).toMatchObject({ text: "Ilium", x: 150, y: 140 });

        // Line: create, move an end (resize), delete.
        click("scene-tool-line");
        pointerDrag(canvasSvg(), [100, 300], [300, 300]);
        pointerDrag(document.querySelector("[data-point-index=\"1\"]"), [300, 300], [400, 350]);
        expect(annotations()[1]).toMatchObject({ type: "line", x1: 100, y1: 300, x2: 400, y2: 350 });
        click("scene-annotation-delete");
        expect(annotations().map((a) => a.type)).toEqual(["text"]);

        pointerClick(annotationNode(0), [150, 140]);
        click("scene-annotation-delete");
        expect(annotations()).toEqual([]);

        await saveAndReopen();
        expect(backend.scenes.get("scene-1")).toMatchObject({ images: [], annotations: [] });
    });

    it("cancels a line drag with Escape and stops following the pointer", async () => {
        await openBlankScene();

        click("scene-tool-line");
        pointer("pointerdown", canvasSvg(), [100, 100]);
        pointer("pointermove", document, [200, 150]);
        key("Escape");
        pointer("pointermove", document, [300, 200]);
        pointer("pointerup", document, [300, 200]);

        expect(annotations()).toEqual([]);
        expect(document.querySelector(".scene-draft")).toBeNull();
    });
});


describe("Undo and redo (#443)", () => {
    const content = () => ({
        images: [{ id: "img", src: "/images/a.png", x: 300, y: 300, width: 100, height: 100 }],
        annotations: [
            { id: "label", type: "text", text: "Ilium", x: 20, y: 20 },
            { id: "poly", type: "polygon", points: [[600, 100], [700, 100], [650, 200]] },
        ],
    });
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const images = () => scenesModule.getActiveScene().images;
    const imageNode = () => document.querySelector("[data-scene-image-index=\"0\"]");
    const saveStatus = () => $("scene-save-status").textContent;
    const status = () => $("scene-editor-status").textContent;
    function shortcut(name, options = {}, target = $("scene-canvas")) {
        const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
        target.dispatchEvent(event);
        return event.defaultPrevented;
    }

    it("undoes and redoes a sequence of image and annotation edits, one step at a time", async () => {
        await openBlankScene(content());
        expect($("scene-undo").disabled).toBe(true);
        expect($("scene-redo").disabled).toBe(true);

        clickAt(imageNode(), [350, 350]);
        drag(imageNode(), [350, 350], [400, 380]);
        selectAnnotation(1);
        click("scene-annotation-delete");
        await addLabel([100, 400], "Pubis");
        const edited = clone(scenesModule.getActiveScene());
        expect(edited.annotations.map((a) => a.text || a.id)).toEqual(["Ilium", "Pubis"]);

        // Typing the new label's text, then adding it, are two steps.
        click("scene-undo");
        expect(annotations().map((a) => a.text || a.id)).toEqual(["Ilium", "New label"]);
        click("scene-undo");
        expect(annotations().map((a) => a.text || a.id)).toEqual(["Ilium"]);
        click("scene-undo");
        expect(annotations()).toEqual(content().annotations);
        expect(images()[0]).toMatchObject({ x: 350, y: 330 });
        click("scene-undo");
        expect(images()).toEqual(content().images);
        expect($("scene-undo").disabled).toBe(true);
        expect(saveStatus()).toBe("Saved");

        for (let step = 0; step < 4; step += 1) click("scene-redo");
        expect(clone(scenesModule.getActiveScene()).images).toEqual(edited.images);
        expect(clone(scenesModule.getActiveScene()).annotations).toEqual(edited.annotations);
        expect($("scene-redo").disabled).toBe(true);
        await waitFor(() => expect(status()).toBe("Redone. Nothing more to redo."));
    });

    it("undoes a run of typing or arrow-key nudges as one step, but not edits of another object", async () => {
        await openBlankScene(content());
        selectAnnotation(0);
        typeText("Il");
        typeText("Ili");
        typeText("Ilio");
        key("ArrowRight");
        key("ArrowRight");
        key("ArrowDown");
        clickAt(imageNode(), [350, 350]);
        key("ArrowLeft");
        key("ArrowLeft");

        click("scene-undo");
        expect(images()[0].x).toBe(300);
        expect(annotations()[0]).toMatchObject({ text: "Ilio", x: 22, y: 21 });
        click("scene-undo");
        expect(annotations()[0]).toMatchObject({ text: "Ilio", x: 20, y: 20 });
        click("scene-undo");
        expect(annotations()[0]).toEqual(content().annotations[0]);
        expect($("scene-undo").disabled).toBe(true);
    });

    it("shows the scene as saved again when undo or redo returns to the saved version", async () => {
        await openBlankScene(content());
        selectAnnotation(0);
        key("ArrowRight", { shiftKey: true });
        await saveAndWait();

        click("scene-undo");
        expect(saveStatus()).toBe("Unsaved changes");
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
        click("scene-redo");
        expect(saveStatus()).toBe("Saved");
        expect(scenesModule.hasUnsavedChanges()).toBe(false);

        // A new edit after an undo replaces what could be redone, and is never mistaken for the saved version.
        click("scene-undo");
        key("ArrowDown");
        expect($("scene-redo").disabled).toBe(true);
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    });

    it("keeps the selected object selected when it still exists, and saves the undone state", async () => {
        await openBlankScene(content());
        selectAnnotation(0);
        key("ArrowRight");
        click("scene-annotation-delete");
        expect($("scene-annotation-toolbar").hidden).toBe(true);

        click("scene-undo");
        expect(annotations()).toHaveLength(2);
        expect($("scene-annotation-toolbar").hidden).toBe(true);

        selectAnnotation(0);
        click("scene-undo");
        expect(annotations()[0]).toEqual(content().annotations[0]);
        expect($("scene-annotation-toolbar").hidden).toBe(false);
        expect($("scene-annotation-text").value).toBe("Ilium");

        click("scene-redo");
        await saveAndReopen();
        expect(stored()[0]).toMatchObject({ x: 21, y: 20 });
        // A reopened scene starts with nothing to undo.
        expect($("scene-undo").disabled).toBe(true);
    });

    it("undoes with Ctrl/Cmd+Z and redoes with Ctrl/Cmd+Shift+Z or Ctrl+Y, leaving text fields their own undo", async () => {
        await openBlankScene(content());
        clickAt(imageNode(), [350, 350]);
        key("ArrowRight", { shiftKey: true });
        key("ArrowDown", { shiftKey: true });
        clickAt(canvasSvg(), [900, 550]);
        selectAnnotation(1);
        click("scene-annotation-delete");

        expect(shortcut("z", { ctrlKey: true })).toBe(true);
        expect(annotations()).toHaveLength(2);
        expect(shortcut("z", { metaKey: true })).toBe(true);
        expect(images()[0]).toMatchObject({ x: 300, y: 300 });
        expect(shortcut("Z", { metaKey: true, shiftKey: true })).toBe(true);
        expect(images()[0]).toMatchObject({ x: 310, y: 310 });
        expect(shortcut("y", { ctrlKey: true }, document.body)).toBe(true);
        expect(annotations()).toHaveLength(1);

        selectAnnotation(0);
        typeText("Ischium");
        expect(shortcut("z", { ctrlKey: true }, $("scene-annotation-text"))).toBe(false);
        expect(annotations()[0].text).toBe("Ischium");
    });

    it("never undoes into another scene", async () => {
        backend.seed({ id: "scene-2", name: "Another", ...content() });
        await openBlankScene(content());
        selectAnnotation(0);
        key("ArrowRight");

        jest.spyOn(window, "confirm").mockReturnValue(true);
        [...document.querySelectorAll(".scene-list-item")].find((b) => b.textContent.includes("Another")).click();
        await waitFor(() => expect($("scene-title").textContent).toBe("Another"));

        expect($("scene-undo").disabled).toBe(true);
        expect(shortcut("z", { ctrlKey: true })).toBe(false);
        expect(annotations()).toEqual(content().annotations);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });
});

describe("Warning about unsaved changes when leaving the editor (#444)", () => {
    const content = {
        images: [{ id: "img", src: "/images/a.png", x: 300, y: 300, width: 100, height: 100, source: { type: "legacy-image", boneId: "ilium" } }],
        annotations: [{ id: "label", type: "text", text: "Ilium", x: 20, y: 20 }],
    };
    const inEditor = () => !$("scene-editor-view").hidden;
    async function openEditedScene() {
        await openBlankScene(content);
        selectAnnotation(0);
        key("ArrowRight");
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    }

    it("lets the user stay in the editor from the Back button, the Scene Editor button, or a viewer link", async () => {
        await openEditedScene();
        const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
        const shownInViewer = jest.fn();
        document.addEventListener("bonebox:show-in-viewer", shownInViewer);

        click("scene-editor-back");
        click("text-button-SceneEditor");
        document.querySelector(".scene-source-link").click();

        expect(confirm).toHaveBeenCalledTimes(3);
        expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("\"Plate\" has unsaved changes"));
        expect(inEditor()).toBe(true);
        expect(shownInViewer).not.toHaveBeenCalled();
        expect(annotations()[0].x).toBe(21);
        await waitFor(() => expect($("scene-editor-status").textContent).toBe("Still in the Scene Editor. Your changes aren't saved yet."));
        document.removeEventListener("bonebox:show-in-viewer", shownInViewer);
    });

    it("leaves when the user chooses to, keeping the unsaved changes for when they come back", async () => {
        await openEditedScene();
        jest.spyOn(window, "confirm").mockReturnValue(true);

        click("scene-editor-back");
        expect(inEditor()).toBe(false);

        click("text-button-SceneEditor");
        expect(inEditor()).toBe(true);
        expect(annotations()[0].x).toBe(21);
        expect(scenesModule.hasUnsavedChanges()).toBe(true);
    });

    it("leaves without asking when everything is saved", async () => {
        await openEditedScene();
        await saveAndWait();
        const confirm = jest.spyOn(window, "confirm");

        click("scene-editor-back");

        expect(inEditor()).toBe(false);
        expect(confirm).not.toHaveBeenCalled();
    });
});

// Issue #447: the same editor used with a finger. A tap is a pointerdown and
// pointerup that the browser follows with a click.
describe("Touch editing (#447)", () => {
    function touch(type, target, [x, y], { pointerId = 1, isPrimary = true } = {}) {
        const released = type === "pointerup" || type === "pointercancel";
        const init = {
            bubbles: true, clientX: x, clientY: y, button: 0, buttons: released ? 0 : 1,
            pointerId, pointerType: "touch", isPrimary,
        };
        const event = typeof PointerEvent === "function" ? new PointerEvent(type, init) : new MouseEvent(type, init);
        for (const [name, value] of Object.entries({ pointerId, isPrimary, pointerType: "touch" })) {
            if (event[name] !== value) Object.defineProperty(event, name, { value });
        }
        target.dispatchEvent(event);
    }
    function fingerDrag(target, from, to) {
        touch("pointerdown", target, from);
        touch("pointermove", document, to);
        touch("pointerup", document, to);
    }
    // A tap whose finger wobbles a little before lifting, as real taps do.
    function tap(target, point, wobble = [0, 0]) {
        const lifted = [point[0] + wobble[0], point[1] + wobble[1]];
        touch("pointerdown", target, point);
        touch("pointermove", document, lifted);
        touch("pointerup", document, lifted);
        mouse("click", target, lifted);
    }
    const imageNode = () => document.querySelector("#scene-canvas [data-scene-image-index=\"0\"]");
    const images = () => scenesModule.getActiveScene().images;
    const isSelected = () => document.querySelectorAll(".scene-selection-outline").length === 1;
    async function openSceneWithImage(extra = {}) {
        await openBlankScene({
            images: [{ id: "img-a", src: "/images/a.png", x: 100, y: 100, width: 200, height: 100 }],
            ...extra,
        });
    }

    it("selects an image and an annotation with a tap", async () => {
        await openSceneWithImage({ annotations: [{ id: "t", type: "text", text: "Ilium", x: 400, y: 400 }] });

        tap(imageNode(), [150, 150], [3, 2]);
        expect(isSelected()).toBe(true);
        expect($("scene-image-toolbar").hidden).toBe(false);

        tap(annotationNode(0), [410, 410], [-2, 3]);
        expect($("scene-annotation-toolbar").hidden).toBe(false);
        expect($("scene-annotation-label").textContent).toBe("Selected label:");
    });

    it("doesn't nudge a selected image when a tap wobbles a few pixels", async () => {
        await openSceneWithImage();
        tap(imageNode(), [150, 150]);

        touch("pointerdown", imageNode(), [150, 150]);
        touch("pointermove", document, [155, 154]);
        touch("pointerup", document, [155, 154]);

        expect(images()[0]).toMatchObject({ x: 100, y: 100 });
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("moves and resizes an image with a finger and keeps the change", async () => {
        await openSceneWithImage();
        tap(imageNode(), [150, 150]);

        fingerDrag(imageNode(), [150, 150], [180, 170]);
        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
        fingerDrag(document.querySelector("[data-corner=\"se\"]"), [330, 220], [370, 220]);
        expect(images()[0].width).toBeCloseTo(240);
        expect(images()[0].height).toBeCloseTo(120);

        await saveAndReopen();
        expect(backend.scenes.get("scene-1").images[0].width).toBeCloseTo(240);
    });

    it("creates a label with a tap and a line with a finger drag", async () => {
        await openBlankScene();

        click("scene-tool-text");
        tap(canvasSvg(), [100, 100]);
        typeText("Ilium");
        click("scene-tool-line");
        fingerDrag(canvasSvg(), [100, 300], [300, 300]);

        expect(annotations()).toEqual([
            expect.objectContaining({ type: "text", text: "Ilium", x: 100, y: 100 }),
            expect.objectContaining({ type: "line", x1: 100, y1: 300, x2: 300, y2: 300 }),
        ]);
    });

    it("creates a highlight corner by corner with taps", async () => {
        await openBlankScene();

        click("scene-tool-polygon");
        tap(canvasSvg(), [100, 100]);
        tap(canvasSvg(), [200, 100]);
        tap(canvasSvg(), [150, 200]);
        click("scene-polygon-finish");

        expect(annotations()).toEqual([expect.objectContaining({ type: "polygon" })]);
        expect(annotations()[0].points).toHaveLength(3);
    });

    it("moves a label, resizes it, and moves a line's end with a finger", async () => {
        await openBlankScene({
            annotations: [
                { id: "t", type: "text", text: "Ilium", x: 10, y: 10, fontSize: 20 },
                { id: "l", type: "line", x1: 100, y1: 300, x2: 300, y2: 300 },
            ],
        });

        tap(annotationNode(0), [15, 15]);
        fingerDrag(annotationNode(0), [15, 15], [65, 55]);
        expect(annotations()[0]).toMatchObject({ x: 60, y: 50 });
        // The label is 60 wide at 20px; dragging its corner 60 to the right doubles it.
        fingerDrag(document.querySelector("[data-annotation-handle=\"resize\"]"), [113, 103], [173, 103]);
        expect(annotations()[0].fontSize).toBe(40);

        tap(annotationNode(1), [200, 300]);
        fingerDrag(document.querySelector("[data-point-index=\"1\"]"), [300, 300], [300, 400]);
        expect(annotations()[1]).toMatchObject({ x1: 100, y1: 300, x2: 300, y2: 400 });
    });

    it("ignores a second finger during a drag", async () => {
        await openSceneWithImage();
        tap(imageNode(), [150, 150]);

        touch("pointerdown", imageNode(), [150, 150], { pointerId: 1 });
        touch("pointerdown", imageNode(), [300, 300], { pointerId: 2, isPrimary: false });
        touch("pointermove", document, [500, 500], { pointerId: 2, isPrimary: false });
        touch("pointermove", document, [180, 170], { pointerId: 1 });
        touch("pointerup", document, [500, 500], { pointerId: 2, isPrimary: false });
        touch("pointerup", document, [180, 170], { pointerId: 1 });

        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
    });

    it("marks what a finger drag would edit, so the page doesn't scroll there", async () => {
        const css = require("fs").readFileSync(require("path").join(__dirname, "..", "style.css"), "utf8");
        const noScroll = css.match(/([^{}]+)\{\s*touch-action:\s*none;\s*\}/);
        expect(noScroll).not.toBeNull();
        for (const selector of [".is-drawing svg", ".is-selected", ".scene-resize-handle", ".scene-point-handle"]) {
            expect(noScroll[1]).toContain(selector);
        }

        await openSceneWithImage({ annotations: [{ id: "t", type: "text", text: "Ilium", x: 400, y: 400 }] });
        expect(document.querySelectorAll("#scene-canvas .is-selected")).toHaveLength(0);

        tap(imageNode(), [150, 150]);
        expect(imageNode().closest(".is-selected")).not.toBeNull();

        tap(annotationNode(0), [410, 410]);
        expect(imageNode().closest(".is-selected")).toBeNull();
        expect(document.querySelectorAll("#scene-canvas [data-scene-annotation-index=\"0\"].is-selected").length)
            .toBeGreaterThan(0);

        click("scene-tool-line");
        expect($("scene-canvas").classList.contains("is-drawing")).toBe(true);
    });

    it("sizes handles for a fingertip from how large the canvas is drawn", async () => {
        await openSceneWithImage();
        // jsdom draws the 960-wide scene 1:1: a 10-unit handle is 10px, so it needs 3.2x.
        tap(imageNode(), [150, 150]);
        expect($("scene-canvas").style.getPropertyValue("--touch-target-scale")).toBe("3.2");

        // Drawn at half size (a phone), the handle is 5px and needs 6.4x.
        jest.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 480, height: 300 });
        tap(imageNode(), [150, 150]);
        expect($("scene-canvas").style.getPropertyValue("--touch-target-scale")).toBe("6.4");
    });
});

// Issue #448: a pen or stylus. Browsers send it as pointer events with
// pointerType "pen": the tip is the main button, the eraser end is button 5
// and the barrel button is button 2.
describe("Stylus editing (#448)", () => {
    const BUTTONS_HELD = { 0: 1, 2: 2, 5: 32 };
    function press(type, target, [x, y], { pointerType = "pen", pointerId = 1, button = 0, isPrimary = true } = {}) {
        const released = type === "pointerup" || type === "pointercancel";
        const init = {
            bubbles: true, clientX: x, clientY: y, button, buttons: released ? 0 : BUTTONS_HELD[button],
            pointerId, pointerType, isPrimary,
        };
        const event = typeof PointerEvent === "function" ? new PointerEvent(type, init) : new MouseEvent(type, init);
        for (const [name, value] of Object.entries({ pointerId, isPrimary, pointerType })) {
            if (event[name] !== value) Object.defineProperty(event, name, { value });
        }
        target.dispatchEvent(event);
    }
    function dragWith(target, from, to, options) {
        press("pointerdown", target, from, options);
        press("pointermove", document, to, options);
        press("pointerup", document, to, options);
    }
    function tapWith(target, point, options) {
        press("pointerdown", target, point, options);
        press("pointerup", document, point, options);
        mouse("click", target, point);
    }
    function contextMenuIsBlocked(target) {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return event.defaultPrevented;
    }
    const imageNode = () => document.querySelector("#scene-canvas [data-scene-image-index=\"0\"]");
    const images = () => scenesModule.getActiveScene().images;
    async function openSceneWithImage(extra = {}) {
        await openBlankScene({
            images: [{ id: "img-a", src: "/images/a.png", x: 100, y: 100, width: 200, height: 100 }],
            ...extra,
        });
    }

    it.each(["mouse", "touch", "pen"])("edits the same way with a %s: select, move, resize, draw", async (pointerType) => {
        await openSceneWithImage();
        const input = { pointerType };

        tapWith(imageNode(), [150, 150], input);
        dragWith(imageNode(), [150, 150], [180, 170], input);
        dragWith(document.querySelector("[data-corner=\"se\"]"), [330, 220], [370, 220], input);
        click("scene-tool-line");
        dragWith(canvasSvg(), [100, 300], [300, 300], input);

        expect(images()[0].x).toBeCloseTo(110);
        expect(images()[0].y).toBeCloseTo(110);
        expect(images()[0].width).toBeCloseTo(240);
        expect(images()[0].height).toBeCloseTo(120);
        expect(annotations()).toEqual([expect.objectContaining({ type: "line", x1: 100, y1: 300, x2: 300, y2: 300 })]);
    });

    it("selects and moves a label, and crops an image, with a pen", async () => {
        await openSceneWithImage({ annotations: [{ id: "t", type: "text", text: "Ilium", x: 400, y: 400 }] });

        tapWith(annotationNode(0), [410, 410]);
        dragWith(annotationNode(0), [410, 410], [460, 450]);
        expect(annotations()[0]).toMatchObject({ x: 450, y: 440 });

        tapWith(imageNode(), [150, 150]);
        click("scene-image-crop-start");
        dragWith(document.querySelector("[data-corner=\"se\"]"), [300, 200], [250, 180]);
        expect(images()[0]).toMatchObject({ cropWidth: 150, cropHeight: 80 });
    });

    it("doesn't edit with the pen's eraser or barrel button", async () => {
        await openSceneWithImage();
        tapWith(imageNode(), [150, 150]);

        dragWith(imageNode(), [150, 150], [180, 170], { button: 5 });
        dragWith(imageNode(), [150, 150], [180, 170], { button: 2 });
        click("scene-tool-line");
        dragWith(canvasSvg(), [100, 300], [300, 300], { button: 5 });

        expect(images()[0]).toMatchObject({ x: 100, y: 100 });
        expect(annotations()).toEqual([]);
        expect(scenesModule.hasUnsavedChanges()).toBe(false);
    });

    it("doesn't let a palm resting on the screen take over a pen drag or change the selection", async () => {
        await openSceneWithImage({ annotations: [{ id: "t", type: "text", text: "Ilium", x: 400, y: 400 }] });
        tapWith(imageNode(), [150, 150]);
        const palm = { pointerType: "touch", pointerId: 2 };

        press("pointerdown", imageNode(), [150, 150], { pointerId: 1 });
        press("pointerdown", annotationNode(0), [410, 410], palm);
        press("pointermove", document, [460, 450], palm);
        press("pointerup", document, [460, 450], palm);
        mouse("click", annotationNode(0), [460, 450]);
        press("pointermove", document, [180, 170], { pointerId: 1 });
        press("pointerup", document, [180, 170], { pointerId: 1 });

        expect(images()[0]).toMatchObject({ x: 130, y: 120 });
        expect(annotations()[0]).toMatchObject({ x: 400, y: 400 });
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);
        expect($("scene-annotation-toolbar").hidden).toBe(true);
    });

    it("keeps a pen or finger long press from opening the right-click menu, but not a mouse right click", async () => {
        await openSceneWithImage();

        press("pointerdown", canvasSvg(), [500, 500], { pointerType: "pen" });
        expect(contextMenuIsBlocked(canvasSvg())).toBe(true);
        press("pointerup", document, [500, 500], { pointerType: "pen" });

        press("pointerdown", canvasSvg(), [500, 500], { pointerType: "touch" });
        expect(contextMenuIsBlocked(canvasSvg())).toBe(true);
        press("pointerup", document, [500, 500], { pointerType: "touch" });

        press("pointerdown", canvasSvg(), [500, 500], { pointerType: "mouse", button: 2 });
        expect(contextMenuIsBlocked(canvasSvg())).toBe(false);
    });
});
