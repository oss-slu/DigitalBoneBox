import { objectsAt, renderScene } from "../js/sceneCanvas.js";

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

// PR #493 review: annotations imported with a bone's images follow their
// source image (sourceImageId + sourceImageFrame) when it is edited.
describe("renderScene linked annotations", () => {
    const FRAME = { x: 100, y: 100, width: 200, height: 100 };
    const linked = (annotation) => ({ ...annotation, sourceImageId: "img-a", sourceImageFrame: FRAME });
    const label = linked({ id: "t", type: "text", text: "Ilium", x: 150, y: 110, fontSize: 10, source: { type: "legacy-label" } });
    const pointer = linked({ id: "l", type: "arrow", x1: 165, y1: 120, x2: 250, y2: 160, strokeWidth: 1.5, source: { type: "legacy-pointer-line" } });
    const region = linked({
        id: "r",
        type: "polygon",
        points: [[200, 150], [220, 150], [220, 170]],
        source: { type: "legacy-colored-region", imageId: "img-a" },
    });
    const sourceImage = (overrides = {}) => image({ id: "img-a", ...FRAME, ...overrides });

    function render(images, annotations = [label, pointer, region], options) {
        return renderScene({ images, annotations }, options);
    }
    const layer = (svg) => svg.querySelector(".scene-layer-annotations");
    function textCenter(svg) {
        const node = layer(svg).querySelector("text");
        const fontSize = Number(node.getAttribute("font-size"));
        return [
            Number(node.getAttribute("x")) + (node.textContent.length * fontSize * 0.6) / 2,
            Number(node.getAttribute("y")) + fontSize / 2,
        ];
    }
    const parsePoints = (node) => node.getAttribute("points").trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
    const linePointsOf = (svg) => parsePoints(layer(svg).querySelector("polyline"));
    const regionPointsOf = (svg) => parsePoints(layer(svg).querySelector("polygon"));
    function expectPoints(actual, expected) {
        expect(actual).toHaveLength(expected.length);
        actual.forEach(([x, y], i) => {
            expect(x).toBeCloseTo(expected[i][0]);
            expect(y).toBeCloseTo(expected[i][1]);
        });
    }
    // The label's stored center: x 150 + (5 chars * 10 * 0.6) / 2, y 110 + 10 / 2.
    const LABEL_CENTER = [165, 115];
    const LINE = [[165, 120], [250, 160]];
    const REGION = [[200, 150], [220, 150], [220, 170]];
    const shift = (points, dx, dy) => points.map(([x, y]) => [x + dx, y + dy]);
    // 90° about the image center (200, 150), the same direction sceneCanvas rotates images.
    const rotate90 = (points) => points.map(([x, y]) => [200 - (y - 150), 150 + (x - 200)]);

    it("draws linked annotations where they were imported while the image hasn't changed", () => {
        const { svg, unlinked } = render([sourceImage()]);
        expectPoints([textCenter(svg)], [LABEL_CENTER]);
        expectPoints(linePointsOf(svg), LINE);
        expectPoints(regionPointsOf(svg), REGION);
        expect(unlinked).toBe(0);
    });

    it("moves a text label, pointer line, and region with their image", () => {
        const { svg } = render([sourceImage({ x: 150, y: 70 })]);
        expectPoints([textCenter(svg)], shift([LABEL_CENTER], 50, -30));
        expectPoints(linePointsOf(svg), shift(LINE, 50, -30));
        expectPoints(regionPointsOf(svg), shift(REGION, 50, -30));
    });

    it("rotates each annotation type around the image's rotation center", () => {
        const { svg } = render([sourceImage({ rotation: 90 })]);
        expectPoints([textCenter(svg)], rotate90([LABEL_CENTER]));
        expectPoints(linePointsOf(svg), rotate90(LINE));
        expectPoints(regionPointsOf(svg), rotate90(REGION));
        // Text keeps reading left to right instead of turning with the image.
        expect(layer(svg).querySelector("text").getAttribute("transform")).toBeNull();
    });

    it("combines a move with a rotation, rotating about the image's new center", () => {
        const { svg } = render([sourceImage({ x: 150, y: 70, rotation: 90 })]);
        expectPoints(linePointsOf(svg), shift(rotate90(LINE), 50, -30));
    });

    it("scales annotations with a resized image", () => {
        const { svg } = render([sourceImage({ width: 400, height: 200 })]);
        const scaled = (points) => points.map(([x, y]) => [100 + (x - 100) * 2, 100 + (y - 100) * 2]);
        expectPoints([textCenter(svg)], scaled([LABEL_CENTER]));
        expect(Number(layer(svg).querySelector("text").getAttribute("font-size"))).toBeCloseTo(20);
        expectPoints(linePointsOf(svg), scaled(LINE));
        expectPoints(regionPointsOf(svg), scaled(REGION));
    });

    it("mirrors annotations with a flipped image", () => {
        const { svg } = render([sourceImage({ flipX: true })]);
        const mirrored = (points) => points.map(([x, y]) => [400 - x, y]);
        expectPoints(linePointsOf(svg), mirrored(LINE));
        expectPoints(regionPointsOf(svg), mirrored(REGION));
    });

    it("clips colored regions to a cropped image's visible area but keeps labels and lines", () => {
        const cropped = sourceImage({ cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 50 });
        const { svg } = render([cropped]);

        // Crop is non-destructive and keeps the image in place, so coordinates don't change.
        expectPoints(regionPointsOf(svg), REGION);
        expectPoints(linePointsOf(svg), LINE);
        const regionGroup = layer(svg).querySelector("polygon").parentNode;
        const clipId = regionGroup.getAttribute("clip-path").match(/url\(#(.+)\)/)[1];
        expectPoints(parsePoints(svg.querySelector(`#${clipId} polygon`)), [[100, 100], [200, 100], [200, 150], [100, 150]]);
        expect(layer(svg).querySelector("text").parentNode).toBe(layer(svg));
        expect(layer(svg).querySelector("polyline").parentNode).toBe(layer(svg));
    });

    it("clips regions to the crop area as it rotates with the image", () => {
        const cropped = sourceImage({ cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 50, rotation: 90 });
        const { svg } = render([cropped]);
        const clipId = layer(svg).querySelector("polygon").parentNode.getAttribute("clip-path").match(/url\(#(.+)\)/)[1];
        expectPoints(parsePoints(svg.querySelector(`#${clipId} polygon`)), rotate90([[100, 100], [200, 100], [200, 150], [100, 150]]));
    });

    it("shows regions unclipped while that image's crop is being edited", () => {
        const cropped = sourceImage({ cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 50 });
        const { svg } = render([cropped], [region], { selectedIndex: 0, cropMode: true });
        expect(layer(svg).querySelector("polygon").parentNode).toBe(layer(svg));
    });

    it("does not move annotations when a different image is edited", () => {
        const other = image({ id: "img-b", x: 500, y: 300, width: 100, height: 100, rotation: 45, flipX: true });
        const { svg } = render([sourceImage(), other]);
        expectPoints([textCenter(svg)], [LABEL_CENTER]);
        expectPoints(linePointsOf(svg), LINE);
        expectPoints(regionPointsOf(svg), REGION);
    });

    it("leaves annotations without a source image link where they are", () => {
        const unlinkedLabel = { id: "manual", type: "text", text: "Ilium", x: 150, y: 110, fontSize: 10 };
        const { svg, unlinked } = render([sourceImage({ x: 400, rotation: 90 })], [unlinkedLabel]);
        expectPoints([textCenter(svg)], [LABEL_CENTER]);
        expect(unlinked).toBe(0);
    });

    it("draws an annotation unchanged and counts it when its source image is gone", () => {
        const { svg, unlinked, unsupported } = render([image({ id: "img-b" })]);
        expectPoints([textCenter(svg)], [LABEL_CENTER]);
        expectPoints(linePointsOf(svg), LINE);
        expectPoints(regionPointsOf(svg), REGION);
        expect(unlinked).toBe(3);
        expect(unsupported).toBe(0);
    });

    it("never modifies the scene objects it is given", () => {
        const annotations = [label, pointer, region].map((a) => JSON.parse(JSON.stringify(a)));
        const before = JSON.parse(JSON.stringify(annotations));
        render([sourceImage({ x: 150, y: 70, rotation: 90, flipY: true })], annotations);
        expect(annotations).toEqual(before);
    });
});

describe("objectsAt (#441)", () => {
    const at = (scene, point) => objectsAt({ images: [], annotations: [], ...scene }, point);
    const label = (overrides = {}) => ({ type: "text", text: "Ilium", x: 0, y: 0, fontSize: 20, ...overrides });

    it("lists every object under a point, topmost first: later annotations, then later images", () => {
        const scene = {
            images: [image(), image({ x: 50 })],
            annotations: [
                label({ x: 60, y: 10 }),
                { type: "polygon", points: [[40, 0], [160, 0], [160, 90], [40, 90]] },
            ],
        };
        expect(at(scene, [70, 20])).toEqual([
            { kind: "annotation", index: 1 },
            { kind: "annotation", index: 0 },
            { kind: "image", index: 1 },
            { kind: "image", index: 0 },
        ]);
        expect(at(scene, [10, 20])).toEqual([{ kind: "image", index: 0 }]);
        expect(at(scene, [900, 500])).toEqual([]);
    });

    it("tests a rotated image against its rotated outline", () => {
        // 200x100 at the origin turned 90° about (100, 50) covers x 50-150, y -50-150.
        const scene = { images: [image({ rotation: 90 })] };
        expect(at(scene, [100, 140])).toEqual([{ kind: "image", index: 0 }]);
        expect(at(scene, [10, 50])).toEqual([]);
    });

    it("only counts the visible area of a cropped image, as it is flipped", () => {
        const cropped = image({ cropX: 0, cropY: 0, cropWidth: 50, cropHeight: 100 });
        expect(at({ images: [cropped] }, [25, 50])).toEqual([{ kind: "image", index: 0 }]);
        expect(at({ images: [cropped] }, [150, 50])).toEqual([]);
        // Flipped horizontally, the visible strip is drawn at the right-hand end.
        const flipped = { ...cropped, flipX: true };
        expect(at({ images: [flipped] }, [175, 50])).toEqual([{ kind: "image", index: 0 }]);
        expect(at({ images: [flipped] }, [25, 50])).toEqual([]);
    });

    it("hits a line within its click tolerance and a highlight on its fill", () => {
        const scene = {
            annotations: [
                { type: "line", x1: 0, y1: 300, x2: 200, y2: 300 },
                { type: "polygon", points: [[400, 400], [500, 400], [450, 500]] },
            ],
        };
        expect(at(scene, [100, 305])).toEqual([{ kind: "annotation", index: 0 }]);
        expect(at(scene, [100, 320])).toEqual([]);
        expect(at(scene, [450, 450])).toEqual([{ kind: "annotation", index: 1 }]);
        expect(at(scene, [400, 480])).toEqual([]);
    });

    it("leaves out objects the canvas can't draw", () => {
        const scene = {
            images: [image({ src: "javascript:alert(1)" })],
            annotations: [{ type: "circle", x: 0, y: 0, r: 50 }, { type: "polygon", points: [[0, 0], [100, 100]] }],
        };
        expect(at(scene, [10, 10])).toEqual([]);
    });

    it("finds a linked annotation where it is drawn, following its moved image", () => {
        const frame = { x: 0, y: 0, width: 200, height: 100 };
        const scene = {
            images: [image({ id: "img", x: 300 })],
            annotations: [label({ sourceImageId: "img", sourceImageFrame: frame })],
        };
        expect(at(scene, [305, 5])).toEqual([{ kind: "annotation", index: 0 }, { kind: "image", index: 0 }]);
        expect(at(scene, [5, 5])).toEqual([]);
    });

    it("ignores a colored region outside its image's visible crop", () => {
        const frame = { x: 0, y: 0, width: 200, height: 100 };
        const scene = {
            images: [image({ id: "img", cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100 })],
            annotations: [{
                type: "polygon",
                points: [[0, 0], [200, 0], [200, 100], [0, 100]],
                source: { type: "legacy-colored-region" },
                sourceImageId: "img",
                sourceImageFrame: frame,
            }],
        };
        expect(at(scene, [50, 50])).toEqual([{ kind: "annotation", index: 0 }, { kind: "image", index: 0 }]);
        expect(at(scene, [150, 50])).toEqual([]);
    });
});
