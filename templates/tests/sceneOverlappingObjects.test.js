// Issue #481 (parent #477): selecting and editing objects that overlap. Every
// object in a stack can be reached on purpose (clicking again in the same
// spot, Alt+click, or Tab through the objects), the selected one is clearly
// marked, and editing it leaves the others exactly as they were. The browser
// checks are in docs/scene-editor-testing/README.md.
const {
    $, activeScene, annotationNode, clickAt, clone, createFakeBackend, drag, enterEditor, imageNode, key,
    openByName, outlines, saveAndReopen, startEditor, useCountingUuids, waitFor,
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

// Five objects over one spot, (310, 226): from the top, a label, a line, a
// highlight, image "b" and image "a".
const STACK = {
    images: [
        { id: "a", src: "/api/images/a.png", x: 100, y: 100, width: 300, height: 200 },
        { id: "b", src: "/api/images/b.png", x: 200, y: 150, width: 300, height: 200 },
    ],
    annotations: [
        { id: "poly", type: "polygon", points: [[250, 180], [450, 180], [450, 330], [250, 330]] },
        { id: "line", type: "line", x1: 150, y1: 226, x2: 420, y2: 226 },
        { id: "label", type: "text", text: "Overlap", x: 300, y: 220 },
    ],
};
const SPOT = [310, 226];
const TOP_DOWN = ["label", "line", "poly", "b", "a"];

async function openStack() {
    backend.seed({ name: "Plate", ...clone(STACK) });
    await enterEditor();
    await openByName("Plate");
}

/** The id of each object drawn as selected. */
function selectedIds() {
    const scene = activeScene();
    const ids = new Set();
    document.querySelectorAll("#scene-canvas .is-selected").forEach((node) => {
        if (node.dataset.sceneImageIndex !== undefined) ids.add(scene.images[Number(node.dataset.sceneImageIndex)].id);
        if (node.dataset.sceneAnnotationIndex !== undefined) ids.add(scene.annotations[Number(node.dataset.sceneAnnotationIndex)].id);
    });
    return [...ids];
}
const selected = () => {
    const ids = selectedIds();
    return ids.length === 1 ? ids[0] : ids;
};
/** Clicks the stack where all five objects overlap; the browser reports the label as clicked. */
const clickStack = (options) => clickAt(annotationNode(2), SPOT, options);
/** Selects one object of the stack by clicking in the same spot until it is selected. */
function reach(id) {
    key("Escape");
    for (let i = 0; i < TOP_DOWN.length && selected() !== id; i += 1) clickStack();
    expect(selected()).toBe(id);
}
const objectById = (id) => [...activeScene().images, ...activeScene().annotations].find((object) => object.id === id);
const othersThan = (id) => [...STACK.images, ...STACK.annotations].filter((object) => object.id !== id);
const currentOthersThan = (id) => [...activeScene().images, ...activeScene().annotations].filter((object) => object.id !== id);

describe("Issue 481: every overlapping object can be selected on purpose", () => {
    it("selects each object down the stack on clicks in the same spot, then wraps to the top", async () => {
        await openStack();
        const order = [];
        for (let i = 0; i < 6; i += 1) {
            clickStack();
            order.push(selected());
        }
        expect(order).toEqual([...TOP_DOWN, "label"]);
    });

    it("steps down the stack with Alt+click", async () => {
        await openStack();
        const order = [];
        clickStack();
        for (let i = 0; i < 5; i += 1) {
            clickAt(annotationNode(2), [SPOT[0] + 20 * (i % 2), SPOT[1]], { altKey: true });
            order.push(selected());
        }
        expect(order).toEqual(["line", "poly", "b", "a", "label"]);
    });

    it("reaches every object with Tab, from the top of the stack down, and back with Shift+Tab", async () => {
        await openStack();
        $("scene-canvas").focus();
        const order = [];
        for (let i = 0; i < 5; i += 1) {
            key("Tab");
            order.push(selected());
        }
        expect(order).toEqual(TOP_DOWN);
        key("Tab", { shiftKey: true });
        expect(selected()).toBe("b");
    });

    it("selects the topmost object again after a click somewhere else", async () => {
        await openStack();
        reach("a");

        clickAt(imageNode(0), [120, 120]);
        expect(selected()).toBe("a");
        clickStack();
        expect(selected()).toBe("label");
    });
});

describe("Issue 481: the selected object is clearly marked", () => {
    it("marks only the selected object, outlines it, and says which one it is", async () => {
        await openStack();

        for (const id of TOP_DOWN) {
            reach(id);
            expect(selectedIds()).toEqual([id]);
            expect(outlines().length).toBeGreaterThanOrEqual(1);
            const isImage = id === "a" || id === "b";
            expect($("scene-image-toolbar").hidden).toBe(!isImage);
            expect($("scene-annotation-toolbar").hidden).toBe(isImage);
        }
    });

    it("outlines a selected image on its own corners, not the objects on top of it", async () => {
        await openStack();
        reach("b");

        const points = outlines()[0].getAttribute("points").trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
        expect(points).toEqual([[200, 150], [500, 150], [500, 350], [200, 350]]);
    });

    it("tells the user how many objects overlap and how to reach the next one", async () => {
        await openStack();
        clickStack();

        expect($("scene-selection-hint").hidden).toBe(false);
        expect($("scene-selection-hint").textContent).toBe(
            "5 objects overlap here. Click again in the same spot, or Alt+click, to select the next one down."
        );
        await waitFor(() => expect($("scene-editor-status").textContent).toBe(
            "Selected label \"Overlap\", 1 of 5 objects. 5 objects overlap here. Click again in the same spot, or Alt+click, to select the next one down."
        ));
    });
});

describe("Issue 481: editing one overlapping object leaves the others alone", () => {
    it.each(TOP_DOWN)("moves %s with the arrow keys without changing anything else, and keeps it after reopening", async (id) => {
        await openStack();
        reach(id);
        const before = clone(objectById(id));

        key("ArrowRight", { shiftKey: true });
        key("ArrowDown");

        expect(objectById(id)).not.toEqual(before);
        expect(currentOthersThan(id)).toEqual(othersThan(id));
        expect(selected()).toBe(id);

        const edited = clone(objectById(id));
        await saveAndReopen(backend, "Plate");
        expect(objectById(id)).toEqual(edited);
        expect(currentOthersThan(id)).toEqual(othersThan(id));
    });

    it.each(TOP_DOWN)("drags %s by pressing on the top of the stack, without moving what is drawn over it", async (id) => {
        await openStack();
        reach(id);

        // The press lands on the label, the topmost object, but the selected object moves.
        drag(annotationNode(2), SPOT, [SPOT[0] + 30, SPOT[1] + 20]);

        expect(currentOthersThan(id)).toEqual(othersThan(id));
        expect(objectById(id)).not.toEqual([...STACK.images, ...STACK.annotations].find((object) => object.id === id));
        expect(selected()).toBe(id);
    });

    it("rotates and flips the image underneath without changing the image or annotations on top", async () => {
        await openStack();
        reach("a");

        $("scene-image-rotate-right-90").click();
        $("scene-image-flip-vertical").click();

        expect(objectById("a")).toEqual({ ...STACK.images[0], rotation: 90, flipY: true });
        expect(currentOthersThan("a")).toEqual(othersThan("a"));
    });

    it("edits the text of a label over other objects without changing them", async () => {
        await openStack();
        reach("label");

        $("scene-annotation-text").value = "Ilium";
        $("scene-annotation-text").dispatchEvent(new Event("input", { bubbles: true }));

        expect(objectById("label")).toEqual({ ...STACK.annotations[2], text: "Ilium" });
        expect(currentOthersThan("label")).toEqual(othersThan("label"));
    });

    it.each(TOP_DOWN)("deletes only %s from the stack", async (id) => {
        await openStack();
        reach(id);

        key("Delete");

        expect(objectById(id)).toBeUndefined();
        expect(currentOthersThan(id)).toEqual(othersThan(id));
    });
});
