// Rendering validation for the Scene Editor - Issue #470.
// Checks that scenes are drawn the way they are saved: image order, image
// orientation, and image rotation, scaling and cropping. The visual review
// and the defects found are in docs/rendering-validation/README.md.
import { objectsAt, renderScene } from "../js/sceneCanvas.js";

function image(id, overrides = {}) {
    return { id, src: `/api/images/${id}.jpg`, x: 0, y: 0, width: 200, height: 100, ...overrides };
}

const drawnImageIds = (svg) =>
    [...svg.querySelectorAll(".scene-image-object")].map((node) => node.getAttribute("href").replace(/^\/api\/images\/|\.jpg$/g, ""));

// Two overlapping images with a colored region linked to the bottom one.
function overlappingScene() {
    const back = image("back", { x: 0, y: 0, width: 200, height: 200 });
    const front = image("front", { x: 100, y: 100, width: 200, height: 200 });
    return {
        images: [back, front],
        annotations: [
            {
                type: "polygon",
                points: [[120, 120], [180, 120], [180, 180], [120, 180]],
                sourceImageId: "back",
                sourceImageFrame: { x: 0, y: 0, width: 200, height: 200 },
            },
        ],
    };
}

describe("Issue 472: image ordering", () => {
    it("draws images in the order of scene.images, first at the back", () => {
        const scene = { images: [image("a"), image("b"), image("c")], annotations: [] };
        const { svg } = renderScene(scene);

        expect(drawnImageIds(svg)).toEqual(["a", "b", "c"]);
        const indexes = [...svg.querySelectorAll(".scene-image-object")].map((node) => node.getAttribute("data-scene-image-index"));
        expect(indexes).toEqual(["0", "1", "2"]);
    });

    it("draws the new order after images are reordered", () => {
        const scene = { images: [image("a"), image("b"), image("c")], annotations: [] };
        scene.images.reverse();

        expect(drawnImageIds(renderScene(scene).svg)).toEqual(["c", "b", "a"]);
    });

    it("draws every annotation above every image", () => {
        const { svg } = renderScene(overlappingScene());
        const layers = [...svg.children].map((node) => node.getAttribute("class")).filter(Boolean);

        expect(layers.indexOf("scene-layer-images")).toBeLessThan(layers.indexOf("scene-layer-annotations"));
    });

    it("picks overlapping images in the same order they are drawn (topmost first)", () => {
        const scene = overlappingScene();
        scene.annotations = [];

        expect(objectsAt(scene, [150, 150])).toEqual([
            { kind: "image", index: 1 },
            { kind: "image", index: 0 },
        ]);
        scene.images.reverse();
        expect(objectsAt(scene, [150, 150])).toEqual([
            { kind: "image", index: 1 },
            { kind: "image", index: 0 },
        ]);
        expect(drawnImageIds(renderScene(scene).svg)).toEqual(["front", "back"]);
    });

    // Known limitation, recorded as R1 in docs/rendering-validation/README.md:
    // annotations are not stacked with their own image, so a region on the
    // back image is drawn over the front image where the two overlap.
    it("documents that a back image's colored region is drawn over a front image", () => {
        const scene = overlappingScene();

        expect(objectsAt(scene, [150, 150])[0]).toEqual({ kind: "annotation", index: 0 });
    });
});

describe("Issue 471: image orientation", () => {
    const drawn = (overrides) => renderScene({ images: [image("a", overrides)], annotations: [] }).svg.querySelector(".scene-image-object");

    it("draws an image with no rotation or flip exactly as the file is", () => {
        const node = drawn({ rotation: 0 });

        expect(node.hasAttribute("transform")).toBe(false);
        expect(node.getAttribute("preserveAspectRatio")).toBe("none");
        expect([node.getAttribute("width"), node.getAttribute("height")]).toEqual(["200", "100"]);
    });

    it("draws a saved rotation and flip about the image's center", () => {
        // 200x100 at (0, 0): the center is (100, 50).
        expect(drawn({ rotation: 90 }).getAttribute("transform")).toBe("rotate(90 100 50)");
        expect(drawn({ flipX: true }).getAttribute("transform")).toBe("translate(100 50) scale(-1 1) translate(-100 -50)");
        expect(drawn({ flipY: true }).getAttribute("transform")).toBe("translate(100 50) scale(1 -1) translate(-100 -50)");
    });

    it("flips first and then rotates, so a flipped image turns the same way as an unflipped one", () => {
        // SVG applies the right-most transform first.
        expect(drawn({ rotation: 90, flipX: true }).getAttribute("transform"))
            .toBe("rotate(90 100 50) translate(100 50) scale(-1 1) translate(-100 -50)");
    });
});

describe("Issue 473: image rotation, scaling, and cropping", () => {
    const outline = (svg) => svg.querySelector(".scene-selection-outline, .scene-crop-outline")
        .getAttribute("points").split(" ").map((point) => point.split(",").map(Number));
    const handle = (svg, corner) => {
        const node = svg.querySelector(`[data-corner="${corner}"]`);
        return [Number(node.getAttribute("x")) + 5, Number(node.getAttribute("y")) + 5];
    };
    const distance = ([ax, ay], [bx, by]) => Math.hypot(bx - ax, by - ay);
    const expectPoints = (actual, expected) => {
        expect(actual).toHaveLength(expected.length);
        actual.forEach(([x, y], index) => {
            expect(x).toBeCloseTo(expected[index][0]);
            expect(y).toBeCloseTo(expected[index][1]);
        });
    };

    it("keeps an image's proportions at every rotation", () => {
        for (const rotation of [0, 15, 45, 90, 180, 270, -30]) {
            const { svg } = renderScene({ images: [image("a", { rotation })], annotations: [] }, { selectedIndex: 0 });
            const [tl, tr, br] = outline(svg);

            expect(distance(tl, tr)).toBeCloseTo(200);
            expect(distance(tr, br)).toBeCloseTo(100);
        }
    });

    it("clips a cropped image to its crop area and rotates the crop with the image", () => {
        const { svg } = renderScene({
            images: [image("a", { x: 100, y: 100, rotation: 90, cropX: 20, cropY: 10, cropWidth: 100, cropHeight: 50 })],
            annotations: [],
        });
        const node = svg.querySelector(".scene-image-object");
        const clip = svg.querySelector(`${node.getAttribute("clip-path").slice(4, -1)} rect`);

        expect(node.parentNode.getAttribute("transform")).toBe("rotate(90 200 150)");
        expect(["x", "y", "width", "height"].map((name) => Number(clip.getAttribute(name)))).toEqual([120, 110, 100, 50]);
        expect([node.getAttribute("width"), node.getAttribute("height")]).toEqual(["200", "100"]);
    });

    it("outlines the part of a flipped, cropped image that is actually shown", () => {
        // The left quarter of the file is kept. Flipped horizontally, it is
        // drawn on the right: x 150 to 200.
        const scene = { images: [image("a", { flipX: true, cropX: 0, cropY: 0, cropWidth: 50, cropHeight: 100 })], annotations: [] };
        const { svg } = renderScene(scene, { selectedIndex: 0 });

        expectPoints(outline(svg), [[200, 0], [150, 0], [150, 100], [200, 100]]);
        expect(objectsAt(scene, [175, 50])).toEqual([{ kind: "image", index: 0 }]);
        expect(objectsAt(scene, [25, 50])).toEqual([]);
    });

    it("puts each handle on the corner it moves when the image is flipped", () => {
        const scene = { images: [image("a", { flipX: true, flipY: true })], annotations: [] };
        const { svg } = renderScene(scene, { selectedIndex: 0 });

        // The image's own top-left corner is drawn at the bottom right.
        expectPoints([handle(svg, "nw")], [[200, 100]]);
        expectPoints([handle(svg, "se")], [[0, 0]]);
    });

    it("outlines the draft crop where it is drawn while a flipped image's crop is edited", () => {
        const scene = { images: [image("a", { flipY: true, cropX: 0, cropY: 0, cropWidth: 200, cropHeight: 40 })], annotations: [] };
        const { svg } = renderScene(scene, { selectedIndex: 0, cropMode: true });

        expectPoints(outline(svg), [[0, 100], [200, 100], [200, 60], [0, 60]]);
    });
});
