import { renderScene } from "./sceneCanvas.js";

const SCENES_URL = "/api/scenes";

export class SceneApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function request(path = "", options = {}) {
    let response;
    try {
        response = await fetch(`${SCENES_URL}${path}`, {
            ...options,
            headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        });
    } catch {
        throw new SceneApiError(0, "Network error");
    }

    if (response.status === 204) return null;

    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (!response.ok) {
        throw new SceneApiError(response.status, (body && body.error) || `HTTP ${response.status}`);
    }
    return body;
}

const scenePath = (sceneId) => `/${encodeURIComponent(sceneId)}`;

export async function listScenes() {
    const body = await request();
    return body.scenes;
}

export function createScene() {
    return request("", { method: "POST", body: "{}" });
}

export function getScene(sceneId) {
    return request(scenePath(sceneId));
}

export function renameScene(sceneId, name) {
    return request(scenePath(sceneId), { method: "PATCH", body: JSON.stringify({ name }) });
}

/**
 * Persists one newly imported image on a scene (Issue #412). The server upserts
 * by `image.id`, so retrying this call for the same image is always safe.
 * @param {string} sceneId
 * @param {{id: string, src: string, x: number, y: number, width: number, height: number}} image
 * @returns {Promise<object>} The updated scene.
 */
export function saveImageToScene(sceneId, image) {
    return request(scenePath(sceneId), { method: "PATCH", body: JSON.stringify({ image }) });
}

/**
 * Partially updates an existing image's fields - position, size, rotation,
 * flip, or crop (Issues #413-417). Only the given fields are touched.
 * @param {string} sceneId
 * @param {string} imageId
 * @param {object} fields
 * @returns {Promise<object>} The updated scene.
 */
export function updateSceneImage(sceneId, imageId, fields) {
    return request(scenePath(sceneId), {
        method: "PATCH",
        body: JSON.stringify({ updateImage: { id: imageId, ...fields } }),
    });
}

/**
 * Removes one image from a scene by id (Issue #418). A retry after a prior
 * success is always safe - the server treats "already gone" as success too.
 * @param {string} sceneId
 * @param {string} imageId
 * @returns {Promise<object>} The updated scene.
 */
export function removeSceneImage(sceneId, imageId) {
    return request(scenePath(sceneId), { method: "PATCH", body: JSON.stringify({ removeImageId: imageId }) });
}

/**
 * Reorders a scene's images to match the given id order (Issue #419). The
 * server rejects any order that isn't an exact permutation of the scene's
 * current image ids.
 * @param {string} sceneId
 * @param {string[]} orderedIds
 * @returns {Promise<object>} The updated scene.
 */
export function reorderSceneImages(sceneId, orderedIds) {
    return request(scenePath(sceneId), { method: "PATCH", body: JSON.stringify({ reorderImageIds: orderedIds }) });
}

export function deleteScene(sceneId) {
    return request(scenePath(sceneId), { method: "DELETE" });
}

/**
 * Turns an API error into a message a user can act on.
 * @param {Error} error
 * @param {"rename"|"load"|"open"|"create"|"delete"} context
 */
export function describeError(error, context) {
    const status = error instanceof SceneApiError ? error.status : 0;
    switch (status) {
        case 0:
            return "Couldn't reach the server. Check your connection and try again.";
        case 400:
            return context === "rename"
                ? "Enter a scene name (up to 100 characters)."
                : `The request was rejected: ${error.message}.`;
        case 404:
            return "This scene is no longer available. It may have been deleted.";
        case 409:
            return /busy/i.test(error.message)
                ? "The scene is busy right now (another save is in progress). Try again in a moment."
                : "Another scene already uses that name. Choose a different name.";
        case 429:
            return "Too many requests. Wait a moment and try again.";
        case 503:
            return "Scene storage is not configured; try again later or contact the project maintainer.";
        default:
            return "Something went wrong on the server. Try again.";
    }
}

const state = {
    scenes: [],
    active: null,
    openRequest: 0,
    fitToWidth: true,
    busy: false,
    selectedImageIndex: null,
    cropMode: false,
};

function deselectImage() {
    state.selectedImageIndex = null;
    state.cropMode = false;
}

let dom = null;
// Set by startImageDrag's mouseup once a real drag (not just a click) just
// finished, so the canvas's own click handler (select/deselect toggle) knows
// to skip itself for that click - browsers fire `click` after mouseup on the
// same element regardless of how far the mouse moved in between, so without
// this a move/resize drag would immediately deselect the image it just moved.
let suppressNextClick = false;

// Issues #411/#412: importing an image into a scene and persisting it. The
// image is read as a base64 data: URL - that same string is both the immediate
// preview `src` and what gets saved to the scene document, so there's only one
// representation to reason about (see saveImageToScene in the API section above).
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
const MAX_IMPORT_DIMENSION = 320;
const IMPORT_OFFSET_STEP = 24;
// Kept comfortably under the backend's MAX_IMAGE_SRC_LENGTH cap (boneset-api/scenes.js)
// once base64's ~4/3 overhead is applied - checked client-side for immediate feedback,
// but the server independently re-checks its own cap too (never trust the client alone).
const MAX_IMPORT_FILE_SIZE = 2 * 1024 * 1024;
// Mirrors the backend's MAX_SCENE_IMAGES_TOTAL_LENGTH (PR #493 review: two
// individually-valid images can still combine to blow past Vercel's 4.5MB
// request/response cap) - same "check and skip clearly before uploading"
// philosophy as the per-file checks above; the server is the real enforcement.
const MAX_SCENE_IMAGES_TOTAL_LENGTH = 3_800_000;

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.readAsDataURL(file);
    });
}

function loadImageDimensions(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error("Could not read image dimensions"));
        img.src = src;
    });
}

function scaleToFit(width, height, max) {
    if (width <= max && height <= max) return { width, height };
    const scale = Math.min(max / width, max / height);
    return { width: width * scale, height: height * scale };
}

function announce(message) {
    dom.status.textContent = "";
    // Clearing first makes screen readers repeat identical consecutive messages.
    setTimeout(() => {
        dom.status.textContent = message;
    }, 50);
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function setBusy(busy) {
    state.busy = busy;
    dom.newButton.disabled = busy;
    dom.emptyNewButton.disabled = busy;
    dom.renameButton.disabled = busy || !state.active;
    dom.deleteButton.disabled = busy || !state.active;
}

function showLibraryMessage(message, { retry = false } = {}) {
    dom.libraryMessage.hidden = false;
    dom.libraryMessageText.textContent = message;
    dom.libraryRetry.hidden = !retry;
}

function hideLibraryMessage() {
    dom.libraryMessage.hidden = true;
}

function showWorkspaceError(message, { retry = null } = {}) {
    dom.workspaceError.hidden = false;
    dom.workspaceErrorText.textContent = message;
    dom.workspaceRetry.hidden = !retry;
    dom.workspaceRetry.onclick = retry;
}

function hideWorkspaceError() {
    dom.workspaceError.hidden = true;
    dom.workspaceRetry.onclick = null;
}

function renderLibrary() {
    dom.sceneList.replaceChildren();
    dom.libraryEmpty.hidden = state.scenes.length > 0;

    for (const scene of state.scenes) {
        const isActive = state.active && state.active.id === scene.id;
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "scene-list-item";
        button.dataset.sceneId = scene.id;
        if (isActive) button.setAttribute("aria-current", "true");

        const name = document.createElement("span");
        name.className = "scene-list-name";
        name.textContent = scene.name;

        const meta = document.createElement("span");
        meta.className = "scene-list-meta";
        meta.textContent = `${plural(scene.imageCount, "image")} · ${plural(scene.annotationCount, "annotation")}`;

        button.append(name, meta);
        if (isActive) {
            const badge = document.createElement("span");
            badge.className = "scene-list-badge";
            badge.textContent = "Open";
            button.append(badge);
        }
        button.addEventListener("click", () => openScene(scene.id));
        item.append(button);
        dom.sceneList.append(item);
    }
}

/**
 * Shows the selected-image toolbar (reorder/rotate/flip/crop/remove) only
 * while an image is actually selected: disables the reorder buttons at
 * whichever end of the stack the selection is already at, and swaps the
 * "Crop…" button for "Done"/"Reset crop" while actively editing a crop
 * (Issue #417).
 */
function updateImageToolbar() {
    const scene = state.active;
    const index = state.selectedImageIndex;
    const hasSelection = Boolean(scene) && index !== null && index >= 0 && index < scene.images.length;
    dom.imageToolbar.hidden = !hasSelection;
    if (!hasSelection) return;
    dom.imageBackward.disabled = index === 0;
    dom.imageForward.disabled = index === scene.images.length - 1;
    dom.imageCropStart.hidden = state.cropMode;
    dom.imageCropDone.hidden = !state.cropMode;
    dom.imageCropReset.hidden = !state.cropMode;
}

function renderCanvas() {
    const scene = state.active;
    dom.canvas.replaceChildren();
    updateImageToolbar();
    const isEmpty = scene.images.length === 0 && scene.annotations.length === 0;
    dom.canvasEmpty.hidden = !isEmpty;
    dom.canvas.hidden = isEmpty;
    dom.fitToggle.hidden = isEmpty;
    dom.canvasNote.hidden = true;
    if (isEmpty) return;

    const { svg, unsupported, width, height } = renderScene(scene, {
        selectedIndex: state.selectedImageIndex,
        cropMode: state.cropMode,
    });
    svg.setAttribute("aria-label", `Scene canvas for ${scene.name}`);
    if (state.fitToWidth) {
        svg.style.width = "100%";
        svg.style.height = "auto";
    } else {
        svg.style.width = `${width}px`;
        svg.style.height = `${height}px`;
    }
    dom.canvas.append(svg);

    if (unsupported > 0) {
        dom.canvasNote.hidden = false;
        dom.canvasNote.textContent =
            `${plural(unsupported, "object")} can't be displayed yet but are still stored with this scene.`;
    }
}

function renderWorkspace() {
    const scene = state.active;
    hideRenameForm();
    hideWorkspaceError();
    dom.workspaceEmpty.hidden = Boolean(scene);
    dom.workspaceScene.hidden = !scene;
    setBusy(state.busy);
    if (!scene) return;

    dom.sceneTitle.textContent = scene.name;
    dom.sceneMeta.textContent = `${plural(scene.images.length, "image")} · ${plural(scene.annotations.length, "annotation")}`;
    renderCanvas();
}

function clearActiveScene() {
    state.active = null;
    deselectImage();
    state.openRequest += 1;
    dom.workspace.removeAttribute("aria-busy");
    dom.workspaceLoading.hidden = true;
    renderWorkspace();
    renderLibrary();
}

async function loadLibrary() {
    showLibraryMessage("Loading scenes…");
    dom.libraryEmpty.hidden = true;
    try {
        state.scenes = await listScenes();
        hideLibraryMessage();
        if (state.active && !state.scenes.some((s) => s.id === state.active.id)) {
            clearActiveScene();
            showWorkspaceError("The scene you had open is no longer available. It may have been deleted.");
        }
        renderLibrary();
    } catch (error) {
        state.scenes = [];
        renderLibrary();
        dom.libraryEmpty.hidden = true;
        showLibraryMessage(describeError(error, "load"), { retry: true });
        announce(describeError(error, "load"));
    }
}

async function openScene(sceneId) {
    if (state.active && state.active.id === sceneId) return;

    const requestId = ++state.openRequest;
    hideWorkspaceError();
    dom.workspace.setAttribute("aria-busy", "true");
    dom.workspaceLoading.hidden = false;
    announce("Opening scene…");

    try {
        const scene = await getScene(sceneId);
        if (requestId !== state.openRequest) return;
        state.active = scene;
        deselectImage();
        renderWorkspace();
        renderLibrary();
        announce(`Opened ${scene.name}.`);
        dom.sceneTitle.focus();
    } catch (error) {
        if (requestId !== state.openRequest) return;
        const message = describeError(error, "open");
        if (error.status === 404) {
            clearActiveScene();
            await loadLibrary();
        }
        showWorkspaceError(message, error.status === 404 ? {} : { retry: () => openScene(sceneId) });
        announce(message);
    } finally {
        if (requestId === state.openRequest) {
            dom.workspace.removeAttribute("aria-busy");
            dom.workspaceLoading.hidden = true;
        }
    }
}

async function handleCreate() {
    if (state.busy) return;
    setBusy(true);
    hideWorkspaceError();
    announce("Creating scene…");
    try {
        const scene = await createScene();
        state.openRequest += 1;
        state.active = scene;
        deselectImage();
        await loadLibrary();
        setBusy(false);
        renderWorkspace();
        renderLibrary();
        announce(`Created ${scene.name}.`);
        dom.sceneTitle.focus();
    } catch (error) {
        setBusy(false);
        const message = describeError(error, "create");
        showWorkspaceError(message, { retry: handleCreate });
        announce(message);
    }
}

function showRenameForm() {
    if (!state.active) return;
    dom.renameForm.hidden = false;
    dom.titleRow.hidden = true;
    dom.renameInput.value = state.active.name;
    dom.renameError.hidden = true;
    dom.renameError.textContent = "";
    dom.renameInput.removeAttribute("aria-invalid");
    dom.renameInput.focus();
    dom.renameInput.select();
}

function hideRenameForm() {
    dom.renameForm.hidden = true;
    dom.titleRow.hidden = false;
}

function showRenameError(message) {
    dom.renameError.hidden = false;
    dom.renameError.textContent = message;
    dom.renameInput.setAttribute("aria-invalid", "true");
    dom.renameInput.focus();
}

async function handleRename(event) {
    event.preventDefault();
    if (!state.active || state.busy) return;

    const name = dom.renameInput.value.trim();
    if (!name) {
        showRenameError("Enter a scene name (up to 100 characters).");
        return;
    }
    if (name === state.active.name) {
        hideRenameForm();
        dom.renameButton.focus();
        return;
    }

    const sceneId = state.active.id;
    setBusy(true);
    dom.renameSubmit.disabled = true;
    try {
        const updated = await renameScene(sceneId, name);
        if (state.active && state.active.id === sceneId) {
            state.active.name = updated.name;
            state.active.updatedAt = updated.updatedAt;
        }
        const summary = state.scenes.find((s) => s.id === sceneId);
        if (summary) summary.name = updated.name;
        setBusy(false);
        renderWorkspace();
        renderLibrary();
        announce(`Renamed to ${updated.name}.`);
        dom.renameButton.focus();
    } catch (error) {
        setBusy(false);
        const message = describeError(error, "rename");
        if (error.status === 404) {
            clearActiveScene();
            await loadLibrary();
            showWorkspaceError(message);
        } else {
            showRenameError(message);
        }
        announce(message);
    } finally {
        dom.renameSubmit.disabled = false;
    }
}

async function handleDelete() {
    if (!state.active || state.busy) return;
    const { id, name } = state.active;
    if (!window.confirm(`Delete "${name}"? This permanently removes the scene and can't be undone.`)) return;

    setBusy(true);
    hideWorkspaceError();
    try {
        await deleteScene(id);
        state.scenes = state.scenes.filter((s) => s.id !== id);
        setBusy(false);
        if (state.active && state.active.id === id) clearActiveScene();
        renderLibrary();
        announce(`Deleted ${name}.`);
        dom.newButton.focus();
    } catch (error) {
        setBusy(false);
        const message = error.status === 404
            ? `"${name}" was already deleted.`
            : describeError(error, "delete");
        if (error.status === 404) {
            clearActiveScene();
            await loadLibrary();
        }
        showWorkspaceError(message, error.status === 404 ? {} : { retry: handleDelete });
        announce(message);
    }
}

/**
 * Retries persisting images that previously failed to save (Issue #412). Safe
 * to call repeatedly - the server upserts by image id, so a partially-succeeded
 * previous attempt is never double-saved.
 * @param {string} sceneId - The scene these images belong to, captured at
 *   import time so a later retry targets the right scene even if the user has
 *   since opened a different one.
 * @param {object[]} images
 * @returns {Promise<void>}
 */
async function retryImageSaves(sceneId, images) {
    const stillFailing = [];
    let savedCount = 0;
    for (const image of images) {
        try {
            await saveImageToScene(sceneId, image);
            savedCount += 1;
        } catch {
            stillFailing.push(image);
        }
    }

    // Reflects the scene list's count from what's actually confirmed saved
    // (not the optimistic local count), regardless of whether this scene is
    // still the one open - it was going stale until the next full reload
    // otherwise (PR #493 review).
    if (savedCount > 0) {
        const summary = state.scenes.find((s) => s.id === sceneId);
        if (summary) {
            summary.imageCount += savedCount;
            renderLibrary();
        }
    }

    if (stillFailing.length === 0) {
        hideWorkspaceError();
        return;
    }
    showWorkspaceError(
        `${plural(stillFailing.length, "image")} could not be saved and will be lost if you reload.`,
        { retry: () => retryImageSaves(sceneId, stillFailing) }
    );
}

/**
 * Removes one image from a scene, optimistically and persisted (Issue #418).
 * Re-entrant by design so its own retry can just call it again: it always
 * re-finds the image's current position before acting, which is what makes a
 * restore-then-retry sequence work correctly.
 * @param {string} sceneId
 * @param {{id: string}} image
 */
async function performImageRemoval(sceneId, image) {
    const isActiveScene = Boolean(state.active) && state.active.id === sceneId;
    const index = isActiveScene ? state.active.images.findIndex((img) => img.id === image.id) : -1;

    if (index !== -1) {
        state.active.images.splice(index, 1);
        if (state.selectedImageIndex === index) deselectImage();
        renderWorkspace();
    }
    const summary = state.scenes.find((s) => s.id === sceneId);
    if (summary) {
        summary.imageCount = Math.max(0, summary.imageCount - 1);
        renderLibrary();
    }

    try {
        await removeSceneImage(sceneId, image.id);
        hideWorkspaceError();
    } catch {
        if (state.active && state.active.id === sceneId && !state.active.images.some((img) => img.id === image.id)) {
            state.active.images.splice(index === -1 ? state.active.images.length : index, 0, image);
            renderWorkspace();
        }
        if (summary) {
            summary.imageCount += 1;
            renderLibrary();
        }
        showWorkspaceError("Could not remove the image. It has been restored - try again.", {
            retry: () => performImageRemoval(sceneId, image),
        });
    }
}

function handleImageRemove() {
    if (!state.active || state.selectedImageIndex === null) return;
    const image = state.active.images[state.selectedImageIndex];
    if (!image) return;
    performImageRemoval(state.active.id, image);
}

/**
 * Persists a field-level change already applied to `image` (the caller has
 * already set the new values and rendered them - this just saves and handles
 * failure). On failure, reverts exactly the touched fields back to `previous`
 * and offers a retry that re-applies `fields` and tries again - used by both
 * the button-driven updates below and by drag-release in initializeSceneEditor
 * (Issues #413-417: position, resize, rotate, flip, crop all share this path).
 * @param {string} sceneId
 * @param {number} index - The image's index at the time of the change, used
 *   to confirm it's still the same image object before reverting/re-rendering.
 * @param {object} image
 * @param {object} previous - The pre-change values for exactly the touched fields.
 * @param {object} fields - The new values that were set, e.g. `{ rotation: 90 }`.
 */
async function persistImageFields(sceneId, index, image, previous, fields) {
    try {
        await updateSceneImage(sceneId, image.id, fields);
        hideWorkspaceError();
    } catch {
        if (state.active && state.active.id === sceneId && state.active.images[index] === image) {
            Object.assign(image, previous);
            renderWorkspace();
        }
        showWorkspaceError("Could not save the change. Try again.", {
            retry: () => {
                if (state.active && state.active.id === sceneId && state.active.images[index] === image) {
                    Object.assign(image, fields);
                    renderWorkspace();
                }
                persistImageFields(sceneId, index, image, previous, fields);
            },
        });
    }
}

/**
 * Applies a field-level change to the selected image - optimistic locally,
 * then persisted via persistImageFields. For button-driven changes (rotate
 * stepper, flip) where nothing has been applied yet, unlike a drag which
 * applies its own changes live frame-by-frame before calling
 * persistImageFields directly at release.
 * @param {object} fields - The new values to set, e.g. `{ rotation: 90 }`.
 */
function applySelectedImageUpdate(fields) {
    if (!state.active || state.selectedImageIndex === null) return;
    const scene = state.active;
    const sceneId = scene.id;
    const index = state.selectedImageIndex;
    const image = scene.images[index];
    if (!image) return;

    const previous = {};
    for (const key of Object.keys(fields)) previous[key] = image[key];
    Object.assign(image, fields);
    renderWorkspace();

    persistImageFields(sceneId, index, image, previous, fields);
}

/**
 * Rotates the selected image by a relative amount, normalized into [0, 360)
 * (Issue #415). Stepper buttons only (±15°/±90°), not a free-drag handle.
 * @param {number} deltaDegrees
 */
function rotateSelectedImage(deltaDegrees) {
    if (!state.active || state.selectedImageIndex === null) return;
    const image = state.active.images[state.selectedImageIndex];
    if (!image) return;
    const current = typeof image.rotation === "number" ? image.rotation : 0;
    const next = ((current + deltaDegrees) % 360 + 360) % 360;
    applySelectedImageUpdate({ rotation: next });
}

/**
 * Toggles the selected image's flip state on one axis (Issue #416).
 * @param {"horizontal" | "vertical"} axis
 */
function flipSelectedImage(axis) {
    if (!state.active || state.selectedImageIndex === null) return;
    const image = state.active.images[state.selectedImageIndex];
    if (!image) return;
    const field = axis === "horizontal" ? "flipX" : "flipY";
    applySelectedImageUpdate({ [field]: !image[field] });
}

/**
 * Swaps the selected image with its neighbor toward the front (direction=1)
 * or back (direction=-1) of the paint order (Issue #419). No-op at either end
 * of the stack - the toolbar also disables the button there, this is just the
 * same guard for any other caller.
 * @param {1 | -1} direction
 */
async function moveSelectedImage(direction) {
    if (!state.active || state.selectedImageIndex === null) return;
    const scene = state.active;
    const sceneId = scene.id;
    const index = state.selectedImageIndex;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= scene.images.length) return;

    const images = scene.images;
    [images[index], images[targetIndex]] = [images[targetIndex], images[index]];
    state.selectedImageIndex = targetIndex;
    renderWorkspace();

    try {
        await reorderSceneImages(sceneId, images.map((img) => img.id));
        hideWorkspaceError();
    } catch {
        if (state.active && state.active.id === sceneId) {
            [images[index], images[targetIndex]] = [images[targetIndex], images[index]];
            state.selectedImageIndex = index;
            renderWorkspace();
        }
        showWorkspaceError("Could not reorder images. Try again.", {
            retry: () => moveSelectedImage(direction),
        });
    }
}

// Issues #413/#414: dragging a selected image to move it, or dragging one of
// its corner handles to resize it. Both read the SVG's current on-screen size
// vs. its viewBox to convert mouse-pixel deltas into scene units - deltas
// only, never absolute positions, so there's no dependency on the SVG's
// screen offset, only its scale. This is what makes it testable without a
// real browser: a test can set `svg.getBoundingClientRect` to a fixed value,
// the same way existing tests mock `FileReader`/`Image` for things jsdom
// can't do for real.
const MIN_IMAGE_SIZE = 10;
const DRAG_THRESHOLD = 2;
const CORNER_GROWTH_SIGN = {
    nw: { x: -1, y: -1 },
    ne: { x: 1, y: -1 },
    se: { x: 1, y: 1 },
    sw: { x: -1, y: 1 },
};

function getSceneScale(svg) {
    const rect = svg.getBoundingClientRect();
    // Parsed from the attribute directly, not `.viewBox.baseVal` - jsdom's
    // SVG support leaves that an empty stub, and parsing the attribute string
    // works identically in a real browser too since renderScene always keeps
    // it in sync via setAttribute.
    const [, , vbWidth, vbHeight] = (svg.getAttribute("viewBox") || "0 0 0 0").split(" ").map(Number);
    return {
        x: rect.width ? vbWidth / rect.width : 1,
        y: rect.height ? vbHeight / rect.height : 1,
    };
}

/**
 * Rotates a delta *vector* (not a point - no center needed) by -degrees, to
 * convert a mouse-drag delta measured in global scene axes into the image's
 * own local (unrotated) axes. Uses the same rotation convention as
 * sceneCanvas.js's rotatePoints, just inverted and center-free.
 */
function unrotateVector(dx, dy, degrees) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/**
 * Starts a move-or-resize drag on the currently selected image. Moving
 * updates x/y directly (translation is rotation-invariant). Resizing scales
 * from the image's own center (which stays fixed regardless of rotation,
 * matching how sceneCanvas.js already rotates images around their center) -
 * the mouse delta is un-rotated into the image's local axes first so dragging
 * a corner grows/shrinks the image along its own edges even when rotated,
 * and width/height are scaled by the same factor so it's never distorted.
 * @param {MouseEvent} event
 * @param {SVGSVGElement} svg
 * @param {string|null} corner - "nw"|"ne"|"se"|"sw" to resize, or null to move.
 */
function startImageDrag(event, svg, corner) {
    const scene = state.active;
    const index = state.selectedImageIndex;
    const image = scene.images[index];
    const sceneId = scene.id;
    const scale = getSceneScale(svg);
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startX = image.x;
    const startY = image.y;
    const startWidth = image.width;
    const startHeight = image.height;
    const rotation = typeof image.rotation === "number" ? image.rotation : 0;
    let didDrag = false;

    function onMouseMove(moveEvent) {
        const dxClient = moveEvent.clientX - startClientX;
        const dyClient = moveEvent.clientY - startClientY;
        if (Math.abs(dxClient) > DRAG_THRESHOLD || Math.abs(dyClient) > DRAG_THRESHOLD) didDrag = true;
        const globalDx = dxClient * scale.x;
        const globalDy = dyClient * scale.y;

        if (corner) {
            const sign = CORNER_GROWTH_SIGN[corner];
            const local = unrotateVector(globalDx, globalDy, rotation);
            const minScale = MIN_IMAGE_SIZE / Math.min(startWidth, startHeight);
            const scaleFactor = Math.max(minScale, (startWidth + sign.x * local.x) / startWidth);
            const newWidth = startWidth * scaleFactor;
            const newHeight = startHeight * scaleFactor;
            const cx = startX + startWidth / 2;
            const cy = startY + startHeight / 2;
            image.width = newWidth;
            image.height = newHeight;
            image.x = cx - newWidth / 2;
            image.y = cy - newHeight / 2;
        } else {
            image.x = startX + globalDx;
            image.y = startY + globalDy;
        }
        renderWorkspace();
    }

    function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        suppressNextClick = didDrag;
        if (!didDrag) return;

        const fields = corner
            ? { x: image.x, y: image.y, width: image.width, height: image.height }
            : { x: image.x, y: image.y };
        const previous = corner
            ? { x: startX, y: startY, width: startWidth, height: startHeight }
            : { x: startX, y: startY };
        persistImageFields(sceneId, index, image, previous, fields);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

// Issue #417: non-destructive cropping. The crop rect lives in the image's
// own local box space (0..width, 0..height); absent fields mean "fully
// visible" everywhere this is read, matching sceneCanvas.js's cropRectFor.
const MIN_CROP_SIZE = 10;

function currentCropRect(image) {
    const hasCrop = [image.cropX, image.cropY, image.cropWidth, image.cropHeight]
        .every((value) => typeof value === "number" && Number.isFinite(value));
    return hasCrop
        ? { x: image.cropX, y: image.cropY, width: image.cropWidth, height: image.cropHeight }
        : { x: 0, y: 0, width: image.width, height: image.height };
}

/**
 * Computes a new crop rect from a corner drag, anchored at the OPPOSITE
 * corner of the crop rect itself - unlike resize's center anchor, this is
 * the standard crop-tool behavior, since there's no reason a crop needs to
 * stay centered. Clamped to stay within the image's own local box and never
 * shrink below MIN_CROP_SIZE.
 * @param {"nw"|"ne"|"se"|"sw"} corner
 * @param {{x: number, y: number, width: number, height: number}} start - crop rect at drag-start.
 * @param {{x: number, y: number}} localDelta - mouse delta, already un-rotated.
 * @param {number} imageWidth
 * @param {number} imageHeight
 */
function computeCropRect(corner, start, localDelta, imageWidth, imageHeight) {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    let { x, y, width, height } = start;

    if (corner === "se" || corner === "ne") {
        width = clamp(start.width + localDelta.x, MIN_CROP_SIZE, imageWidth - start.x);
    } else {
        const rightEdge = start.x + start.width;
        x = clamp(start.x + localDelta.x, 0, rightEdge - MIN_CROP_SIZE);
        width = rightEdge - x;
    }

    if (corner === "se" || corner === "sw") {
        height = clamp(start.height + localDelta.y, MIN_CROP_SIZE, imageHeight - start.y);
    } else {
        const bottomEdge = start.y + start.height;
        y = clamp(start.y + localDelta.y, 0, bottomEdge - MIN_CROP_SIZE);
        height = bottomEdge - y;
    }

    return { x, y, width, height };
}

/**
 * Starts a crop-rect drag on the selected image's currently-grabbed corner
 * handle (Issue #417) - the same scale/un-rotate approach as startImageDrag.
 * @param {MouseEvent} event
 * @param {SVGSVGElement} svg
 * @param {"nw"|"ne"|"se"|"sw"} corner
 */
function startCropDrag(event, svg, corner) {
    const scene = state.active;
    const index = state.selectedImageIndex;
    const image = scene.images[index];
    const sceneId = scene.id;
    const scale = getSceneScale(svg);
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startCrop = currentCropRect(image);
    const rotation = typeof image.rotation === "number" ? image.rotation : 0;
    let didDrag = false;

    function onMouseMove(moveEvent) {
        const dxClient = moveEvent.clientX - startClientX;
        const dyClient = moveEvent.clientY - startClientY;
        if (Math.abs(dxClient) > DRAG_THRESHOLD || Math.abs(dyClient) > DRAG_THRESHOLD) didDrag = true;
        const local = unrotateVector(dxClient * scale.x, dyClient * scale.y, rotation);

        const next = computeCropRect(corner, startCrop, local, image.width, image.height);
        image.cropX = next.x;
        image.cropY = next.y;
        image.cropWidth = next.width;
        image.cropHeight = next.height;
        renderWorkspace();
    }

    function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        suppressNextClick = didDrag;
        if (!didDrag) return;

        const fields = { cropX: image.cropX, cropY: image.cropY, cropWidth: image.cropWidth, cropHeight: image.cropHeight };
        const previous = { cropX: startCrop.x, cropY: startCrop.y, cropWidth: startCrop.width, cropHeight: startCrop.height };
        persistImageFields(sceneId, index, image, previous, fields);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
}

/** Enters crop-editing mode for the selected image (Issue #417). */
function enterCropMode() {
    if (!state.active || state.selectedImageIndex === null) return;
    state.cropMode = true;
    renderCanvas();
}

/** Exits crop-editing mode - a pure view toggle, since any actual crop
 * adjustment was already persisted at the end of its own drag gesture. */
function exitCropMode() {
    state.cropMode = false;
    renderCanvas();
}

/** Clears the selected image's crop back to fully visible, persisted immediately. */
function resetSelectedImageCrop() {
    if (!state.active || state.selectedImageIndex === null) return;
    const image = state.active.images[state.selectedImageIndex];
    if (!image) return;
    applySelectedImageUpdate({ cropX: 0, cropY: 0, cropWidth: image.width, cropHeight: image.height });
}

/**
 * Imports one or more image files into the currently open scene as new,
 * unselected image objects, and persists each one (Issues #411/#412).
 * Unsupported or oversized files are skipped with a combined error message
 * rather than aborting the whole import.
 * @param {FileList|File[]} fileList - Files chosen via the import input.
 * @returns {Promise<void>}
 */
async function handleImportFiles(fileList) {
    if (!state.active || !fileList || fileList.length === 0) return;
    const sceneId = state.active.id;
    // Captured once up front so later iterations don't depend on state.active,
    // which can change mid-loop if the user opens a different scene while an
    // earlier file is still being read (PR #493 review).
    const baseImageCount = state.active.images.length;
    let totalSrcLength = state.active.images.reduce((sum, img) => sum + img.src.length, 0);

    dom.importError.hidden = true;
    dom.importError.textContent = "";

    const skipped = [];
    const added = [];

    for (const file of fileList) {
        if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
            skipped.push(`${file.name} (unsupported type)`);
            continue;
        }
        if (file.size > MAX_IMPORT_FILE_SIZE) {
            skipped.push(`${file.name} (too large, max 2MB)`);
            continue;
        }

        try {
            const dataUrl = await readFileAsDataUrl(file);
            if (totalSrcLength + dataUrl.length > MAX_SCENE_IMAGES_TOTAL_LENGTH) {
                skipped.push(`${file.name} (scene is near its image size limit)`);
                continue;
            }
            const natural = await loadImageDimensions(dataUrl);
            const { width, height } = scaleToFit(natural.width, natural.height, MAX_IMPORT_DIMENSION);
            const offset = IMPORT_OFFSET_STEP * (baseImageCount + added.length + 1);
            const image = { id: crypto.randomUUID(), src: dataUrl, x: offset, y: offset, width, height };
            added.push(image);
            totalSrcLength += dataUrl.length;
            if (state.active && state.active.id === sceneId) {
                state.active.images.push(image);
            }
        } catch {
            skipped.push(`${file.name} (could not be read)`);
        }
    }

    if (skipped.length > 0) {
        const addedPart = added.length > 0 ? `${plural(added.length, "image")} added. ` : "";
        dom.importError.hidden = false;
        dom.importError.textContent =
            `${addedPart}${plural(skipped.length, "file")} skipped: ${skipped.join(", ")}.`;
    }

    if (added.length > 0) {
        if (state.active && state.active.id === sceneId) {
            renderWorkspace();
            announce(`${plural(added.length, "image")} added to the scene.`);
        }
        // Always persists to the scene the import actually started on, even
        // if the user has since switched to viewing a different one.
        await retryImageSaves(sceneId, added);
    }
}

export function getActiveScene() {
    return state.active;
}

function setFitToWidth(fit) {
    state.fitToWidth = fit;
    dom.fitToggle.textContent = fit ? "Show actual size" : "Fit to width";
    if (state.active) renderCanvas();
}

function enterEditor() {
    dom.viewer.hidden = true;
    dom.editorView.hidden = false;
    dom.enterButton.setAttribute("aria-pressed", "true");
    dom.editorHeading.focus();
    loadLibrary();
}

function leaveEditor() {
    dom.editorView.hidden = true;
    dom.viewer.hidden = false;
    dom.enterButton.setAttribute("aria-pressed", "false");
    dom.enterButton.focus();
}

export function initializeSceneEditor(root = document) {
    const $ = (id) => root.getElementById(id);
    dom = {
        viewer: $("editor-view"),
        editorView: $("scene-editor-view"),
        enterButton: $("text-button-SceneEditor"),
        backButton: $("scene-editor-back"),
        editorHeading: $("scene-editor-heading"),
        status: $("scene-editor-status"),
        newButton: $("scene-new"),
        emptyNewButton: $("scene-empty-new"),
        sceneList: $("scene-list"),
        libraryEmpty: $("scene-library-empty"),
        libraryMessage: $("scene-library-message"),
        libraryMessageText: $("scene-library-message-text"),
        libraryRetry: $("scene-library-retry"),
        workspace: $("scene-workspace"),
        workspaceEmpty: $("scene-workspace-empty"),
        workspaceLoading: $("scene-workspace-loading"),
        workspaceScene: $("scene-workspace-scene"),
        workspaceError: $("scene-workspace-error"),
        workspaceErrorText: $("scene-workspace-error-text"),
        workspaceRetry: $("scene-workspace-retry"),
        titleRow: $("scene-title-row"),
        sceneTitle: $("scene-title"),
        sceneMeta: $("scene-meta"),
        renameButton: $("scene-rename"),
        deleteButton: $("scene-delete"),
        renameForm: $("scene-rename-form"),
        renameInput: $("scene-rename-input"),
        renameSubmit: $("scene-rename-submit"),
        renameCancel: $("scene-rename-cancel"),
        renameError: $("scene-rename-error"),
        fitToggle: $("scene-fit-toggle"),
        canvas: $("scene-canvas"),
        canvasEmpty: $("scene-canvas-empty"),
        canvasNote: $("scene-canvas-note"),
        importButton: $("scene-import-image"),
        importButtonEmpty: $("scene-canvas-empty-import"),
        importInput: $("scene-import-input"),
        importError: $("scene-import-error"),
        imageToolbar: $("scene-image-toolbar"),
        imageForward: $("scene-image-forward"),
        imageBackward: $("scene-image-backward"),
        imageRemove: $("scene-image-remove"),
        imageRotateLeft90: $("scene-image-rotate-left-90"),
        imageRotateLeft15: $("scene-image-rotate-left-15"),
        imageRotateRight15: $("scene-image-rotate-right-15"),
        imageRotateRight90: $("scene-image-rotate-right-90"),
        imageFlipHorizontal: $("scene-image-flip-horizontal"),
        imageFlipVertical: $("scene-image-flip-vertical"),
        imageCropStart: $("scene-image-crop-start"),
        imageCropDone: $("scene-image-crop-done"),
        imageCropReset: $("scene-image-crop-reset"),
    };
    if (!dom.editorView || !dom.enterButton) return;

    dom.enterButton.addEventListener("click", () => {
        if (dom.editorView.hidden) enterEditor();
        else leaveEditor();
    });
    dom.backButton.addEventListener("click", leaveEditor);
    dom.newButton.addEventListener("click", handleCreate);
    dom.emptyNewButton.addEventListener("click", handleCreate);
    dom.libraryRetry.addEventListener("click", loadLibrary);
    dom.renameButton.addEventListener("click", showRenameForm);
    dom.renameForm.addEventListener("submit", handleRename);
    dom.renameCancel.addEventListener("click", () => {
        hideRenameForm();
        dom.renameButton.focus();
    });
    dom.renameInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            hideRenameForm();
            dom.renameButton.focus();
        }
    });
    dom.deleteButton.addEventListener("click", handleDelete);
    dom.fitToggle.addEventListener("click", () => setFitToWidth(!state.fitToWidth));

    dom.importButton.addEventListener("click", () => dom.importInput.click());
    dom.importButtonEmpty.addEventListener("click", () => dom.importInput.click());
    dom.importInput.addEventListener("change", (event) => {
        handleImportFiles(event.target.files);
        event.target.value = "";
    });
    dom.canvas.addEventListener("click", (event) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        const target = event.target.closest("[data-scene-image-index]");
        const index = target ? Number(target.dataset.sceneImageIndex) : null;
        if (state.selectedImageIndex === index) {
            deselectImage();
        } else {
            state.selectedImageIndex = index;
        }
        renderCanvas();
    });
    dom.canvas.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && state.selectedImageIndex !== null) {
            deselectImage();
            renderCanvas();
        }
    });
    dom.canvas.addEventListener("mousedown", (event) => {
        if (!state.active || state.selectedImageIndex === null) return;
        const image = state.active.images[state.selectedImageIndex];
        if (!image) return;

        const handle = event.target.closest("[data-corner]");
        const svg = dom.canvas.querySelector("svg");
        if (!svg) return;

        if (state.cropMode) {
            if (!handle) return;
            event.preventDefault();
            startCropDrag(event, svg, handle.dataset.corner);
            return;
        }

        const imageNode = event.target.closest("[data-scene-image-index]");
        const isSelectedImageNode =
            imageNode && Number(imageNode.dataset.sceneImageIndex) === state.selectedImageIndex;
        if (!handle && !isSelectedImageNode) return;

        event.preventDefault();
        startImageDrag(event, svg, handle ? handle.dataset.corner : null);
    });

    dom.imageForward.addEventListener("click", () => moveSelectedImage(1));
    dom.imageBackward.addEventListener("click", () => moveSelectedImage(-1));
    dom.imageRemove.addEventListener("click", handleImageRemove);
    dom.imageCropStart.addEventListener("click", enterCropMode);
    dom.imageCropDone.addEventListener("click", exitCropMode);
    dom.imageCropReset.addEventListener("click", resetSelectedImageCrop);
    dom.imageRotateLeft90.addEventListener("click", () => rotateSelectedImage(-90));
    dom.imageRotateLeft15.addEventListener("click", () => rotateSelectedImage(-15));
    dom.imageRotateRight15.addEventListener("click", () => rotateSelectedImage(15));
    dom.imageRotateRight90.addEventListener("click", () => rotateSelectedImage(90));
    dom.imageFlipHorizontal.addEventListener("click", () => flipSelectedImage("horizontal"));
    dom.imageFlipVertical.addEventListener("click", () => flipSelectedImage("vertical"));

    renderWorkspace();
}

document.addEventListener("DOMContentLoaded", () => initializeSceneEditor());
