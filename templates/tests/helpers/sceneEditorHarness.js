// Shared setup for the Scene Editor release tests (#477: #478, #479, #481,
// #483). It loads the real page markup and scenes.js against an in-memory
// /api/scenes, and sends input the way a browser does: mouse events, and
// pointer events for mouse, touch and pen.
const fs = require("fs");
const path = require("path");

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "..", "boneset.html"), "utf8");
// Parsed and stripped as a DOM rather than with a regex, which can't reliably
// remove every <script> (CodeQL js/incomplete-multi-character-sanitization).
const pageDocument = new DOMParser().parseFromString(pageHtml, "text/html");
pageDocument.querySelectorAll("script").forEach((script) => script.remove());
const bodyHtml = pageDocument.body.innerHTML;

const V0 = Date.parse("2026-10-01T00:00:00.000Z");
const clone = (value) => JSON.parse(JSON.stringify(value));

/** In-memory stand-in for /api/scenes: list, create, read, rename, save, delete. */
function createFakeBackend() {
    const scenes = new Map();
    const calls = [];
    let counter = 0;
    let version = 0;
    const nextTime = () => new Date(V0 + (version += 1) * 1000).toISOString();
    const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });

    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : undefined;
        const match = url.match(/^\/api\/scenes\/?([^/?]*)/);
        if (!match) return respond(404, { error: "Not found" });
        const id = decodeURIComponent(match[1]) || null;
        calls.push({ method, id, body });

        if (!id && method === "GET") {
            return respond(200, {
                scenes: [...scenes.values()].map((s) => ({
                    id: s.id, name: s.name, imageCount: s.images.length, annotationCount: s.annotations.length,
                    createdAt: s.createdAt, updatedAt: s.updatedAt,
                })),
            });
        }
        if (!id && method === "POST") {
            counter += 1;
            const now = nextTime();
            const scene = {
                id: `scene-${counter}`, name: body.name || `Untitled Scene ${counter}`,
                images: [], annotations: [], createdAt: now, updatedAt: now,
            };
            scenes.set(scene.id, scene);
            return respond(201, scene);
        }
        const scene = scenes.get(id);
        if (!scene) return respond(404, { error: "Scene not found" });
        if (method === "GET") return respond(200, scene);
        if (method === "PUT") {
            if (body.baseUpdatedAt && body.baseUpdatedAt !== scene.updatedAt) {
                return respond(412, { error: "Scene has changed", updatedAt: scene.updatedAt });
            }
            scene.images = body.images;
            scene.annotations = body.annotations;
            scene.updatedAt = nextTime();
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
        /** Stores a scene as if it had been saved earlier, and returns it. */
        seed(scene) {
            counter += 1;
            const now = nextTime();
            const full = { id: `scene-${counter}`, images: [], annotations: [], createdAt: now, updatedAt: now, ...clone(scene) };
            scenes.set(full.id, full);
            return full;
        },
        stored(name) {
            return [...scenes.values()].find((s) => s.name === name);
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
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const $ = (id) => document.getElementById(id);
const click = (id) => $(id).click();
const canvasSvg = () => document.querySelector("#scene-canvas svg");
const imageNode = (index) => document.querySelector(`#scene-canvas [data-scene-image-index="${index}"]`);
const annotationNode = (index) => document.querySelector(`#scene-canvas [data-scene-annotation-index="${index}"]`);
const outlines = () => document.querySelectorAll("#scene-canvas .scene-selection-outline");

// jsdom gives the SVG no on-screen size, so the editor maps client
// coordinates 1:1 onto the scene's viewBox unless a test sets a size.
function mouse(type, target, [x, y], options = {}) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...options }));
}
/** A full mouse press: the click follows mousedown and mouseup. */
function clickAt(target, point, options = {}) {
    mouse("mousedown", target, point, options);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: point[0], clientY: point[1], ...options }));
    mouse("click", target, point, options);
}
/**
 * A mouse drag. Like Chromium, it ends with a click on the canvas (the
 * pressed node is redrawn during the drag, so the click goes to the canvas
 * that holds both ends), which the editor ignores after a real drag.
 */
function drag(target, from, to) {
    mouse("mousedown", target, from);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: to[0], clientY: to[1] }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: to[0], clientY: to[1] }));
    mouse("click", canvasSvg(), to);
}
function key(name, options = {}) {
    $("scene-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...options }));
}

// Pointer events as a browser sends them for each kind of input. jsdom may
// not have PointerEvent, so the fields the editor reads are set by hand.
function pointer(type, target, [x, y], { pointerType = "mouse", pointerId = 1, isPrimary = true } = {}) {
    const released = type === "pointerup" || type === "pointercancel";
    const init = {
        bubbles: true, clientX: x, clientY: y, button: 0, buttons: released ? 0 : 1, pointerId, pointerType, isPrimary,
    };
    const event = typeof PointerEvent === "function" ? new PointerEvent(type, init) : new MouseEvent(type, init);
    for (const [name, value] of Object.entries({ pointerId, isPrimary, pointerType })) {
        if (event[name] !== value) Object.defineProperty(event, name, { value });
    }
    target.dispatchEvent(event);
}
/** A press and release in one spot, followed by the click the browser sends. */
function tapWith(pointerType, target, point) {
    pointer("pointerdown", target, point, { pointerType });
    pointer("pointerup", document, point, { pointerType });
    mouse("click", target, point);
}
/** A press, a move in a few steps, and a release. */
function dragWith(pointerType, target, from, to, steps = 4) {
    pointer("pointerdown", target, from, { pointerType });
    for (let i = 1; i <= steps; i += 1) {
        const at = [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps];
        pointer("pointermove", document, at, { pointerType });
    }
    pointer("pointerup", document, to, { pointerType });
}

/**
 * Lays the canvas out as a browser would at a given width (the same model as
 * the #450 tests): the canvas box is `width` pixels wide, the SVG is drawn at
 * its zoomed size inside it, and the canvas scrolls. Call before opening a
 * scene; `resizeCanvas` then changes the width and tells the editor through
 * its ResizeObserver, as rotating a tablet or resizing a window does.
 */
function installLayout(width, height = 600) {
    const box = { width, height };
    const scroll = { left: 0, top: 0 };
    const observers = [];
    global.ResizeObserver = class {
        constructor(callback) {
            observers.push(callback);
        }
        observe() {}
        disconnect() {}
    };
    const drawn = () => {
        const svg = canvasSvg();
        if (!svg) return { width: 0, height: 0 };
        const [, , viewWidth, viewHeight] = svg.getAttribute("viewBox").split(" ").map(Number);
        const drawnWidth = (box.width * (parseFloat(svg.style.width) || 100)) / 100;
        return { width: drawnWidth, height: (drawnWidth * viewHeight) / viewWidth };
    };
    jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
        if (this.tagName.toLowerCase() === "svg") {
            // A browser reports an SVG that is no longer on the page as 0 x 0.
            if (!this.isConnected) return { left: 0, top: 0, x: 0, y: 0, width: 0, height: 0 };
            return { left: -scroll.left, top: -scroll.top, x: -scroll.left, y: -scroll.top, ...drawn() };
        }
        return { left: 0, top: 0, x: 0, y: 0, ...box };
    });
    const layout = {
        box,
        scroll,
        /** Applies the layout to the canvas; call once the editor is on the page. */
        attach() {
            const canvas = $("scene-canvas");
            const define = (name, get, set) => Object.defineProperty(canvas, name, { configurable: true, get, set });
            define("scrollLeft", () => scroll.left, (value) => { scroll.left = Math.max(0, value); });
            define("scrollTop", () => scroll.top, (value) => { scroll.top = Math.max(0, value); });
            define("offsetWidth", () => box.width);
            define("clientWidth", () => box.width);
            define("clientHeight", () => box.height);
            define("scrollWidth", () => Math.max(box.width, drawn().width));
            define("scrollHeight", () => Math.max(box.height, drawn().height));
        },
        resizeCanvas(newWidth, newHeight = box.height) {
            box.width = newWidth;
            box.height = newHeight;
            observers.forEach((callback) => callback([]));
        },
        /** Scene units per screen pixel at the current size and zoom. */
        unitsPerPixel() {
            const svg = canvasSvg();
            return Number(svg.getAttribute("viewBox").split(" ")[2]) / drawn().width;
        },
        /** Where a scene point is on screen. */
        toClient([x, y]) {
            const svg = canvasSvg();
            const [viewX, viewY] = svg.getAttribute("viewBox").split(" ").map(Number);
            const perPixel = layout.unitsPerPixel();
            return [(x - viewX) / perPixel - scroll.left, (y - viewY) / perPixel - scroll.top];
        },
    };
    return layout;
}

let scenesModule = null;

/** Loads the page and a fresh copy of scenes.js, as opening the page does. */
function startEditor(backend) {
    document.body.innerHTML = bodyHtml;
    global.fetch = backend.fetch;
    jest.resetModules();
    scenesModule = require("../../js/scenes.js");
    scenesModule.initializeSceneEditor();
    return scenesModule;
}

const activeScene = () => scenesModule.getActiveScene();

async function enterEditor() {
    click("text-button-SceneEditor");
    await waitFor(() => expect($("scene-library-message").hidden).toBe(true));
}

async function openByName(name) {
    const button = () =>
        [...document.querySelectorAll(".scene-list-item")].find((b) => b.querySelector(".scene-list-name").textContent === name);
    await waitFor(() => expect(button()).toBeTruthy());
    button().click();
    await waitFor(() => expect($("scene-title").textContent).toBe(name));
    await waitFor(() => expect(activeScene()).toBeTruthy());
}

async function saveAndWait() {
    click("scene-save");
    await waitFor(() => expect($("scene-save-status").textContent).toBe("Saved"));
}

/** Saves, then loads the scene in a fresh editor, as reloading the page would. */
async function saveAndReopen(backend, name) {
    await saveAndWait();
    startEditor(backend);
    await enterEditor();
    await openByName(name);
}

// Monotonic ids, so a test can tell images apart and compare them exactly.
function useCountingUuids() {
    if (!global.crypto) global.crypto = {};
    let uuid = 0;
    jest.spyOn(global.crypto, "randomUUID").mockImplementation(() => `uuid-${(uuid += 1)}`);
}

module.exports = {
    $,
    activeScene,
    annotationNode,
    bodyHtml,
    canvasSvg,
    click,
    clickAt,
    clone,
    createFakeBackend,
    drag,
    dragWith,
    enterEditor,
    imageNode,
    installLayout,
    key,
    mouse,
    openByName,
    outlines,
    pointer,
    saveAndReopen,
    saveAndWait,
    startEditor,
    tapWith,
    useCountingUuids,
    waitFor,
};
