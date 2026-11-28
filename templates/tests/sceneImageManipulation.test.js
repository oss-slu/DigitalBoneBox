// Issue #479 (parent #477): every image operation - position, size,
// rotation, flip, crop, order and removal - on single- and multi-image
// scenes, including the scene's edges and overlapping images. Each one
// changes only the selected image, and the result is kept after saving and
// reopening. The browser checks are in docs/scene-editor-testing/README.md.
const {
    $, activeScene, canvasSvg, click, clickAt, clone, createFakeBackend, drag, enterEditor, imageNode, key,
    openByName, outlines, saveAndReopen, startEditor, useCountingUuids,
} = require("./helpers/sceneEditorHarness");

let backend;

beforeEach(() => {
    useCountingUuids();
    backend = createFakeBackend();
    startEditor(backend);
});

afterEach(() => {
    jest.restoreAllMocks();
});

// Three images: "a" partly under "b", and "c" on its own to the right.
const THREE = [
    { id: "a", src: "/api/images/a.png", x: 40, y: 40, width: 200, height: 100 },
    { id: "b", src: "/api/images/b.png", x: 140, y: 90, width: 200, height: 100 },
    { id: "c", src: "/api/images/c.png", x: 600, y: 300, width: 120, height: 160 },
];

async function openScene(images, name = "Plate") {
    backend.seed({ name, images });
    await enterEditor();
    await openByName(name);
}

/** Selects an image with a click on a spot only it covers. */
function select(id) {
    const index = activeScene().images.findIndex((image) => image.id === id);
    imageNode(index).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect($("scene-image-toolbar").hidden).toBe(false);
}
const byId = (id) => activeScene().images.find((image) => image.id === id);
const corner = (name) => document.querySelector(`[data-corner="${name}"]`);
const others = (id) => activeScene().images.filter((image) => image.id !== id);

// Each operation, applied to the selected image "b".
const OPERATIONS = {
    "move with a drag": () => drag(imageNode(1), [200, 120], [230, 150]),
    "move with the arrow keys": () => {
        key("ArrowRight");
        key("ArrowDown", { shiftKey: true });
    },
    "resize from a corner": () => drag(corner("se"), [340, 190], [380, 190]),
    "rotate": () => {
        click("scene-image-rotate-right-90");
        click("scene-image-rotate-left-15");
    },
    "flip horizontally": () => click("scene-image-flip-horizontal"),
    "flip vertically": () => click("scene-image-flip-vertical"),
    "crop": () => {
        click("scene-image-crop-start");
        drag(corner("se"), [340, 190], [300, 170]);
        click("scene-image-crop-done");
    },
};

const EXPECTED = {
    "move with a drag": { x: 170, y: 120, width: 200, height: 100 },
    "move with the arrow keys": { x: 141, y: 100 },
    "resize from a corner": { x: 120, y: 80, width: 240, height: 120 },
    "rotate": { rotation: 75 },
    "flip horizontally": { flipX: true },
    "flip vertically": { flipY: true },
    "crop": { cropX: 0, cropY: 0, cropWidth: 160, cropHeight: 80, width: 200, height: 100 },
};

describe("Issue 479: each operation changes only the selected image", () => {
    it.each(Object.keys(OPERATIONS))("%s", async (operation) => {
        await openScene(THREE);
        select("b");

        OPERATIONS[operation]();

        expect(byId("b")).toMatchObject(EXPECTED[operation]);
        expect(others("b")).toEqual([THREE[0], THREE[2]]);
        expect($("scene-save-status").textContent).toBe("Unsaved changes");

        await saveAndReopen(backend, "Plate");
        expect(byId("b")).toMatchObject(EXPECTED[operation]);
        expect(others("b")).toEqual([THREE[0], THREE[2]]);
    });

    it("reorders: Bring forward and Send backward swap only the selected image with its neighbor", async () => {
        await openScene(THREE);
        select("a");

        click("scene-image-forward");
        expect(activeScene().images.map((image) => image.id)).toEqual(["b", "a", "c"]);
        click("scene-image-forward");
        expect(activeScene().images.map((image) => image.id)).toEqual(["b", "c", "a"]);
        expect($("scene-image-forward").disabled).toBe(true);
        click("scene-image-backward");

        await saveAndReopen(backend, "Plate");
        expect(activeScene().images).toEqual([THREE[1], THREE[0], THREE[2]]);
        // The paint order on the canvas follows the saved order.
        expect([0, 1, 2].map((index) => imageNode(index).getAttribute("href"))).toEqual([
            "/api/images/b.png", "/api/images/a.png", "/api/images/c.png",
        ]);
    });

    it("removes only the selected image", async () => {
        await openScene(THREE);
        select("b");

        click("scene-image-remove");

        expect(activeScene().images).toEqual([THREE[0], THREE[2]]);
        expect(outlines()).toHaveLength(0);
        await saveAndReopen(backend, "Plate");
        expect(activeScene().images).toEqual([THREE[0], THREE[2]]);
    });

    it("doesn't change anything when no image is selected", async () => {
        await openScene(THREE);
        select("b");
        $("scene-canvas").dispatchEvent(new MouseEvent("click", { bubbles: true }));

        key("ArrowRight");
        key("Delete");

        expect(activeScene().images).toEqual(THREE);
        expect($("scene-image-toolbar").hidden).toBe(true);
    });
});

describe("Issue 479: complete workflows", () => {
    it("applies every operation to the only image in a scene and reopens it exactly", async () => {
        const solo = [{ id: "solo", src: "/api/images/ilium.png", x: 100, y: 100, width: 200, height: 100 }];
        await openScene(solo);
        select("solo");

        drag(imageNode(0), [150, 150], [250, 200]); // to (200, 150)
        drag(corner("se"), [400, 250], [440, 250]); // 240 x 120 about the center (300, 200)
        click("scene-image-rotate-right-15");
        click("scene-image-flip-vertical");
        click("scene-image-crop-start");
        drag(corner("nw"), [180, 140], [200, 150]);
        click("scene-image-crop-done");
        const edited = clone(activeScene().images);

        expect(edited[0]).toMatchObject({ x: 180, y: 140, width: 240, height: 120, rotation: 15, flipY: true });
        expect(edited[0].cropWidth).toBeLessThan(240);
        await saveAndReopen(backend, "Plate");
        expect(activeScene().images).toEqual(edited);
    });

    it("edits each image of a multi-image scene differently and reopens all of them exactly", async () => {
        await openScene(THREE);

        select("a");
        click("scene-image-flip-horizontal");
        select("c");
        click("scene-image-rotate-right-90");
        drag(imageNode(2), [650, 350], [610, 330]);
        select("b");
        click("scene-image-crop-start");
        drag(corner("nw"), [140, 90], [160, 100]);
        click("scene-image-crop-done");
        click("scene-image-backward");
        const edited = clone(activeScene().images);

        expect(edited.map((image) => image.id)).toEqual(["b", "a", "c"]);
        expect(edited[1]).toEqual({ ...THREE[0], flipX: true });
        expect(edited[2]).toEqual({ ...THREE[2], x: 560, y: 280, rotation: 90 });
        expect(edited[0]).toMatchObject({ cropX: 20, cropY: 10, cropWidth: 180, cropHeight: 90 });

        await saveAndReopen(backend, "Plate");
        expect(activeScene().images).toEqual(edited);
    });
});

describe("Issue 479: the scene's edges and limits", () => {
    it("lets an image go past the top-left edge, grows the canvas to show it, and keeps it there", async () => {
        await openScene(THREE);
        select("a");

        drag(imageNode(0), [60, 60], [-40, 10]);

        expect(byId("a")).toMatchObject({ x: -60, y: -10 });
        const [viewX, viewY] = canvasSvg().getAttribute("viewBox").split(" ").map(Number);
        expect(viewX).toBeLessThanOrEqual(-60);
        expect(viewY).toBeLessThanOrEqual(-10);
        // Still on the canvas, so it can be selected and brought back.
        expect(outlines()).toHaveLength(1);
        key("ArrowRight", { shiftKey: true });
        expect(byId("a")).toMatchObject({ x: -50, y: -10 });

        await saveAndReopen(backend, "Plate");
        expect(byId("a")).toMatchObject({ x: -50, y: -10 });
        expect(Number(canvasSvg().getAttribute("viewBox").split(" ")[0])).toBeLessThanOrEqual(-50);
    });

    it("grows the canvas when an image is moved past the bottom-right edge", async () => {
        await openScene(THREE);
        select("c");

        drag(imageNode(2), [650, 350], [1050, 650]);

        expect(byId("c")).toMatchObject({ x: 1000, y: 600 });
        const [viewX, viewY, viewWidth, viewHeight] = canvasSvg().getAttribute("viewBox").split(" ").map(Number);
        expect(viewX + viewWidth).toBeGreaterThanOrEqual(1120);
        expect(viewY + viewHeight).toBeGreaterThanOrEqual(760);
    });

    it("stops shrinking an image at 10 scene units on its short side, keeping its proportions", async () => {
        await openScene(THREE);
        select("a");

        drag(corner("se"), [240, 140], [-500, 140]);

        expect(byId("a").height).toBeCloseTo(10);
        expect(byId("a").width).toBeCloseTo(20);
        // Centered where it was.
        expect(byId("a").x + byId("a").width / 2).toBeCloseTo(140);
        expect(byId("a").y + byId("a").height / 2).toBeCloseTo(90);
    });

    it("stops a crop at 10 scene units and keeps it inside the image", async () => {
        await openScene(THREE);
        select("a");
        click("scene-image-crop-start");

        drag(corner("se"), [240, 140], [-500, -500]);
        drag(corner("nw"), [40, 40], [-200, -200]);
        click("scene-image-crop-done");

        expect(byId("a")).toMatchObject({ cropX: 0, cropY: 0, cropWidth: 10, cropHeight: 10, width: 200, height: 100 });
    });

    it("keeps the whole image for later: resetting a crop shows all of it again", async () => {
        await openScene(THREE);
        select("a");
        click("scene-image-crop-start");
        drag(corner("se"), [240, 140], [200, 120]);
        click("scene-image-crop-done");
        await saveAndReopen(backend, "Plate");

        select("a");
        click("scene-image-crop-start");
        click("scene-image-crop-reset");
        click("scene-image-crop-done");

        // The crop covers the whole image again; the source was never changed.
        expect(byId("a")).toEqual({ ...THREE[0], cropX: 0, cropY: 0, cropWidth: 200, cropHeight: 100 });
        expect(imageNode(0).getAttribute("href")).toBe(THREE[0].src);
        expect(imageNode(0).hasAttribute("clip-path")).toBe(false);
    });

    it("turns a full circle back to 0 and wraps below 0 to 345", async () => {
        await openScene(THREE);
        select("c");

        for (let i = 0; i < 4; i += 1) click("scene-image-rotate-right-90");
        expect(byId("c").rotation).toBe(0);
        click("scene-image-rotate-left-15");
        expect(byId("c").rotation).toBe(345);
    });

    it("flips back when flipped twice", async () => {
        await openScene(THREE);
        select("b");

        click("scene-image-flip-horizontal");
        click("scene-image-flip-horizontal");

        expect(byId("b").flipX).toBe(false);
        expect(byId("b").flipY).toBeUndefined();
    });

    it("can't move the back image further back or the front image further forward", async () => {
        await openScene(THREE);

        select("a");
        expect($("scene-image-backward").disabled).toBe(true);
        expect($("scene-image-forward").disabled).toBe(false);
        select("c");
        expect($("scene-image-forward").disabled).toBe(true);
        expect($("scene-image-backward").disabled).toBe(false);
    });
});

describe("Issue 479: overlapping images", () => {
    it("edits the image underneath, reached by clicking again in the same spot, without touching the one on top", async () => {
        await openScene(THREE);
        // (200, 120) is on both "a" and "b"; "b" is on top.
        clickAt(imageNode(1), [200, 120]);
        clickAt(imageNode(1), [200, 120]);
        expect(byId("a")).toBe(activeScene().images[0]);

        click("scene-image-rotate-right-15");
        click("scene-image-forward");

        expect(activeScene().images.map((image) => image.id)).toEqual(["b", "a", "c"]);
        expect(byId("a")).toEqual({ ...THREE[0], rotation: 15 });
        expect(byId("b")).toEqual(THREE[1]);
    });
});
