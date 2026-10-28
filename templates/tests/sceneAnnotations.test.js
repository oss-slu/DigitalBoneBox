// Geometry for editing annotations (Issue #426: #427-#438), and storing an
// edit made on a drawn annotation back into its own coordinates.
import { displayedAnnotation, renderScene, storeAnnotationGeometry, textBox } from "../js/sceneCanvas.js";
import {
    anchorOnBox,
    clampHighlightOpacity,
    isPointerLineFor,
    labelEndIndex,
    moveAnnotationPoint,
    reanchorPointerLine,
    resizeText,
    toColorInputValue,
    translateAnnotation,
} from "../js/sceneAnnotations.js";

// Stored coordinates are rounded to 0.01, so a point drawn through a 2x image
// lands within a few hundredths of a pixel of where it was put.
const expectPoint = (actual, [x, y]) => {
    expect(actual[0]).toBeCloseTo(x, 1);
    expect(actual[1]).toBeCloseTo(y, 1);
};

describe("textBox", () => {
    it("measures one line as fontSize tall, as before multi-line labels", () => {
        expect(textBox({ text: "Ilium", x: 10, y: 20, fontSize: 20 })).toMatchObject({
            x: 10, y: 20, width: 5 * 20 * 0.6, height: 20, lines: ["Ilium"],
        });
    });

    it("sizes several lines by the longest line and the line count", () => {
        const box = textBox({ text: "Iliac\nCrest of ilium", x: 0, y: 0, fontSize: 10 });
        expect(box.width).toBeCloseTo(14 * 10 * 0.6);
        expect(box.height).toBeCloseTo(10 + 10 * 1.2);
    });
});

describe("editing displayed geometry", () => {
    it("moves text, lines, and polygons without changing the original", () => {
        const text = { type: "text", text: "A", x: 1, y: 2 };
        expect(translateAnnotation(text, 5, -2)).toMatchObject({ x: 6, y: 0 });
        expect(text).toMatchObject({ x: 1, y: 2 });

        const line = { type: "line", x1: 0, y1: 0, x2: 10, y2: 10 };
        expect(translateAnnotation(line, 1, 2)).toMatchObject({ x1: 1, y1: 2, x2: 11, y2: 12 });

        const polygon = { type: "polygon", points: [[0, 0], [10, 0], [0, 10]] };
        expect(translateAnnotation(polygon, 3, 4).points).toEqual([[3, 4], [13, 4], [3, 14]]);
    });

    it("moves one line end or polygon corner", () => {
        const arrow = { type: "arrow", x1: 0, y1: 0, x2: 10, y2: 10 };
        expect(moveAnnotationPoint(arrow, 1, 5, 0)).toMatchObject({ x1: 0, y1: 0, x2: 15, y2: 10 });
        const polygon = { type: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] };
        expect(moveAnnotationPoint(polygon, 2, 0, 5).points).toEqual([[0, 0], [10, 0], [0, 15]]);
        expect(moveAnnotationPoint(polygon, 7, 1, 1)).toBe(polygon);
    });

    it("keeps resized text readable", () => {
        expect(resizeText({ type: "text", text: "A", fontSize: 18 }, 2).fontSize).toBe(8);
        expect(resizeText({ type: "text", text: "A", fontSize: 18 }, 999).fontSize).toBe(200);
        expect(resizeText({ type: "text", text: "A", fontSize: 18 }, 30).fontSize).toBe(30);
    });

    it("keeps a highlight see-through", () => {
        expect(clampHighlightOpacity(1)).toBe(0.8);
        expect(clampHighlightOpacity(0)).toBe(0.1);
    });

    it("turns colors into values a color input can show", () => {
        expect(toColorInputValue("#F97316", "#000000")).toBe("#f97316");
        expect(toColorInputValue("#abc", "#000000")).toBe("#aabbcc");
        expect(toColorInputValue("rgba(255, 0, 0, 0.5)", "#000000")).toBe("#000000");
        expect(toColorInputValue(undefined, "#123456")).toBe("#123456");
    });
});

describe("pointer lines", () => {
    const box = { x: 100, y: 100, width: 60, height: 20 };

    it("anchors on the label's edge nearest the target", () => {
        expect(anchorOnBox(box, [300, 110])).toEqual([160, 110]);
        expect(anchorOnBox(box, [130, 0])).toEqual([130, 100]);
        expect(anchorOnBox(box, [0, 0])).toEqual([100, 100]);
        // From inside the box: the middle of the nearest edge.
        expect(anchorOnBox(box, [105, 110])).toEqual([100, 110]);
    });

    it("recognizes created and imported pointer lines", () => {
        const label = { id: "label-1", type: "text", source: { type: "legacy-label", boneId: "ilium", annotationId: "a1" }, sourceImageId: "img" };
        expect(isPointerLineFor({ type: "line", labelId: "label-1" }, label)).toBe(true);
        expect(isPointerLineFor({ type: "line", labelId: "other" }, label)).toBe(false);
        const imported = {
            type: "arrow",
            source: { type: "legacy-pointer-line", boneId: "ilium", annotationId: "a1" },
            sourceImageId: "img",
        };
        expect(isPointerLineFor(imported, label)).toBe(true);
        expect(isPointerLineFor({ ...imported, sourceImageId: "other-copy" }, label)).toBe(false);
        expect(isPointerLineFor({ type: "polygon", labelId: "label-1" }, label)).toBe(false);
    });

    it("finds the label end of a line: the first point of a created one, otherwise the nearer end", () => {
        expect(labelEndIndex({ type: "line", labelId: "x", x1: 500, y1: 500, x2: 130, y2: 110 }, box)).toBe(0);
        expect(labelEndIndex({ type: "line", x1: 500, y1: 500, x2: 130, y2: 110 }, box)).toBe(1);
    });

    it("moves the label end back onto a resized label's edge", () => {
        const label = { type: "text", text: "Ilium", x: 100, y: 100, fontSize: 20 }; // 60 x 20
        const line = { type: "line", labelId: "x", x1: 160, y1: 110, x2: 300, y2: 110 };
        const bigger = { ...label, fontSize: 40 }; // 120 x 40
        expect(reanchorPointerLine(line, bigger)).toMatchObject({ x1: 220, y1: 110, x2: 300, y2: 110 });
    });
});

describe("storeAnnotationGeometry", () => {
    it("stores an unlinked annotation's edit as-is, in its own format", () => {
        const scene = { images: [], annotations: [] };
        const line = { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 };
        storeAnnotationGeometry(line, moveAnnotationPoint(line, 1, 5, 5), scene);
        expect(line).toEqual({ type: "line", x1: 0, y1: 0, x2: 15, y2: 5 });

        const region = { type: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] };
        storeAnnotationGeometry(region, translateAnnotation(region, 1, 1), scene);
        expect(region.points).toEqual([{ x: 1, y: 1 }, { x: 11, y: 1 }, { x: 1, y: 11 }]);
    });

    // An image moved, scaled 2x, flipped, and rotated since the annotations
    // were linked to it: an edit made where they are drawn must be stored in
    // the original frame and drawn exactly where the user put it.
    const image = { id: "img", src: "/a.png", x: 300, y: 200, width: 200, height: 100, rotation: 30, flipX: true };
    const frame = { x: 0, y: 0, width: 100, height: 50 };
    const linked = (annotation) => ({ ...annotation, sourceImageId: "img", sourceImageFrame: { ...frame } });

    it("maps a moved linked line back into its frame", () => {
        const line = linked({ type: "line", x1: 10, y1: 10, x2: 40, y2: 20, strokeWidth: 2 });
        const scene = { images: [image], annotations: [line] };
        const shown = displayedAnnotation(line, scene);
        const moved = translateAnnotation(shown, 25, -15);

        storeAnnotationGeometry(line, moved, scene);

        expect(line.sourceImageFrame).toEqual(frame);
        expect(Object.keys(line)).toEqual(expect.arrayContaining(["x1", "y1", "x2", "y2"]));
        expect(line.points).toBeUndefined();
        const redrawn = displayedAnnotation(line, scene).points;
        expectPoint(redrawn[0], moved.points[0]);
        expectPoint(redrawn[1], moved.points[1]);
        expect(line.strokeWidth).toBeCloseTo(2);
    });

    it("maps a resized linked label back into its frame and keeps its drawn position", () => {
        const label = linked({ type: "text", text: "Ilium", x: 20, y: 10, fontSize: 10 });
        const scene = { images: [image], annotations: [label] };
        const resized = resizeText(translateAnnotation(displayedAnnotation(label, scene), 12, 7), 30);

        storeAnnotationGeometry(label, resized, scene);

        const redrawn = displayedAnnotation(label, scene);
        expect(redrawn.fontSize).toBeCloseTo(30);
        expect(redrawn.x).toBeCloseTo(resized.x, 1);
        expect(redrawn.y).toBeCloseTo(resized.y, 1);
        expect(label.fontSize).toBeCloseTo(15);
    });
});

describe("renderScene annotation editing support", () => {
    const scene = {
        images: [],
        annotations: [
            { type: "text", text: "Two\nlines", x: 10, y: 10, fontSize: 20 },
            { type: "line", x1: 0, y1: 0, x2: 50, y2: 50 },
            { type: "polygon", points: [[0, 0], [40, 0], [0, 40]], fill: "#ff0000", fillOpacity: 0.3 },
        ],
    };

    it("tags each annotation with its index and adds easy click targets", () => {
        const { svg } = renderScene(scene);
        const tagged = [...svg.querySelectorAll("[data-scene-annotation-index]")].map((node) => node.dataset.sceneAnnotationIndex);
        expect(new Set(tagged)).toEqual(new Set(["0", "1", "2"]));
        expect(svg.querySelector("path.scene-annotation-hit-line").getAttribute("d")).toBe("M 0 0 L 50 50");
        expect(svg.querySelector("rect.scene-annotation-hit")).not.toBeNull();
    });

    it("draws each line of a multi-line label", () => {
        const { svg } = renderScene(scene);
        const lines = [...svg.querySelectorAll("text tspan")].map((tspan) => tspan.textContent);
        expect(lines).toEqual(["Two", "lines"]);
    });

    it("draws a highlight's fill opacity", () => {
        const { svg } = renderScene(scene);
        expect(svg.querySelector("polygon").getAttribute("fill-opacity")).toBe("0.3");
    });

    it("shows a resize handle on a selected label and a handle on each point of a selected shape", () => {
        expect(renderScene(scene, { selectedAnnotationIndex: 0 }).svg
            .querySelectorAll("[data-annotation-handle=\"resize\"]")).toHaveLength(1);
        expect(renderScene(scene, { selectedAnnotationIndex: 1 }).svg
            .querySelectorAll("[data-annotation-handle=\"point\"]")).toHaveLength(2);
        expect(renderScene(scene, { selectedAnnotationIndex: 2 }).svg
            .querySelectorAll("[data-annotation-handle=\"point\"]")).toHaveLength(3);
        expect(renderScene(scene).svg.querySelectorAll("[data-annotation-handle]")).toHaveLength(0);
    });

    it("draws a shape that is still being drawn", () => {
        const { svg } = renderScene(scene, { draft: { type: "polygon", points: [[0, 0], [10, 0], [10, 10]] } });
        expect(svg.querySelectorAll(".scene-draft-point")).toHaveLength(3);
        expect(svg.querySelector("[data-draft-start]")).not.toBeNull();
        expect(svg.querySelector(".scene-draft-closing")).not.toBeNull();
    });
});
