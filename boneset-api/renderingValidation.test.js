// Rendering validation for imported bone images - Issue #470.
// The renderer checks are in templates/tests/sceneRendering.test.js, and the
// review and defects found are in docs/rendering-validation/README.md.
const fs = require("fs");
const path = require("path");
const { buildLegacyImages } = require("./legacyImport");
const { listItems } = require("./scripts/migration-report");

const IMAGES_DIR = path.join(__dirname, "data", "images");
const LONG_TEST = 30000; // going through every item can take longer than Jest's default 5 seconds

/**
 * The EXIF orientation tag (1-8) of an image file, or null if it has none.
 * Reads JPEG APP1 "Exif" segments and PNG "eXIf" chunks.
 */
function exifOrientation(buffer) {
    const readTiff = (start) => {
        const littleEndian = buffer.toString("ascii", start, start + 2) === "II";
        const read16 = (at) => (littleEndian ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
        const read32 = (at) => (littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
        const ifd = start + read32(start + 4);
        const count = read16(ifd);
        for (let i = 0; i < count; i += 1) {
            const entry = ifd + 2 + i * 12;
            if (read16(entry) === 0x0112) return read16(entry + 8);
        }
        return null;
    };

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            if (marker === 0xe1 && buffer.toString("ascii", offset + 4, offset + 8) === "Exif") return readTiff(offset + 10);
            if (marker === 0xda) break; // image data starts; no more metadata
            offset += 2 + length;
        }
        return null;
    }
    if (buffer.toString("ascii", 1, 4) === "PNG") {
        let offset = 8;
        while (offset + 8 <= buffer.length) {
            const length = buffer.readUInt32BE(offset);
            const type = buffer.toString("ascii", offset + 4, offset + 8);
            if (type === "eXIf") return readTiff(offset + 8);
            if (type === "IDAT" || type === "IEND") break;
            offset += 12 + length;
        }
    }
    return null;
}

// A JPEG header with only an EXIF orientation tag (big-endian TIFF).
function jpegWithOrientation(orientation) {
    const tiff = Buffer.from([
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, first IFD at 8
        0x00, 0x01, // one entry
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT
        0x00, 0x00, 0x00, 0x00, // no next IFD
    ]);
    const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(exif.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, exif, Buffer.from([0xff, 0xda])]);
}

describe("Issue 471: image orientation", () => {
    it("reads the EXIF orientation of a JPEG", () => {
        expect(exifOrientation(jpegWithOrientation(6))).toBe(6);
        expect(exifOrientation(jpegWithOrientation(1))).toBe(1);
        expect(exifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda]))).toBeNull();
    });

    // Imported images are sized from the file's stored width and height, but
    // browsers turn an image to match its EXIF orientation. A file with an
    // orientation other than 1 would be drawn turned and stretched.
    it("has no image file that browsers would turn on their own", () => {
        const files = fs.readdirSync(IMAGES_DIR).filter((file) => /\.(jpe?g|png)$/i.test(file));
        expect(files.length).toBeGreaterThan(100);
        const turned = files.filter((file) => {
            const orientation = exifOrientation(fs.readFileSync(path.join(IMAGES_DIR, file)));
            return orientation !== null && orientation !== 1;
        });
        expect(turned).toEqual([]);
    });

    it("imports every image upright and unflipped, the way the file is", async () => {
        let count = 0;
        for (const item of listItems()) {
            const imported = await buildLegacyImages(item.id).catch(() => null);
            for (const image of imported ? imported.images : []) {
                expect(image.rotation).toBe(0);
                expect(image.flipX).toBeUndefined();
                expect(image.flipY).toBeUndefined();
                count += 1;
            }
        }
        expect(count).toBeGreaterThan(300);
    }, LONG_TEST);
});
