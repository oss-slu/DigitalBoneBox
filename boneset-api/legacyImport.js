// boneset-api/legacyImport.js
// Turns existing (legacy) bone content into Scene Editor objects. Issue #466 (parent #463).
//
// A bone's images are listed in its description file, in the order the viewer
// shows them. Importing never copies or changes an image file: each scene image
// points at the same /api/images/<filename> URL the viewer uses, and records
// where it came from in `source` so the original record stays traceable.
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { getImageDimensions, imageUrl } = require("./images");

const BONE_ID_PATTERN = /^[a-z0-9_]+$/i;
const MAX_IMAGE_SIZE = 480; // longest side of an imported image, in scene units
const IMAGE_GAP = 40; // space between imported images, and between import rows

const DEFAULT_DIRS = {
    descriptionsDir: path.join(__dirname, "data", "descriptions"),
    imagesDir: path.join(__dirname, "data", "images"),
};

class LegacyImportError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function isValidBoneId(boneId) {
    return typeof boneId === "string" && boneId.length > 0 && boneId.length <= 100 && BONE_ID_PATTERN.test(boneId);
}

/**
 * Scales a size down (never up) so its longest side fits within maxSize,
 * keeping the original proportions.
 */
function fitWithin(width, height, maxSize) {
    const scale = Math.min(1, maxSize / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The y position just below a scene's existing images, so a new import starts
 * on its own row instead of covering what is already there.
 */
function nextRowY(scene) {
    const images = (scene && scene.images) || [];
    if (images.length === 0) return 0;
    const bottom = images.reduce((max, image) => {
        const y = Number(image.y) || 0;
        const height = Number(image.height) || 0;
        return Math.max(max, y + height);
    }, 0);
    return bottom + IMAGE_GAP;
}

async function readDescription(boneId, descriptionsDir) {
    try {
        const raw = await fs.readFile(path.join(descriptionsDir, `${boneId}_description.json`), "utf8");
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new LegacyImportError(404, `No existing content found for boneId: ${boneId}`);
        }
        throw new LegacyImportError(500, `Existing content for ${boneId} could not be read`);
    }
}

/**
 * Builds scene images for a bone's images, or only the selected ones.
 * Images that can't be imported are reported in `warnings` instead of being skipped silently.
 *
 * @param {string} boneId a boneset, bone, or bone part id (e.g. "ilium")
 * @param {object} [options]
 * @param {string} [options.descriptionsDir]
 * @param {string} [options.imagesDir]
 * @param {string[]} [options.filenames] only import these images (default: all of the bone's images)
 * @param {{x: number, y: number}} [options.origin] where the first image is placed
 * @returns {Promise<{ boneId: string, name: string, images: object[], warnings: object[] }>}
 */
async function buildLegacyImages(boneId, options = {}) {
    const { descriptionsDir, imagesDir } = { ...DEFAULT_DIRS, ...options };
    const origin = options.origin || { x: 0, y: 0 };

    if (!isValidBoneId(boneId)) {
        throw new LegacyImportError(400, "Invalid boneId format");
    }

    const description = await readDescription(boneId, descriptionsDir);
    const boneImages = Array.isArray(description.images) ? description.images : [];

    const images = [];
    const warnings = [];

    // Keep the viewer's order, whichever order the images were selected in.
    let filenames = boneImages;
    if (Array.isArray(options.filenames)) {
        const selected = new Set(options.filenames);
        filenames = boneImages.filter((filename) => selected.has(filename));
        for (const filename of selected) {
            if (!boneImages.includes(filename)) {
                warnings.push({ filename: String(filename), reason: "Not an image of this bone" });
            }
        }
    }
    let x = origin.x;

    for (const filename of filenames) {
        // Only plain file names inside the images folder are allowed.
        if (typeof filename !== "string" || filename.length === 0 || path.basename(filename) !== filename) {
            warnings.push({ filename: String(filename), reason: "Invalid image file name" });
            continue;
        }

        let size;
        try {
            size = await getImageDimensions(path.join(imagesDir, filename));
        } catch (error) {
            const reason = error.code === "ENOENT" ? "Image file not found" : "Image file could not be read";
            warnings.push({ filename, reason });
            continue;
        }
        if (!size || !(size.width > 0) || !(size.height > 0)) {
            warnings.push({ filename, reason: "Image size could not be read" });
            continue;
        }

        const fitted = fitWithin(size.width, size.height, MAX_IMAGE_SIZE);
        images.push({
            id: crypto.randomUUID(),
            src: imageUrl(filename),
            x,
            y: origin.y,
            width: fitted.width,
            height: fitted.height,
            rotation: 0,
            source: {
                type: "legacy-image",
                boneId,
                filename,
                naturalWidth: size.width,
                naturalHeight: size.height,
            },
        });
        x += fitted.width + IMAGE_GAP;
    }

    return { boneId, name: description.name || boneId, images, warnings };
}

module.exports = {
    buildLegacyImages,
    fitWithin,
    nextRowY,
    isValidBoneId,
    LegacyImportError,
    MAX_IMAGE_SIZE,
    IMAGE_GAP,
};