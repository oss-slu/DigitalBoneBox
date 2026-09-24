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
