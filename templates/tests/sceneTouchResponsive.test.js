// Issue #483 (parent #477): the core editing workflow with a mouse, a finger
// and a pen, on phone, tablet and desktop canvas sizes; and zooming, panning
// and resizing never move objects out of line or change the scene. The
// browser and device checks, and what a physical stylus still needs, are in
// docs/scene-editor-testing/README.md.
const {
    $, activeScene, canvasSvg, click, clone, createFakeBackend, dragWith, enterEditor, imageNode,
    installLayout, openByName, pointer, saveAndReopen, startEditor, tapWith, useCountingUuids,
} = require("./helpers/sceneEditorHarness");

let backend;

beforeEach(() => {
    useCountingUuids();
    backend = createFakeBackend();
    startEditor(backend);
});

afterEach(() => {
    jest.restoreAllMocks();
    delete global.ResizeObserver;
});

// Canvas widths measured in Chromium at 375 x 812 (phone), 768 x 1024
// (tablet) and 1024 x 768 (desktop) - see the README.
const SIZES = { phone: 303, tablet: 686, desktop: 850 };
const INPUTS = ["mouse", "touch", "pen"];
const IMAGE = { id: "img", src: "/api/images/ilium.png", x: 100, y: 100, width: 200, height: 100 };

/** Opens a scene laid out at `width` screen pixels. */
async function openAt(width, content) {
    const layout = installLayout(width);
    startEditor(backend);
    layout.attach();
    backend.seed({ name: "Plate", ...clone(content) });
    await enterEditor();
    await openByName("Plate");
    click("scene-zoom-reset"); // draw again with the layout
    layout.resizeCanvas(width); // a ResizeObserver reports the first size when it starts
    return layout;
}

/** Drags by a distance given in scene units, starting at a scene point. */
function dragScene(layout, input, target, from, by) {
    const start = layout.toClient(from);
    const end = layout.toClient([from[0] + by[0], from[1] + by[1]]);
    dragWith(input, target, start, end);
}

describe("Issue 483: the core workflow with each input at each size", () => {
    const cases = Object.entries(SIZES).flatMap(([size, width]) => INPUTS.map((input) => [input, size, width]));

    it.each(cases)("with a %s on a %s (%i px canvas): select, move, resize, rotate, draw, label, save", async (input, _size, width) => {
        const layout = await openAt(width, { images: [IMAGE] });

        tapWith(input, imageNode(0), layout.toClient([150, 150]));
        expect($("scene-image-toolbar").hidden).toBe(false);

        dragScene(layout, input, imageNode(0), [150, 150], [60, 40]);
        expect(activeScene().images[0].x).toBeCloseTo(160, 1);
        expect(activeScene().images[0].y).toBeCloseTo(140, 1);

        // The handle is at the image's bottom-right corner, (360, 240).
        dragScene(layout, input, document.querySelector("[data-corner=\"se\"]"), [360, 240], [40, 0]);
        click("scene-image-rotate-right-90");

        click("scene-tool-line");
        dragScene(layout, input, canvasSvg(), [500, 450], [200, 0]);
        click("scene-tool-text");
        tapWith(input, canvasSvg(), layout.toClient([600, 100]));
        $("scene-annotation-text").value = "Ilium";
        $("scene-annotation-text").dispatchEvent(new Event("input", { bubbles: true }));

        await saveAndReopen(backend, "Plate");
        const [image] = activeScene().images;
        expect(image.width).toBeCloseTo(240, 1);
        expect(image.height).toBeCloseTo(120, 1);
        expect(image.x).toBeCloseTo(140, 1); // still centered on (260, 190)
        expect(image.y).toBeCloseTo(130, 1);
        expect(image.rotation).toBe(90);
        const [line, label] = activeScene().annotations;
        expect(line).toMatchObject({ type: "line" });
        expect([line.x1, line.y1, line.x2, line.y2].map((value) => Math.round(value))).toEqual([500, 450, 700, 450]);
        expect(label).toMatchObject({ type: "text", text: "Ilium" });
        expect([label.x, label.y].map((value) => Math.round(value))).toEqual([600, 100]);
    });

    it.each(Object.entries(SIZES))("keeps handles at least 32 px across for a finger on a %s", async (_size, width) => {
        const layout = await openAt(width, { images: [IMAGE] });
        tapWith("touch", imageNode(0), layout.toClient([150, 150]));

        const scale = Number($("scene-canvas").style.getPropertyValue("--touch-target-scale"));
        const handleScenePx = Number(document.querySelector("[data-corner=\"se\"]").getAttribute("width"));
        expect((handleScenePx * scale) / layout.unitsPerPixel()).toBeGreaterThanOrEqual(31.9);
    });

    it("lets a small tap wobble select without moving anything, for a finger", async () => {
        const layout = await openAt(SIZES.phone, { images: [IMAGE] });
        tapWith("touch", imageNode(0), layout.toClient([150, 150]));

        const start = layout.toClient([150, 150]);
        pointer("pointerdown", imageNode(0), start, { pointerType: "touch" });
        pointer("pointermove", document, [start[0] + 6, start[1] + 5], { pointerType: "touch" });
        pointer("pointerup", document, [start[0] + 6, start[1] + 5], { pointerType: "touch" });

        expect(activeScene().images[0]).toEqual(IMAGE);
        expect($("scene-save-status").textContent).not.toBe("Unsaved changes");
    });
});

describe("Issue 483: zooming, panning and resizing keep the scene aligned", () => {
    // An imported label and highlight linked to the image, and a line drawn by hand.
    const frame = { x: 100, y: 100, width: 200, height: 100 };
    const ALIGNED = {
        images: [{ ...IMAGE }],
        annotations: [
            { id: "label", type: "text", text: "Ilium", x: 150, y: 110, fontSize: 10, sourceImageId: "img", sourceImageFrame: frame, source: { type: "legacy-label" } },
            { id: "region", type: "polygon", points: [[120, 120], [200, 120], [160, 180]], sourceImageId: "img", sourceImageFrame: frame, source: { type: "legacy-region" } },
            { id: "line", type: "line", x1: 350, y1: 150, x2: 500, y2: 150 },
        ],
    };
    const drawing = () => canvasSvg().innerHTML;

    it("draws exactly the same scene at every zoom, scroll position and size, and changes nothing", async () => {
        const layout = await openAt(SIZES.desktop, ALIGNED);
        const original = drawing();

        const views = [];
        for (let i = 0; i < 4; i += 1) {
            click("scene-zoom-in");
            views.push(drawing());
        }
        layout.scroll.left = 200;
        layout.scroll.top = 120;
        $("scene-canvas").dispatchEvent(new Event("scroll"));
        views.push(drawing());
        for (const width of [SIZES.phone, SIZES.tablet, 1400, SIZES.desktop]) {
            layout.resizeCanvas(width);
            views.push(drawing());
        }
        for (let i = 0; i < 8; i += 1) click("scene-zoom-out");
        views.push(drawing());
        click("scene-zoom-reset");
        views.push(drawing());

        expect(views.every((view) => view === original)).toBe(true);
        expect(activeScene()).toMatchObject(ALIGNED);
        expect($("scene-save-status").textContent).not.toBe("Unsaved changes");
    });

    it("moves linked annotations with their image the same way, whatever the input, size or zoom", async () => {
        const results = [];
        for (const [input, width, zoomIns] of [["mouse", SIZES.desktop, 0], ["touch", SIZES.phone, 3], ["pen", SIZES.tablet, 1]]) {
            const layout = await openAt(width, ALIGNED);
            for (let i = 0; i < zoomIns; i += 1) click("scene-zoom-in");
            tapWith(input, imageNode(0), layout.toClient([250, 180]));
            dragScene(layout, input, imageNode(0), [250, 180], [50, 30]);
            click("scene-image-rotate-right-15");
            await saveAndReopen(backend, "Plate");
            results.push({ scene: clone(activeScene()), drawing: drawing() });
            backend.scenes.clear();
        }

        for (const { scene } of results) {
            expect(scene.images[0].x).toBeCloseTo(150, 1);
            expect(scene.images[0].y).toBeCloseTo(130, 1);
            expect(scene.images[0].rotation).toBe(15);
            // Linked annotations keep their own coordinates and are drawn with the image.
            expect(scene.annotations).toEqual(ALIGNED.annotations);
        }
        // Drawn to the nearest tenth of a scene unit; a drag converted from a
        // different screen size can differ by a rounding error below that.
        const rounded = (html) => html.replace(/-?\d+(\.\d+)?/g, (number) => Number(number).toFixed(1));
        expect(rounded(results[1].drawing)).toBe(rounded(results[0].drawing));
        expect(rounded(results[2].drawing)).toBe(rounded(results[0].drawing));
    });

    it("ends a drag cleanly when the screen rotates mid-drag, keeping the move made so far", async () => {
        const layout = await openAt(SIZES.phone, { images: [IMAGE] });
        tapWith("touch", imageNode(0), layout.toClient([150, 150]));
        const start = layout.toClient([150, 150]);
        const halfway = layout.toClient([180, 170]);

        pointer("pointerdown", imageNode(0), start, { pointerType: "touch" });
        pointer("pointermove", document, halfway, { pointerType: "touch" });
        layout.resizeCanvas(SIZES.tablet); // the phone turned sideways
        pointer("pointermove", document, [halfway[0] + 200, halfway[1] + 200], { pointerType: "touch" });
        pointer("pointerup", document, [halfway[0] + 200, halfway[1] + 200], { pointerType: "touch" });

        expect(activeScene().images[0].x).toBeCloseTo(130, 1);
        expect(activeScene().images[0].y).toBeCloseTo(120, 1);
        expect(document.querySelectorAll(".scene-selection-outline")).toHaveLength(1);
    });
});
