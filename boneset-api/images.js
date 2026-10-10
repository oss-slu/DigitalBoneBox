// boneset-api/images.js
// Catalog of the existing (legacy) bone images, so the viewer and the Scene
// Editor can discover them. Issue #464 (parent #463).
//
// The image files themselves are never modified here. Each image keeps its
// existing URL, /api/images/<filename>, which is the same path the viewer uses
// and the path Vercel serves the copied images from (see vercel.json).
const { Buffer } = require("buffer"); // explicit: Jest's jsdom environment has no global Buffer
const express = require("express");
const rateLimit = require("express-rate-limit");
const fs = require("fs").promises;
const path = require("path");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const DESCRIPTION_SUFFIX = /_description\.json$/i;
const BONE_ID_PATTERN = /^[a-z0-9_]+$/i;
const HEADER_BYTES = 256 * 1024;

function imageUrl(filename) {
    return `/api/images/${encodeURIComponent(filename)}`;
}

function isImageFile(filename) {
    return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/**
 * Reads the pixel size of a PNG or JPEG from its header bytes.
 * @param {Buffer} buffer the start of the file (or the whole file)
 * @returns {{ width: number, height: number } | null} null if the size can't be read
 */
function readImageDimensions(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

    // PNG: 8-byte signature, then the IHDR chunk with width and height.
    if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // JPEG: walk the marker segments until a start-of-frame (SOFn) segment.
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 4 <= buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        if (marker === 0xff) {
            offset += 1; // fill byte
            continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
            offset += 2; // markers without a length field
            continue;
        }
        const length = buffer.readUInt16BE(offset + 2);
        const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isStartOfFrame) {
            if (offset + 9 > buffer.length) return null;
            return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
    }
    return null;
}

async function readFileStart(filePath, bytes) {
    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function getImageDimensions(filePath) {
    const start = await readFileStart(filePath, HEADER_BYTES);
    // Large metadata blocks can push a JPEG's frame header past the first read.
    return readImageDimensions(start) || readImageDimensions(await fs.readFile(filePath));
}

/**
 * Maps each image filename to the bone ids whose description lists it.
 * Only description files the viewer can load (/api/bone-data/?boneId=<id>) are
 * counted, so every id returned here is one the viewer can open.
 */
async function readImageReferences(descriptionsDir) {
    const references = new Map();
    const files = await fs.readdir(descriptionsDir);
    for (const file of files) {
        if (!DESCRIPTION_SUFFIX.test(file)) continue;
        const boneId = file.replace(DESCRIPTION_SUFFIX, "");
        if (!BONE_ID_PATTERN.test(boneId)) continue;

        let data;
        try {
            data = JSON.parse(await fs.readFile(path.join(descriptionsDir, file), "utf8"));
        } catch (error) {
            console.warn(`Skipping unreadable description ${file}: ${error.message}`);
            continue;
        }
        for (const filename of data.images || []) {
            if (!references.has(filename)) references.set(filename, []);
            references.get(filename).push(boneId);
        }
    }
    return references;
}

/**
 * Builds the list of existing images with their URL, pixel size and the bones
 * that use them. Filenames are matched exactly (case-sensitive), as they are
 * on the Linux servers the app is deployed to.
 * @returns {Promise<{ images: object[], missingReferences: object[] }>}
 */
async function buildImageCatalog({ imagesDir, descriptionsDir }) {
    const filenames = (await fs.readdir(imagesDir)).filter(isImageFile).sort();
    const references = await readImageReferences(descriptionsDir);

    const images = [];
    for (const filename of filenames) {
        const size = await getImageDimensions(path.join(imagesDir, filename));
        images.push({
            filename,
            url: imageUrl(filename),
            width: size ? size.width : null,
            height: size ? size.height : null,
            usedBy: (references.get(filename) || []).sort(),
        });
    }

    const existing = new Set(filenames);
    const missingReferences = [];
    for (const [filename, boneIds] of references) {
        if (!existing.has(filename)) missingReferences.push({ filename, usedBy: boneIds.sort() });
    }
    if (missingReferences.length > 0) {
        console.warn(`Image catalog: ${missingReferences.length} description image reference(s) have no matching file:`,
            missingReferences.map((m) => m.filename).join(", "));
    }

    return { images, missingReferences };
}

/**
 * GET /            every existing image
 * GET /?boneId=id  only the images a bone's description lists, in catalog order
 */
function createImageCatalogRouter(options) {
    const router = express.Router();
    let catalogPromise = null;
    const loadCatalog = () => {
        if (!catalogPromise) {
            catalogPromise = buildImageCatalog(options).catch((error) => {
                catalogPromise = null; // let the next request retry
                throw error;
            });
        }
        return catalogPromise;
    };

    router.use(rateLimit({
        windowMs: 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
    }));

    router.get("/", async (req, res) => {
        const { boneId } = req.query;
        if (boneId !== undefined && (typeof boneId !== "string" || !BONE_ID_PATTERN.test(boneId) || boneId.length > 100)) {
            return res.status(400).json({ error: "Invalid boneId format" });
        }

        try {
            const { images } = await loadCatalog();
            const selected = boneId ? images.filter((image) => image.usedBy.includes(boneId)) : images;
            res.json({ images: selected });
        } catch (error) {
            console.error("Failed to build image catalog:", error.message);
            res.status(500).json({ error: "Failed to load image catalog" });
        }
    });

    return router;
}

module.exports = {
    buildImageCatalog,
    createImageCatalogRouter,
    readImageDimensions,
    imageUrl,
};