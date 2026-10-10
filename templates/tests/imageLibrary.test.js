import { listExistingImages, toSceneImage } from "../js/imageLibrary.js";
import { renderScene } from "../js/sceneCanvas.js";

const ILIUM_ENTRY = {
    filename: "ilium_image1.jpg",
    url: "/api/images/ilium_image1.jpg",
    width: 235,
    height: 371,
    usedBy: ["ilium"],
};

describe("toSceneImage", () => {
    it("references the existing image by its normal URL", () => {
        expect(toSceneImage(ILIUM_ENTRY).src).toBe("/api/images/ilium_image1.jpg");
    });

    it("keeps the natural size of an image that already fits", () => {
        const image = toSceneImage(ILIUM_ENTRY, { x: 10, y: 20 });
        expect(image).toMatchObject({ x: 10, y: 20, width: 235, height: 371, rotation: 0 });
    });

    it("scales a large image down and keeps its aspect ratio", () => {
        const image = toSceneImage({ ...ILIUM_ENTRY, width: 1200, height: 600 }, { maxSize: 480 });
        expect(image.width).toBe(480);
        expect(image.height).toBe(240);
    });

    it("uses a square placeholder size when the catalog has no size", () => {
        const image = toSceneImage({ ...ILIUM_ENTRY, width: null, height: null }, { maxSize: 300 });
        expect(image.width).toBe(300);
        expect(image.height).toBe(300);
    });

    it("gives each placed image its own id", () => {
        expect(toSceneImage(ILIUM_ENTRY).id).not.toBe(toSceneImage(ILIUM_ENTRY).id);
    });

    it("is drawn by the scene canvas", () => {
        const { svg, rendered, unsupported } = renderScene({ images: [toSceneImage(ILIUM_ENTRY)], annotations: [] });
        expect(rendered).toBe(1);
        expect(unsupported).toBe(0);
        expect(svg.querySelector("image").getAttribute("href")).toBe("/api/images/ilium_image1.jpg");
    });
});

describe("listExistingImages", () => {
    afterEach(() => {
        delete global.fetch;
    });

    it("requests the whole catalog", async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ images: [ILIUM_ENTRY] }) });
        await expect(listExistingImages()).resolves.toEqual([ILIUM_ENTRY]);
        expect(global.fetch).toHaveBeenCalledWith("/api/image-catalog");
    });

    it("requests one bone's images", async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ images: [] }) });
        await listExistingImages("ilium");
        expect(global.fetch).toHaveBeenCalledWith("/api/image-catalog?boneId=ilium");
    });

    it("throws when the catalog can't be loaded", async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
        await expect(listExistingImages()).rejects.toThrow("HTTP 500");
    });
});