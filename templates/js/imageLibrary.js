// Existing (legacy) bone images for the Scene Editor. Issue #464.
//
// The catalog comes from GET /api/image-catalog. A scene stores an existing image
// by its normal URL (/api/images/<filename>), so the viewer and the editor load
// the same file and the image itself is never copied or changed.

const IMAGE_CATALOG_URL = "/api/image-catalog";
const DEFAULT_MAX_SIZE = 480;

/**
 * Lists the existing images, optionally only those a bone's description uses.
 * @param {string} [boneId]
 */
export async function listExistingImages(boneId) {
    const url = boneId ? `${IMAGE_CATALOG_URL}?boneId=${encodeURIComponent(boneId)}` : IMAGE_CATALOG_URL;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load image catalog (HTTP ${response.status})`);
    }
    const body = await response.json();
    return body.images;
}

function newImageId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Builds a scene image object (the shape sceneCanvas.js renders) for an
 * existing image selected from the catalog. Keeps the aspect ratio and only
 * scales down, never up, to fit within maxSize.
 */
export function toSceneImage(entry, { x = 0, y = 0, maxSize = DEFAULT_MAX_SIZE } = {}) {
    if (!entry || typeof entry.url !== "string") {
        throw new Error("A catalog entry with a url is required");
    }
    const hasSize = entry.width > 0 && entry.height > 0;
    const naturalWidth = hasSize ? entry.width : maxSize;
    const naturalHeight = hasSize ? entry.height : maxSize;
    const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));

    return {
        id: newImageId(),
        src: entry.url,
        x,
        y,
        width: Math.round(naturalWidth * scale),
        height: Math.round(naturalHeight * scale),
        rotation: 0,
    };
}