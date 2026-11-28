// Issue #478 (parent #477): importing image files into a scene, checked as a
// user does it. Supported files are added to the open scene and kept after
// saving and reopening; unsupported, unreadable, oversized and duplicate files
// are handled clearly. The browser and device checks are in
// docs/scene-editor-testing/README.md.
const {
    $, activeScene, click, createFakeBackend, enterEditor, imageNode, openByName,
    saveAndReopen, startEditor, useCountingUuids, waitFor,
} = require("./helpers/sceneEditorHarness");

const MB = 1024 * 1024;
const dataUrlOf = (file) => file.dataUrl || `data:${file.type};base64,${Buffer.from(file.name).toString("base64")}`;
const file = (name, type, extra = {}) => ({ name, type, size: 1000, ...extra });

let backend;
let naturalSizes;

beforeEach(() => {
    useCountingUuids();
    backend = createFakeBackend();
    // jsdom can't read files or decode images, so FileReader returns a data
    // URL made from the file, and Image "loads" the size set for that URL.
    naturalSizes = new Map();
    window.FileReader = class {
        readAsDataURL(chosen) {
            setTimeout(() => {
                if (chosen.unreadable) {
                    this.onerror();
                    return;
                }
                this.result = dataUrlOf(chosen);
                this.onload();
            }, 0);
        }
    };
    window.Image = class {
        set src(value) {
            setTimeout(() => {
                const size = naturalSizes.get(value);
                if (size === null) {
                    this.onerror();
                    return;
                }
                [this.naturalWidth, this.naturalHeight] = size || [800, 400];
                this.onload();
            }, 0);
        }
    };
    startEditor(backend);
});

afterEach(() => {
    jest.restoreAllMocks();
});

/**
 * Chooses files in the import dialog. Like Chromium, resetting the input's
 * value empties the same FileList the change event handed over, so an import
 * that is still reading it loses the files it hasn't reached yet.
 */
function chooseFiles(files) {
    const input = $("scene-import-input");
    const list = [...files];
    Object.defineProperty(input, "files", { value: list, configurable: true });
    Object.defineProperty(input, "value", {
        configurable: true,
        get: () => "",
        set: (value) => {
            if (value === "") list.length = 0;
        },
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

const importError = () => ($("scene-image-import-error").hidden ? "" : $("scene-image-import-error").textContent);
const imageCount = () => activeScene().images.length;

async function openScene(name = "Plate", content = {}) {
    backend.seed({ name, ...content });
    await enterEditor();
    await openByName(name);
}

/** Waits for an import to finish: its message, or the images it added. */
async function importFiles(files, { expectImages, expectError = false } = {}) {
    chooseFiles(files);
    if (expectImages !== undefined) await waitFor(() => expect(imageCount()).toBe(expectImages));
    if (expectError) await waitFor(() => expect(importError()).not.toBe(""));
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("Issue 478: supported images", () => {
    it.each([
        ["bone.png", "image/png"],
        ["bone.jpg", "image/jpeg"],
        ["bone.gif", "image/gif"],
        ["bone.webp", "image/webp"],
        ["bone.svg", "image/svg+xml"],
    ])("imports %s into the open scene and keeps it after saving and reopening", async (name, type) => {
        await openScene();
        const chosen = file(name, type);

        await importFiles([chosen], { expectImages: 1 });

        expect(importError()).toBe("");
        expect(imageNode(0)).not.toBeNull();
        expect($("scene-save-status").textContent).toBe("Unsaved changes");
        const added = activeScene().images[0];
        expect(added).toEqual({ id: "uuid-1", src: dataUrlOf(chosen), x: 24, y: 24, width: 320, height: 160 });

        await saveAndReopen(backend, "Plate");
        expect(activeScene().images).toEqual([added]);
        expect(imageNode(0).getAttribute("href")).toBe(dataUrlOf(chosen));
    });

    it("imports every file chosen at once, in the order chosen", async () => {
        await openScene();
        const chosen = [file("a.png", "image/png"), file("b.jpg", "image/jpeg"), file("c.webp", "image/webp")];

        await importFiles(chosen, { expectImages: 3 });

        expect(activeScene().images.map((image) => image.src)).toEqual(chosen.map(dataUrlOf));
        expect(activeScene().images.map((image) => [image.x, image.y])).toEqual([[24, 24], [48, 48], [72, 72]]);
        expect(importError()).toBe("");
        await waitFor(() => expect($("scene-editor-status").textContent).toBe("3 images added to the scene. Save to keep them."));
    });

    it("scales a large image down to fit, keeping its proportions, and never scales a small one up", async () => {
        await openScene();
        const wide = file("wide.png", "image/png");
        const tall = file("tall.png", "image/png");
        const small = file("small.png", "image/png");
        naturalSizes.set(dataUrlOf(wide), [4000, 1000]);
        naturalSizes.set(dataUrlOf(tall), [600, 2400]);
        naturalSizes.set(dataUrlOf(small), [90, 60]);

        await importFiles([wide], { expectImages: 1 });
        await importFiles([tall], { expectImages: 2 });
        await importFiles([small], { expectImages: 3 });

        expect(activeScene().images.map((image) => [image.width, image.height])).toEqual([[320, 80], [80, 320], [90, 60]]);
    });
});

describe("Issue 478: files that can't be imported", () => {
    it.each([
        ["notes.pdf", "application/pdf"],
        ["scan.bmp", "image/bmp"],
        ["scan.tiff", "image/tiff"],
        ["photo.heic", "image/heic"],
        ["mystery", ""],
    ])("explains that %s is not supported and adds nothing", async (name, type) => {
        await openScene();

        await importFiles([file(name, type)], { expectError: true });

        expect(importError()).toBe(`1 file skipped: ${name} (unsupported type).`);
        expect(imageCount()).toBe(0);
        expect(scenesModuleHasChanges()).toBe(false);
        expect(backend.calls.filter((call) => call.method !== "GET")).toEqual([]);
    });

    it("explains a file that can't be read, or isn't really an image", async () => {
        await openScene();
        const notAnImage = file("fake.png", "image/png");
        naturalSizes.set(dataUrlOf(notAnImage), null);

        await importFiles([file("locked.png", "image/png", { unreadable: true }), notAnImage], { expectError: true });

        expect(importError()).toBe("2 files skipped: locked.png (could not be read), fake.png (could not be read).");
        expect(imageCount()).toBe(0);
    });

    it("accepts a file of exactly 2 MB and refuses one byte more, before reading it", async () => {
        await openScene();
        const tooLarge = file("over.png", "image/png", { size: 2 * MB + 1 });

        await importFiles([tooLarge, file("exact.png", "image/png", { size: 2 * MB })], { expectImages: 1, expectError: true });

        expect(activeScene().images[0].src).toBe(dataUrlOf(file("exact.png", "image/png")));
        expect(importError()).toBe("1 image added. 1 file skipped: over.png (too large, max 2MB).");
    });

    it("skips a file that would take the scene over its total image size, and still adds one that fits", async () => {
        const nearlyFull = `data:image/png;base64,${"A".repeat(3_799_000 - 22)}`;
        await openScene("Plate", { images: [{ id: "big", src: nearlyFull, x: 0, y: 0, width: 100, height: 100 }] });
        const large = file("large.png", "image/png", { dataUrl: `data:image/png;base64,${"B".repeat(2000)}` });
        const tiny = file("tiny.png", "image/png");

        await importFiles([large, tiny], { expectImages: 2, expectError: true });

        expect(importError()).toBe("1 image added. 1 file skipped: large.png (scene is near its image size limit).");
        expect(activeScene().images.map((image) => image.id)).toEqual(["big", "uuid-1"]);
    });

    it("keeps the supported files when the same import includes ones that can't be imported", async () => {
        await openScene();

        await importFiles(
            [file("a.png", "image/png"), file("notes.pdf", "application/pdf"), file("b.gif", "image/gif"), file("huge.png", "image/png", { size: 3 * MB })],
            { expectImages: 2, expectError: true },
        );

        expect(importError()).toBe("2 images added. 2 files skipped: notes.pdf (unsupported type), huge.png (too large, max 2MB).");
    });
});

describe("Issue 478: duplicate files", () => {
    it("adds the same file again as a separate image, offset so it doesn't hide the first", async () => {
        await openScene();
        const chosen = file("ilium.png", "image/png");

        await importFiles([chosen, chosen], { expectImages: 2 });
        await importFiles([chosen], { expectImages: 3 });

        const images = activeScene().images;
        expect(images.map((image) => image.src)).toEqual([dataUrlOf(chosen), dataUrlOf(chosen), dataUrlOf(chosen)]);
        expect(new Set(images.map((image) => image.id)).size).toBe(3);
        expect(images.map((image) => [image.x, image.y])).toEqual([[24, 24], [48, 48], [72, 72]]);

        await saveAndReopen(backend, "Plate");
        expect(activeScene().images).toEqual(images);
    });

    it("edits one copy without changing the other", async () => {
        await openScene();
        const chosen = file("ilium.png", "image/png");
        await importFiles([chosen, chosen], { expectImages: 2 });
        const [first] = JSON.parse(JSON.stringify(activeScene().images));

        imageNode(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
        click("scene-image-rotate-right-90");
        click("scene-image-flip-horizontal");

        expect(activeScene().images[0]).toEqual(first);
        expect(activeScene().images[1]).toMatchObject({ rotation: 90, flipX: true });
    });
});

describe("Issue 478: images land in the intended scene", () => {
    it("adds images only to the scene that is open, and saves them only there", async () => {
        backend.seed({ name: "Femur", images: [{ id: "femur", src: "/api/images/femur_image.png", x: 0, y: 0, width: 200, height: 400 }] });
        await openScene("Plate");
        const femurBefore = JSON.parse(JSON.stringify(backend.stored("Femur")));

        await importFiles([file("ilium.png", "image/png")], { expectImages: 1 });
        await saveAndReopen(backend, "Plate");

        expect(activeScene().images).toHaveLength(1);
        expect(backend.stored("Plate").images).toHaveLength(1);
        expect(backend.stored("Femur")).toEqual(femurBefore);
        await openByName("Femur");
        expect(activeScene().images.map((image) => image.id)).toEqual(["femur"]);
    });

    it("adds new images after the ones already in the scene, leaving those unchanged", async () => {
        const existing = [
            { id: "a", src: "/api/images/a.png", x: 10, y: 10, width: 100, height: 100, rotation: 15 },
            { id: "b", src: "/api/images/b.png", x: 400, y: 40, width: 120, height: 80, flipX: true },
        ];
        await openScene("Plate", { images: existing });

        await importFiles([file("c.png", "image/png")], { expectImages: 3 });

        expect(activeScene().images.slice(0, 2)).toEqual(existing);
        expect(activeScene().images[2]).toMatchObject({ id: "uuid-1", x: 72, y: 72 });
    });
});

function scenesModuleHasChanges() {
    return $("scene-save-status").textContent === "Unsaved changes";
}
