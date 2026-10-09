import { renderScene } from "../js/sceneCanvas.js";

function viewBox(svg) {
    const [x, y, width, height] = svg.getAttribute("viewBox").split(" ").map(Number);
    return { x, y, width, height };
}

function image(overrides = {}) {
    return { src: "/images/ilium.png", x: 0, y: 0, width: 200, height: 100, ...overrides };
}

describe("renderScene bounds", () => {
    it("keeps the default canvas for an unrotated image at the origin", () => {
        const { svg } = renderScene({ images: [image()], annotations: [] });
        expect(viewBox(svg)).toEqual({ x: 0, y: 0, width: 960, height: 600 });
    });

    it("includes the rotated corners of an image rotated near the origin", () => {
        const { svg } = renderScene({ images: [image({ rotation: 45 })], annotations: [] });
        const box = viewBox(svg);

        // Rotating 200x100 by 45° about (100, 50) moves the corners to
        // x ≈ -6.07 and y ≈ -56.07.
        const halfExtent = (100 + 50) * Math.SQRT1_2;
        const minX = 100 - halfExtent;
        const minY = 50 - halfExtent;

        expect(box.x).toBeLessThanOrEqual(minX);
        expect(box.y).toBeLessThanOrEqual(minY);
        expect(box.x).toBeCloseTo(minX - 40);
        expect(box.y).toBeCloseTo(minY - 40);
        expect(box.x + box.width).toBeGreaterThanOrEqual(960);
        expect(box.y + box.height).toBeGreaterThanOrEqual(600);
    });
});

// Issue #411: images are tagged with their index and can be shown as selected.
describe("renderScene selection support", () => {
    it("tags each rendered image with its index in scene.images", () => {
        const { svg } = renderScene({
            images: [image({ x: 0 }), image({ x: 300 })],
            annotations: [],
        });
        const nodes = svg.querySelectorAll(".scene-image-object");

        expect(nodes).toHaveLength(2);
        expect(nodes[0].getAttribute("data-scene-image-index")).toBe("0");
        expect(nodes[1].getAttribute("data-scene-image-index")).toBe("1");
    });

    it("draws a selection outline for the image at selectedIndex", () => {
        const { svg } = renderScene(
            { images: [image(), image({ x: 300 })], annotations: [] },
            { selectedIndex: 1 }
        );

        const outlines = svg.querySelectorAll(".scene-selection-outline");
        expect(outlines).toHaveLength(1);
    });

    it("draws no selection outline when selectedIndex is omitted", () => {
        const { svg } = renderScene({ images: [image()], annotations: [] });
        expect(svg.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
    });

    it("draws no selection outline for an out-of-range selectedIndex", () => {
        const { svg } = renderScene(
            { images: [image()], annotations: [] },
            { selectedIndex: 5 }
        );
        expect(svg.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
    });
});

// Issues #413/#414: a selected image gets one resize handle per corner.
describe("renderScene resize handles", () => {
    it("draws exactly 4 corner handles for the selected image, tagged nw/ne/se/sw", () => {
        const { svg } = renderScene({ images: [image()], annotations: [] }, { selectedIndex: 0 });
        const handles = svg.querySelectorAll(".scene-resize-handle");

        expect(handles).toHaveLength(4);
        expect([...handles].map((h) => h.dataset.corner)).toEqual(["nw", "ne", "se", "sw"]);
    });

    it("places handles at the image's corners", () => {
        const { svg } = renderScene(
            { images: [image({ x: 10, y: 20, width: 200, height: 100 })], annotations: [] },
            { selectedIndex: 0 }
        );
        const handles = svg.querySelectorAll(".scene-resize-handle");
        const center = (handle) => ({
            x: Number(handle.getAttribute("x")) + Number(handle.getAttribute("width")) / 2,
            y: Number(handle.getAttribute("y")) + Number(handle.getAttribute("height")) / 2,
        });

        expect(center(handles[0])).toEqual({ x: 10, y: 20 }); // nw
        expect(center(handles[2])).toEqual({ x: 210, y: 120 }); // se
    });

    it("draws no resize handles when no image is selected", () => {
        const { svg } = renderScene({ images: [image()], annotations: [] });
        expect(svg.querySelectorAll(".scene-resize-handle")).toHaveLength(0);
    });
});

// Issue #417: non-destructive cropping via an SVG clip-path.
describe("renderScene cropping", () => {
    it("clips the image to the crop rect without changing its own width/height", () => {
        const { svg } = renderScene({
            images: [image({ x: 0, y: 0, width: 200, height: 100, cropX: 20, cropY: 10, cropWidth: 100, cropHeight: 50 })],
            annotations: [],
        });
        const img = svg.querySelector("image");
        expect(img.getAttribute("width")).toBe("200");
        expect(img.getAttribute("height")).toBe("100");
        expect(img.getAttribute("clip-path")).toMatch(/^url\(#/);

        const clipId = img.getAttribute("clip-path").match(/url\(#(.+)\)/)[1];
        const clipRect = svg.querySelector(`#${clipId} rect`);
        expect(clipRect.getAttribute("x")).toBe("20");
        expect(clipRect.getAttribute("y")).toBe("10");
        expect(clipRect.getAttribute("width")).toBe("100");
        expect(clipRect.getAttribute("height")).toBe("50");
    });

    it("applies no clip-path when no crop fields are set", () => {
        const { svg } = renderScene({ images: [image()], annotations: [] });
        expect(svg.querySelector("image").hasAttribute("clip-path")).toBe(false);
    });

    it("uses the crop rect's corners for the selection outline and canvas sizing, not the full image", () => {
        const { svg } = renderScene(
            {
                images: [image({ x: 0, y: 0, width: 200, height: 100, cropX: 0, cropY: 0, cropWidth: 50, cropHeight: 50 })],
                annotations: [],
            },
            { selectedIndex: 0 }
        );
        const outline = svg.querySelector(".scene-selection-outline");
        expect(outline.getAttribute("points")).toBe("0,0 50,0 50,50 0,50");
    });

    it("rotates the crop window together with the image rather than independently of it", () => {
        const { svg } = renderScene({
            images: [image({ x: 0, y: 0, width: 200, height: 200, rotation: 90, cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100 })],
            annotations: [],
        });
        const img = svg.querySelector("image");
        const group = img.parentElement;
        expect(group.tagName.toLowerCase()).toBe("g");
        expect(group.getAttribute("transform")).toMatch(/rotate\(90/);
    });

    it("shows the full uncropped image and a draft crop outline while cropMode is active", () => {
        const { svg } = renderScene(
            {
                images: [image({ x: 0, y: 0, width: 200, height: 100, cropX: 20, cropY: 10, cropWidth: 100, cropHeight: 50 })],
                annotations: [],
            },
            { selectedIndex: 0, cropMode: true }
        );
        expect(svg.querySelector("image").hasAttribute("clip-path")).toBe(false);
        expect(svg.querySelectorAll(".scene-crop-outline")).toHaveLength(1);
        expect(svg.querySelectorAll(".scene-selection-outline")).toHaveLength(0);
        expect(svg.querySelector(".scene-crop-outline").getAttribute("points")).toBe("20,10 120,10 120,60 20,60");
    });

    it("defaults the draft crop rect to the full image when no crop is saved yet", () => {
        const { svg } = renderScene(
            { images: [image({ x: 0, y: 0, width: 200, height: 100 })], annotations: [] },
            { selectedIndex: 0, cropMode: true }
        );
        expect(svg.querySelector(".scene-crop-outline").getAttribute("points")).toBe("0,0 200,0 200,100 0,100");
    });
});
