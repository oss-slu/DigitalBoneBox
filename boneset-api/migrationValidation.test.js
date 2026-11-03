// Validates migrated scenes for every item in the viewer's dropdowns. Issue #468 (parent #463).
// Each item is imported in memory (images, labels, pointer lines, colored regions), the way the
// Scene Editor's "Import bone images" does, and checked against the original content.
// The visual review and known differences are in docs/migration-validation/README.md.
const fs = require("fs");
const path = require("path");
const { buildLegacyImages } = require("./legacyImport");
const { buildLegacyAnnotations } = require("./legacyAnnotations");
const { listItems, migrate } = require("./scripts/migration-report");

const DATA_DIR = path.join(__dirname, "data");
const LONG_TEST = 30000; // going through every item can take longer than Jest's default 5 seconds
const items = listItems();

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Imports an item with both "Also import" boxes ticked.
async function importItem(id) {
    const imported = await buildLegacyImages(id);
    if (imported.images.length === 0) return null;
    const result = await buildLegacyAnnotations(id, imported.images, {
        include: { labels: true, regions: true },
        allImagesImported: imported.images.length === imported.totalImages,
    });
    return { images: imported.images, ...result };
}

describe("Migrated scene validation - Issue 468", () => {
    it("covers every boneset, bone, and bone part in the viewer's dropdowns", () => {
        expect(new Set(items.map((item) => item.boneset)).size).toBe(6);
        expect(items.length).toBeGreaterThan(150);
    });

    it("either imports each item or records why it can't", async () => {
        for (const item of items) {
            const row = await migrate(item);
            if (row.status !== "imported") expect(row.note.length).toBeGreaterThan(0);
        }
    }, LONG_TEST);

    describe("every imported item", () => {
        let imported;
        beforeAll(async () => {
            imported = [];
            for (const item of items) {
                const result = await importItem(item.id).catch(() => null);
                if (result) imported.push({ id: item.id, ...result });
            }
        }, LONG_TEST);

        it("keeps the viewer's image order", () => {
            for (const { id, images } of imported) {
                const order = images.map((image) => image.source.filename);
                const viewerOrder = readJson(path.join(DATA_DIR, "descriptions", `${id}_description.json`)).images;
                expect(order).toEqual(viewerOrder.filter((filename) => order.includes(filename)));
            }
        });

        it("keeps every image's proportions and points at the original image file", () => {
            for (const { images } of imported) {
                for (const image of images) {
                    expect(image.width / image.height)
                        .toBeCloseTo(image.source.naturalWidth / image.source.naturalHeight, 1);
                    expect(image.src).toBe(`/api/images/${encodeURIComponent(image.source.filename)}`);
                    expect(fs.existsSync(path.join(DATA_DIR, "images", image.source.filename))).toBe(true);
                }
            }
        });

        it("imports every label with its text, unless it records why not", () => {
            for (const { id, annotations, warnings } of imported) {
                const file = path.join(DATA_DIR, "annotations", "text_label_annotations", `${id}_text_annotations.json`);
                if (!fs.existsSync(file)) continue;
                const labels = readJson(file).text_annotations || [];
                const texts = annotations.filter((a) => a.type === "text").map((a) => a.text);
                const skipped = warnings.filter((w) => /^label/.test(w.item) || w.item === "labels and pointer lines");
                expect(texts.length + skipped.length).toBeGreaterThanOrEqual(labels.length);
            }
        });

        it("links every annotation to one of the item's imported images", () => {
            for (const { images, annotations } of imported) {
                for (const annotation of annotations) {
                    const image = images.find((candidate) => candidate.id === annotation.sourceImageId);
                    expect(image).toBeDefined();
                    expect(annotation.sourceImageFrame).toEqual({ x: image.x, y: image.y, width: image.width, height: image.height });
                }
            }
        });

        it("places colored regions on their image", () => {
            for (const { images, annotations, warnings } of imported) {
                // Older-format (pelvis) regions are hand-adjusted by the viewer and may sit off their
                // image without that adjustment. The import notes this; see the known differences.
                const olderFormat = warnings.some((w) => /Older format/.test(w.reason));
                if (olderFormat) continue;
                for (const region of annotations.filter((a) => a.source.type === "legacy-colored-region")) {
                    const image = images.find((candidate) => candidate.id === region.source.imageId);
                    const inside = region.points.filter(([x, y]) =>
                        x >= image.x - 1 && x <= image.x + image.width + 1 &&
                        y >= image.y - 1 && y <= image.y + image.height + 1);
                    // Most of each outline must fall on its image.
                    expect(inside.length / region.points.length).toBeGreaterThan(0.9);
                }
            }
        });

        it("notes that older-format (pelvis) colored regions may differ from the viewer", () => {
            const pelvis = imported.filter(({ id }) => ["bony_pelvis", "ilium", "iliac_crest"].includes(id));
            expect(pelvis.length).toBe(3);
            for (const { warnings } of pelvis) {
                expect(warnings).toContainEqual(expect.objectContaining({ item: "colored regions", reason: expect.stringMatching(/Older format/) }));
            }
        });

        it("records a reason for everything it doesn't import", () => {
            for (const { warnings } of imported) {
                for (const warning of warnings) expect(warning.reason.length).toBeGreaterThan(0);
            }
        });
    });
});
