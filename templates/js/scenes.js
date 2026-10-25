import { renderScene } from "./sceneCanvas.js";
import { OPEN_SCENE_EVENT, SHOW_IN_VIEWER_EVENT, sceneSources, readableName } from "./sceneLinks.js";

const SCENES_URL = "/api/scenes";

export class SceneApiError extends Error {
    constructor(status, message, body = null) {
        super(message);
        this.status = status;
        this.body = body;
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
        throw new SceneApiError(response.status, (body && body.error) || `HTTP ${response.status}`, body);
    }
    return body;
}

const scenePath = (sceneId) => `/${encodeURIComponent(sceneId)}`;

export async function listScenes() {
    const body = await request();
    return body.scenes;
}

/**
 * Creates a scene: blank, or with `content` ({ name?, images, annotations,
 * importLog? }) to store a working copy as a new scene in one request.
 * @param {object} [content]
 * @returns {Promise<object>} The new scene.
 */
export function createScene(content = {}) {
    return request("", { method: "POST", body: JSON.stringify(content) });
}

export function getScene(sceneId) {
    return request(scenePath(sceneId));
}

export function renameScene(sceneId, name) {
    return request(scenePath(sceneId), { method: "PATCH", body: JSON.stringify({ name }) });
}

/**
 * Stores a scene's whole working copy in one request (Issues #451/#452). The
 * arrays are always sent together so the stored scene is one coherent state.
 * @param {string} sceneId
 * @param {{images: object[], annotations: object[], importLog?: object[], name?: string, baseUpdatedAt?: string}} content
 *   `baseUpdatedAt` is the version this copy was loaded from; the server
 *   answers 412 if the stored scene has changed since.
 * @returns {Promise<object>} The saved scene.
 */
export function saveScene(sceneId, content) {
    return request(scenePath(sceneId), { method: "PUT", body: JSON.stringify(content) });
}

/**
 * Creates an independent copy of a scene's last saved version (Issue #455).
 * @param {string} sceneId
 * @returns {Promise<object>} The new scene.
 */
export function duplicateScene(sceneId) {
    return request(`${scenePath(sceneId)}/duplicate`, { method: "POST", body: "{}" });
}

export function deleteScene(sceneId) {
    return request(scenePath(sceneId), { method: "DELETE" });
}

/**
 * Builds the scene objects for an existing bone's images, and optionally its
 * annotations, to add to the working copy. Issues #466, #467. Nothing is
 * stored until the scene is saved (Issue #451).
 * @param {string} sceneId
 * @param {string} boneId
 * @param {string[]} [filenames] which of the bone's images to add (default: all)
 * @param {{ labels?: boolean, regions?: boolean }} [annotations] which annotations to add (default: none)
 * @param {number} [originY] where the new row of images starts
 * @returns {Promise<{ images: object[], annotations: object[], importLogEntry: object,
 *   imported: { boneId: string, name: string, count: number },
 *   importedAnnotations?: { labels: number, lines: number, regions: number }, warnings: object[] }>}
 */
export function importLegacyImages(sceneId, boneId, filenames, annotations, originY) {
    const body = { boneId };
    if (filenames) body.filenames = filenames;
    if (annotations) body.annotations = annotations;
    if (originY !== undefined) body.originY = originY;
    return request(`${scenePath(sceneId)}/import-legacy`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

/**
 * Turns an API error into a message a user can act on.
 * @param {Error} error
 * @param {"rename"|"load"|"open"|"create"|"delete"|"import"|"save"|"duplicate"} context
 */
export function describeError(error, context) {
    const status = error instanceof SceneApiError ? error.status : 0;
    switch (status) {
        case 0:
            return "Couldn't reach the server. Check your connection and try again.";
        case 400:
            if (context === "rename") return "Enter a scene name (up to 100 characters).";
            if (context === "save") return `The scene couldn't be saved: ${error.message}.`;
            return `The request was rejected: ${error.message}.`;
        case 404:
            if (context === "import" && !/scene not found/i.test(error.message)) {
                return "That item has no saved content to import.";
            }
            return "This scene is no longer available. It may have been deleted.";
        case 409:
            return "Another scene already uses that name. Choose a different name.";
        case 412:
            return "This scene was changed somewhere else after you opened it.";
        case 413:
            return "This scene is too large to save. Remove or replace a large image and try again.";
        case 422:
            return "That item has no images to import. Choose a different bone.";
        case 423:
            return "The scene is busy right now (another save is in progress). Try again in a moment.";
        case 429:
            return "Too many requests. Wait a moment and try again.";
        case 503:
            return "Scene storage is not configured; try again later or contact the project maintainer.";
        default:
            return "Something went wrong on the server. Try again.";
    }
}

// `active` is the in-browser working copy that every edit and import changes;
// nothing is stored until the user saves (Issue #451). `saved` is the last
// version the server confirmed. Unsaved changes are tracked by revision
// counters instead of comparing the two copies, which can hold megabytes of
// base64 image data. `activeToken` changes whenever a different scene (or
// none) becomes active, so a slow response can tell it no longer belongs to
// the open working copy.
const state = {
    scenes: [],
    active: null,
    saved: null,
    revision: 0,
    savedRevision: 0,
    activeToken: 0,
    saving: false,
    saveFailed: false,
    // The stored version a 412 reported, so "Overwrite" replaces exactly that.
    conflictUpdatedAt: null,
    // The open scene was deleted elsewhere; Save stores the copy as a new scene.
    missing: false,
    // The save-failure prompt. It stays up through redraws until the working
    // copy is saved or discarded, so a later edit can't hide it.
    saveAlert: null,
    openRequest: 0,
    fitToWidth: true,
    busy: false,
    selectedImageIndex: null,
    cropMode: false,
    boneOptions: null,
    importRequest: 0,
};

function deselectImage() {
    state.selectedImageIndex = null;
    state.cropMode = false;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Whether the open scene has edits or imports that haven't been saved yet. */
export function hasUnsavedChanges() {
    return Boolean(state.active) && state.revision !== state.savedRevision;
}

function setActiveScene(scene) {
    state.active = scene;
    state.saved = scene ? clone(scene) : null;
    state.revision = 0;
    state.savedRevision = 0;
    state.activeToken += 1;
    state.saveFailed = false;
    state.conflictUpdatedAt = null;
    state.missing = false;
    state.saveAlert = null;
    deselectImage();
}

/** The parts of a scene a save stores. */
function sceneContent(scene) {
    const content = { images: scene.images, annotations: scene.annotations };
    if (Array.isArray(scene.importLog)) content.importLog = scene.importLog;
    return content;
}

let dom = null;
// Set by startImageDrag's mouseup once a real drag (not just a click) just
// finished, so the canvas's own click handler (select/deselect toggle) knows
// to skip itself for that click - browsers fire `click` after mouseup on the
// same element regardless of how far the mouse moved in between, so without
// this a move/resize drag would immediately deselect the image it just moved.
let suppressNextClick = false;

// Issues #411/#412: importing an image into a scene. The image is read as a
// base64 data: URL - that same string is both the immediate preview `src` and
// what gets saved with the scene, so there's only one representation to
// reason about (see saveScene in the API section above).
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
// Mirror IMAGE_GAP in boneset-api/legacyImport.js and MAX_IMPORT_LOG_ENTRIES
// in boneset-api/scenes.js.
const IMPORT_ROW_GAP = 40;
const MAX_IMPORT_LOG_ENTRIES = 50;

/**
 * The y position just below the working copy's images, so a bone import
 * starts on its own row instead of covering what's already there.
 * @param {object[]} images
 */
function nextImportRowY(images) {
    if (!images || images.length === 0) return 0;
    const bottom = images.reduce((max, image) => Math.max(max, (Number(image.y) || 0) + (Number(image.height) || 0)), 0);
    return bottom + IMPORT_ROW_GAP;
}

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
    updateControls();
}

function saveStatus() {
    if (!state.active) return null;
    if (state.saving) return { state: "saving", text: "Saving…" };
    if (state.saveFailed && hasUnsavedChanges()) return { state: "failed", text: "Save failed" };
    if (hasUnsavedChanges()) return { state: "unsaved", text: "Unsaved changes" };
    return { state: "saved", text: "Saved" };
}

function handleBeforeUnload(event) {
    if (!hasUnsavedChanges() || !dom.editorView.isConnected) return;
    event.preventDefault();
    event.returnValue = "";
}

// Only listening while there's something to lose keeps the page eligible for
// the browser's back/forward cache the rest of the time.
let unloadGuardActive = false;
function syncUnloadGuard() {
    const needed = hasUnsavedChanges();
    if (needed === unloadGuardActive) return;
    unloadGuardActive = needed;
    if (needed) window.addEventListener("beforeunload", handleBeforeUnload);
    else window.removeEventListener("beforeunload", handleBeforeUnload);
}

function updateControls() {
    const locked = state.busy || state.saving;
    dom.newButton.disabled = locked;
    dom.emptyNewButton.disabled = locked;
    dom.renameButton.disabled = locked || !state.active;
    dom.deleteButton.disabled = locked || !state.active;
    dom.duplicateButton.disabled = locked || !state.active;
    dom.saveButton.disabled = locked || !hasUnsavedChanges();
    if (dom.importToggle) {
        dom.importToggle.disabled = state.busy || !state.active;
        dom.importSubmit.disabled = state.busy || !state.boneOptions;
    }

    const status = saveStatus();
    dom.saveStatus.textContent = status ? status.text : "";
    if (status) dom.saveStatus.dataset.state = status.state;
    else delete dom.saveStatus.dataset.state;
    syncUnloadGuard();
}

/** Records a change to the working copy (Issue #451). Callers re-render. */
function markChanged() {
    if (!state.active) return;
    const wasSaved = !hasUnsavedChanges();
    state.revision += 1;
    if (wasSaved) announce("Unsaved changes.");
    updateControls();
}

/**
 * Applies a change to the open scene's working copy and marks it unsaved, for
 * editing tools outside this module (e.g. future annotation tools).
 * @param {(scene: object) => void} mutator
 */
export function updateActiveScene(mutator) {
    if (!state.active) return;
    mutator(state.active);
    markChanged();
    renderWorkspace();
}

/**
 * Asks before an action that would replace the open scene's unsaved changes
 * (Issue #451, related to #444). Nothing is discarded here: the caller only
 * replaces the working copy once its own request succeeds.
 * @returns {boolean} Whether to go ahead.
 */
function confirmDiscard() {
    if (!hasUnsavedChanges()) return true;
    return window.confirm(`Discard unsaved changes to "${state.active.name}"?`);
}

function showLibraryMessage(message, { retry = false } = {}) {
    dom.libraryMessage.hidden = false;
    dom.libraryMessageText.textContent = message;
    dom.libraryRetry.hidden = !retry;
}

function hideLibraryMessage() {
    dom.libraryMessage.hidden = true;
}

/**
 * @param {string} message
 * @param {{ retry?: Function, retryLabel?: string, secondary?: { label: string, action: Function } }} [options]
 */
function showWorkspaceError(message, { retry = null, retryLabel = "Try again", secondary = null } = {}) {
    // Only touch the DOM when something changed, so redraws (e.g. every frame
    // of a drag) don't make screen readers re-announce the alert.
    if (dom.workspaceError.hidden || dom.workspaceErrorText.textContent !== message) {
        dom.workspaceError.hidden = false;
        dom.workspaceErrorText.textContent = message;
    }
    dom.workspaceRetry.hidden = !retry;
    dom.workspaceRetry.textContent = retryLabel;
    dom.workspaceRetry.onclick = retry ? () => retry() : null;
    dom.workspaceSecondary.hidden = !secondary;
    dom.workspaceSecondary.textContent = secondary ? secondary.label : "";
    dom.workspaceSecondary.onclick = secondary ? () => secondary.action() : null;
}

/** Shows a save-failure prompt that stays up until the working copy is saved or discarded. */
function showSaveAlert(message, options) {
    state.saveAlert = { message, options };
    showWorkspaceError(message, options);
}

/**
 * Clears a one-off workspace error. While the working copy has a failed save,
 * its prompt is shown instead, so a redraw or a later edit never hides it.
 */
function hideWorkspaceError() {
    if (state.saveAlert && hasUnsavedChanges()) {
        showWorkspaceError(state.saveAlert.message, state.saveAlert.options);
        return;
    }
    state.saveAlert = null;
    dom.workspaceError.hidden = true;
    dom.workspaceRetry.onclick = null;
    dom.workspaceSecondary.onclick = null;
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

    const { svg, unsupported, unlinked, width, height } = renderScene(scene, {
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

    const notes = [];
    if (unsupported > 0) {
        notes.push(`${plural(unsupported, "object")} can't be displayed yet but are still stored with this scene.`);
    }
    if (unlinked > 0) {
        // An imported annotation whose image was removed keeps its stored
        // position rather than disappearing (PR #493 review).
        notes.push(unlinked === 1
            ? "1 imported annotation no longer has its source image in this scene, so it is shown where it was imported."
            : `${unlinked} imported annotations no longer have their source image in this scene, so they are shown where they were imported.`);
    }
    if (notes.length > 0) {
        dom.canvasNote.hidden = false;
        dom.canvasNote.textContent = notes.join(" ");
    }
}

function renderWorkspace() {
    const scene = state.active;
    hideRenameForm();
    if (!scene) hideImportForm();
    hideWorkspaceError();
    dom.workspaceEmpty.hidden = Boolean(scene);
    dom.workspaceScene.hidden = !scene;
    setBusy(state.busy);
    if (!scene) return;

    dom.sceneTitle.textContent = scene.name;
    dom.sceneMeta.textContent = `${plural(scene.images.length, "image")} · ${plural(scene.annotations.length, "annotation")}`;
    renderSceneSources(scene);
    renderCanvas();
}

/**
 * Lists the bone viewer items this scene's images were imported from, each
 * with a button that opens it in the bone viewer (Issue #469). The original
 * viewer content is kept, so the user can always go back and compare.
 */
function renderSceneSources(scene) {
    if (!dom.sceneSources) return;
    dom.sceneSources.replaceChildren();
    const sources = sceneSources(scene);
    dom.sceneSources.hidden = sources.length === 0;
    if (sources.length === 0) return;

    dom.sceneSources.append("Made from: ");
    sources.forEach((boneId, index) => {
        if (index > 0) dom.sceneSources.append(", ");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "scene-source-link";
        button.textContent = readableName(boneId);
        button.setAttribute("aria-label", `View ${readableName(boneId)} in the bone viewer`);
        button.addEventListener("click", () => showInViewer(boneId));
        dom.sceneSources.append(button);
    });
}

function showInViewer(boneId) {
    leaveEditor();
    document.dispatchEvent(new CustomEvent(SHOW_IN_VIEWER_EVENT, { detail: { boneId } }));
}

/**
 * Opens a scene from the bone viewer's "Open in the Scene Editor" link (Issue #469).
 */
function openSceneFromViewer(sceneId) {
    if (dom.editorView.hidden) enterEditor();
    openScene(sceneId);
}

function clearActiveScene() {
    setActiveScene(null);
    state.openRequest += 1;
    dom.workspace.removeAttribute("aria-busy");
    dom.workspaceLoading.hidden = true;
    renderWorkspace();
    renderLibrary();
}

/**
 * The open scene no longer exists on the server. Without unsaved changes the
 * workspace just closes; with them, the working copy stays on screen and the
 * user chooses to save it as a new scene or discard it (Issue #456).
 * @param {string} message
 */
function handleActiveSceneMissing(message) {
    if (!hasUnsavedChanges()) {
        clearActiveScene();
        showWorkspaceError(message);
        return;
    }
    state.missing = true;
    state.saveFailed = true;
    updateControls();
    showSaveAlert(`${message} Your unsaved changes are still here.`, {
        retry: saveAsNewScene,
        retryLabel: "Save as new scene",
        secondary: { label: "Discard changes", action: discardMissingScene },
    });
}

function discardMissingScene() {
    clearActiveScene();
    announce("Changes discarded.");
    loadLibrary();
}

function updateSummary(scene) {
    const summary = state.scenes.find((s) => s.id === scene.id);
    if (!summary) return;
    summary.name = scene.name;
    summary.imageCount = scene.images.length;
    summary.annotationCount = scene.annotations.length;
    summary.updatedAt = scene.updatedAt;
}

async function loadLibrary() {
    showLibraryMessage("Loading scenes…");
    dom.libraryEmpty.hidden = true;
    try {
        state.scenes = await listScenes();
        hideLibraryMessage();
        if (state.active && !state.missing && !state.scenes.some((s) => s.id === state.active.id)) {
            handleActiveSceneMissing("The scene you had open is no longer available. It may have been deleted.");
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

/**
 * @param {string} sceneId
 * @param {{ force?: boolean }} [options] `force` reloads the saved version
 *   without asking, even if this scene is already open (used after the user
 *   chose to discard their copy in a save conflict).
 */
async function openScene(sceneId, { force = false } = {}) {
    if (!force && state.active && state.active.id === sceneId) return;
    if (!force && !confirmDiscard()) return;

    const requestId = ++state.openRequest;
    if (force) state.saveAlert = null;
    hideWorkspaceError();
    dom.workspace.setAttribute("aria-busy", "true");
    dom.workspaceLoading.hidden = false;
    announce("Opening scene…");

    try {
        const scene = await getScene(sceneId);
        if (requestId !== state.openRequest) return;
        setActiveScene(scene);
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
    if (state.busy || state.saving) return;
    if (!confirmDiscard()) return;
    setBusy(true);
    hideWorkspaceError();
    announce("Creating scene…");
    try {
        const scene = await createScene();
        state.openRequest += 1;
        setActiveScene(scene);
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

/** Whether two scenes have the same saved content (not just the same name). */
function sameContent(a, b) {
    return JSON.stringify(sceneContent(a)) === JSON.stringify(sceneContent(b));
}

async function handleRename(event) {
    event.preventDefault();
    if (!state.active || state.busy || state.saving) return;

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
        // A rename only touches the name, so unsaved content stays unsaved.
        // If nothing else changed the stored scene, the saved baseline moves
        // to the renamed version so the next save isn't mistaken for a stale
        // copy. If someone else saved in between, the baseline stays put and
        // the next save gets the usual conflict prompt.
        if (state.active && state.active.id === sceneId) {
            state.active.name = updated.name;
            state.saved.name = updated.name;
            if (sameContent(updated, state.saved)) {
                state.active.updatedAt = updated.updatedAt;
                state.saved.updatedAt = updated.updatedAt;
            }
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
            hideRenameForm();
            handleActiveSceneMissing(message);
            await loadLibrary();
        } else {
            showRenameError(message);
        }
        announce(message);
    } finally {
        dom.renameSubmit.disabled = false;
    }
}

async function handleDelete() {
    if (!state.active || state.busy || state.saving) return;
    const { id, name } = state.active;
    const unsavedNote = hasUnsavedChanges() ? " Your unsaved changes will also be lost." : "";
    if (!window.confirm(`Delete "${name}"? This permanently removes the scene and can't be undone.${unsavedNote}`)) return;

    setBusy(true);
    state.saveAlert = null;
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
 * Saves the open scene's working copy - every edit and import since the last
 * save - in one request (Issue #452). The server refuses it with 412 if the
 * stored scene changed after this copy was loaded, unless `overwrite` is set
 * after the user chose to replace that newer version (Issue #456).
 * @param {{ overwrite?: boolean }} [options]
 */
async function handleSave({ overwrite = false } = {}) {
    if (!state.active || state.saving || state.busy) return;
    if (state.missing) return saveAsNewScene();
    const token = state.activeToken;
    const scene = state.active;
    const sentRevision = state.revision;
    const baseUpdatedAt = overwrite && state.conflictUpdatedAt ? state.conflictUpdatedAt : state.saved.updatedAt;
    const body = { ...sceneContent(scene) };
    if (baseUpdatedAt) body.baseUpdatedAt = baseUpdatedAt;

    state.saving = true;
    state.saveFailed = false;
    state.saveAlert = null;
    hideWorkspaceError();
    updateControls();
    try {
        const updated = await saveScene(scene.id, body);
        state.saving = false;
        // Edits made while the request was in flight stay unsaved: only the
        // revision that was sent is now saved.
        if (token === state.activeToken) {
            state.saved = clone(updated);
            state.savedRevision = sentRevision;
            state.conflictUpdatedAt = null;
            scene.name = updated.name;
            scene.updatedAt = updated.updatedAt;
            hideWorkspaceError();
        }
        updateSummary(updated);
        updateControls();
        renderLibrary();
        announce(`Saved ${updated.name}.`);
    } catch (error) {
        state.saving = false;
        if (token !== state.activeToken) {
            updateControls();
            return;
        }
        handleSaveError(error);
    }
}

function handleSaveError(error) {
    const message = describeError(error, "save");
    state.saveFailed = true;
    updateControls();
    announce(`Save failed. ${message}`);
    if (error.status === 404) {
        handleActiveSceneMissing(message);
        return;
    }
    if (error.status === 412) {
        state.conflictUpdatedAt = (error.body && error.body.updatedAt) || null;
        showSaveAlert(
            `${message} Overwrite it with your version, or reload the saved version and lose your changes.`,
            {
                retry: () => handleSave({ overwrite: true }),
                retryLabel: "Overwrite with my version",
                secondary: { label: "Reload saved version", action: () => openScene(state.active.id, { force: true }) },
            }
        );
        return;
    }
    showSaveAlert(`${message} Your changes are still here.`, { retry: () => handleSave(), retryLabel: "Retry save" });
}

/**
 * Keeps a working copy whose scene was deleted elsewhere by storing it as a
 * new scene (Issue #456), in one request so a failure can't leave an empty
 * scene behind. Keeps its name if it's still free, otherwise the server's
 * default name. On failure the working copy and both choices stay.
 */
async function saveAsNewScene() {
    if (!state.active || state.saving || state.busy) return;
    const token = state.activeToken;
    const scene = state.active;
    const revision = state.revision;
    const content = sceneContent(scene);

    state.saving = true;
    state.saveFailed = false;
    state.saveAlert = null;
    hideWorkspaceError();
    updateControls();
    announce("Saving as a new scene\u2026");
    try {
        let created;
        try {
            created = await createScene({ ...content, name: scene.name });
        } catch (error) {
            if (error.status !== 409) throw error;
            created = await createScene(content);
        }
        state.saving = false;
        if (token !== state.activeToken) {
            updateControls();
            await loadLibrary();
            return;
        }
        Object.assign(scene, { id: created.id, name: created.name, createdAt: created.createdAt, updatedAt: created.updatedAt });
        state.saved = clone(created);
        state.savedRevision = revision;
        state.missing = false;
        state.saveFailed = false;
        renderWorkspace();
        await loadLibrary();
        announce(`Saved as ${created.name}.`);
    } catch (error) {
        state.saving = false;
        if (token !== state.activeToken) {
            updateControls();
            return;
        }
        const message = describeError(error, "save");
        announce(`Save failed. ${message}`);
        handleActiveSceneMissing(`${message} The scene you had open was deleted.`);
    }
}

/**
 * Opens a copy of the open scene's last saved version (Issue #455). Unsaved
 * changes aren't part of the copy, so the user is asked first.
 */
async function handleDuplicate() {
    if (!state.active || state.busy || state.saving) return;
    const { id, name } = state.active;
    if (hasUnsavedChanges() && !window.confirm(
        `"${name}" has unsaved changes. The duplicate copies the last saved version, ` +
        "and your unsaved changes will be discarded when the copy opens. Continue?"
    )) return;

    setBusy(true);
    hideWorkspaceError();
    announce("Duplicating scene\u2026");
    try {
        const copy = await duplicateScene(id);
        state.openRequest += 1;
        state.saveAlert = null;
        setActiveScene(copy);
        await loadLibrary();
        setBusy(false);
        renderWorkspace();
        renderLibrary();
        announce(`Opened ${copy.name}, a copy of ${name}.`);
        dom.sceneTitle.focus();
    } catch (error) {
        setBusy(false);
        const message = describeError(error, "duplicate");
        if (error.status === 404) {
            handleActiveSceneMissing(message);
            await loadLibrary();
        } else {
            showWorkspaceError(message, { retry: handleDuplicate });
        }
        announce(message);
    }
}

/** Removes the selected image from the working copy (Issue #418). */
function handleImageRemove() {
    if (!state.active || state.selectedImageIndex === null) return;
    const index = state.selectedImageIndex;
    if (!state.active.images[index]) return;
    state.active.images.splice(index, 1);
    deselectImage();
    markChanged();
    renderWorkspace();
}

/**
 * Applies a field-level change to the selected image in the working copy
 * (Issues #413-417: position, resize, rotate, flip, crop). Used by the
 * toolbar buttons; a drag applies its own changes live frame-by-frame.
 * @param {object} fields - The new values to set, e.g. `{ rotation: 90 }`.
 */
function applySelectedImageUpdate(fields) {
    if (!state.active || state.selectedImageIndex === null) return;
    const image = state.active.images[state.selectedImageIndex];
    if (!image) return;
    Object.assign(image, fields);
    markChanged();
    renderWorkspace();
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
function moveSelectedImage(direction) {
    if (!state.active || state.selectedImageIndex === null) return;
    const images = state.active.images;
    const index = state.selectedImageIndex;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= images.length) return;
    [images[index], images[targetIndex]] = [images[targetIndex], images[index]];
    state.selectedImageIndex = targetIndex;
    markChanged();
    renderWorkspace();
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
        if (didDrag) markChanged();
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
        if (didDrag) markChanged();
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
 * adjustment was already applied to the working copy by its drag gesture. */
function exitCropMode() {
    state.cropMode = false;
    renderCanvas();
}

/** Clears the selected image's crop back to fully visible. */
function resetSelectedImageCrop() {
    if (!state.active || state.selectedImageIndex === null) return;
    const image = state.active.images[state.selectedImageIndex];
    if (!image) return;
    applySelectedImageUpdate({ cropX: 0, cropY: 0, cropWidth: image.width, cropHeight: image.height });
}

/**
 * Imports one or more image files into the currently open scene as new,
 * unselected image objects in the working copy (Issues #411/#412). They're
 * stored with the next Save. Unsupported or oversized files are skipped with
 * a combined error message rather than aborting the whole import.
 * @param {FileList|File[]} fileList - Files chosen via the import input.
 * @returns {Promise<void>}
 */
async function handleImportFiles(fileList) {
    if (!state.active || !fileList || fileList.length === 0) return;
    // The user can open a different scene while a file is still being read;
    // images read for the scene they left are dropped with it.
    const token = state.activeToken;
    const baseImageCount = state.active.images.length;
    let totalSrcLength = state.active.images.reduce((sum, img) => sum + img.src.length, 0);

    dom.imageImportError.hidden = true;
    dom.imageImportError.textContent = "";

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
            if (token === state.activeToken) state.active.images.push(image);
        } catch {
            skipped.push(`${file.name} (could not be read)`);
        }
    }

    if (token !== state.activeToken) return;
    if (skipped.length > 0) {
        const addedPart = added.length > 0 ? `${plural(added.length, "image")} added. ` : "";
        dom.imageImportError.hidden = false;
        dom.imageImportError.textContent =
            `${addedPart}${plural(skipped.length, "file")} skipped: ${skipped.join(", ")}.`;
    }

    if (added.length > 0) {
        markChanged();
        renderWorkspace();
        announce(`${plural(added.length, "image")} added to the scene. Save to keep ${added.length === 1 ? "it" : "them"}.`);
    }
}

// ---------------------------------------------------------------------------
// Import images from an existing bone (Issue #466)
// ---------------------------------------------------------------------------

/**
 * Builds the bone list for the import picker from /combined-data: each boneset,
 * followed by its bones, each followed by its bone parts.
 */
async function loadBoneOptions() {
    if (state.boneOptions) return state.boneOptions;
    const response = await fetch("/combined-data");
    if (!response.ok) throw new SceneApiError(response.status, `HTTP ${response.status}`);
    const data = await response.json();

    const groups = (data.bonesets || []).map((boneset) => {
        const options = [{ id: boneset.id, label: `${boneset.name} (whole boneset)` }];
        for (const bone of (data.bones || []).filter((b) => b.boneset === boneset.id)) {
            options.push({ id: bone.id, label: bone.name });
            for (const part of (data.subbones || []).filter((sb) => sb.bone === bone.id)) {
                options.push({ id: part.id, label: `\u2014 ${part.name}` });
            }
        }
        return { label: boneset.name, options };
    });
    state.boneOptions = groups;
    return groups;
}

function renderBoneOptions(groups) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a bone\u2026";
    dom.importSelect.replaceChildren(placeholder);

    for (const group of groups) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group.label;
        for (const { id, label } of group.options) {
            const option = document.createElement("option");
            option.value = id;
            option.textContent = label;
            optgroup.append(option);
        }
        dom.importSelect.append(optgroup);
    }
    dom.importSelect.disabled = false;
}

function showImportError(message) {
    dom.importError.hidden = false;
    dom.importError.textContent = message;
}

function clearImageChoices() {
    state.importRequest += 1;
    dom.importImageList.replaceChildren();
    dom.importImages.hidden = true;
    if (dom.importExtras) dom.importExtras.hidden = true;
}

function hideImportForm() {
    if (!dom || !dom.importForm) return;
    dom.importForm.hidden = true;
    dom.importError.hidden = true;
    dom.importSelect.value = "";
    clearImageChoices();
    if (dom.importLabels) {
        dom.importLabels.checked = true;
        dom.importRegions.checked = true;
    }
    dom.importToggle.setAttribute("aria-expanded", "false");
}

/**
 * Shows a checkbox (with a small preview) for each of the chosen bone's images,
 * all selected by default, in the order the viewer shows them.
 */
function renderImageChoices(images) {
    if (images.length === 0) {
        showImportError("That item has no images to import. Choose a different bone.");
        return;
    }
    for (const image of images) {
        const choice = document.createElement("label");
        choice.className = "scene-import-image";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = image.filename;
        checkbox.checked = true;

        const preview = document.createElement("img");
        preview.src = image.url;
        preview.alt = "";
        preview.loading = "lazy";

        const name = document.createElement("span");
        name.textContent = image.filename;

        choice.append(checkbox, preview, name);
        dom.importImageList.append(choice);
    }
    dom.importImages.hidden = false;
    if (dom.importExtras) dom.importExtras.hidden = false;
}

async function handleImportBoneChange() {
    clearImageChoices();
    dom.importError.hidden = true;
    const boneId = dom.importSelect.value;
    if (!boneId) return;

    const requestId = state.importRequest;
    try {
        const response = await fetch(`/api/bone-data/?boneId=${encodeURIComponent(boneId)}`);
        if (requestId !== state.importRequest) return;
        if (!response.ok) {
            showImportError(response.status === 404
                ? "That item has no saved content to import."
                : "Couldn't load that bone's images. Try again.");
            return;
        }
        const data = await response.json();
        if (requestId !== state.importRequest) return;
        renderImageChoices(data.images || []);
    } catch {
        if (requestId === state.importRequest) showImportError("Couldn't load that bone's images. Try again.");
    }
}

async function showImportForm() {
    dom.importForm.hidden = false;
    dom.importError.hidden = true;
    dom.importToggle.setAttribute("aria-expanded", "true");
    dom.importSelect.focus();
    if (state.boneOptions) return;

    try {
        renderBoneOptions(await loadBoneOptions());
        setBusy(state.busy);
    } catch {
        showImportError("Couldn't load the list of bones. Close this form and try again.");
    }
}

async function handleImport(event) {
    event.preventDefault();
    if (state.busy || !state.active) return;

    const boneId = dom.importSelect.value;
    if (!boneId) {
        showImportError("Choose a bone to import.");
        dom.importSelect.focus();
        return;
    }

    const choices = [...dom.importImageList.querySelectorAll("input[type=checkbox]")];
    const filenames = choices.filter((choice) => choice.checked).map((choice) => choice.value);
    if (filenames.length === 0) {
        showImportError(choices.length === 0
            ? "Wait for the bone's images to load, or choose a different bone."
            : "Choose at least one image to import.");
        return;
    }

    const label = dom.importSelect.selectedOptions[0].textContent.replace(/^\u2014\s*/, "");
    // Captured before any await: the scene list stays clickable during an
    // import, so state.active may be a different scene by the time it finishes.
    const token = state.activeToken;
    const sceneId = state.active.id;
    const originY = nextImportRowY(state.active.images);
    setBusy(true);
    dom.importError.hidden = true;
    announce(`Importing images from ${label}\u2026`);
    try {
        const annotations = dom.importLabels
            ? { labels: dom.importLabels.checked, regions: dom.importRegions.checked }
            : undefined;
        const result = await importLegacyImages(sceneId, boneId, filenames, annotations, originY);
        const { imported, importedAnnotations, warnings } = result;
        if (token !== state.activeToken) {
            setBusy(false);
            hideImportForm();
            announce(`The import from ${imported.name} was dropped because a different scene was opened.`);
            return;
        }
        // The import only changes the working copy; it's stored with the
        // user's other edits on the next Save (Issue #452).
        const scene = state.active;
        scene.images.push(...(result.images || []));
        scene.annotations = [...(scene.annotations || []), ...(result.annotations || [])];
        if (result.importLogEntry) {
            scene.importLog = [...(scene.importLog || []), result.importLogEntry].slice(-MAX_IMPORT_LOG_ENTRIES);
        }
        markChanged();
        setBusy(false);
        hideImportForm();
        renderWorkspace();

        const annotationCount = importedAnnotations
            ? importedAnnotations.labels + importedAnnotations.lines + importedAnnotations.regions
            : 0;
        let message = annotationCount > 0
            ? `Imported ${plural(imported.count, "image")} and ${plural(annotationCount, "annotation")} from ${imported.name}.`
            : `Imported ${plural(imported.count, "image")} from ${imported.name}.`;
        message += " Save to keep the import.";
        if (warnings && warnings.length > 0) {
            message += ` ${plural(warnings.length, "import note")} below.`;
            dom.canvasNote.hidden = false;
            dom.canvasNote.textContent = `Import notes: ${warnings
                .map((w) => `${w.filename || w.item}: ${w.reason}`)
                .join("; ")}.`;
        }
        announce(message);
        dom.importToggle.focus();
    } catch (error) {
        setBusy(false);
        const message = describeError(error, "import");
        showImportError(message);
        announce(message);
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
        workspaceSecondary: $("scene-workspace-secondary"),
        titleRow: $("scene-title-row"),
        sceneTitle: $("scene-title"),
        sceneMeta: $("scene-meta"),
        sceneSources: $("scene-sources"),
        saveStatus: $("scene-save-status"),
        saveButton: $("scene-save"),
        duplicateButton: $("scene-duplicate"),
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
        imageImportError: $("scene-image-import-error"),
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
        importToggle: $("scene-import-toggle"),
        importForm: $("scene-import-form"),
        importSelect: $("scene-import-select"),
        importSubmit: $("scene-import-submit"),
        importCancel: $("scene-import-cancel"),
        importError: $("scene-import-error"),
        importImages: $("scene-import-images"),
        importImageList: $("scene-import-image-list"),
        importExtras: $("scene-import-extras"),
        importLabels: $("scene-import-labels"),
        importRegions: $("scene-import-regions"),
    };
    if (!dom.editorView || !dom.enterButton) return;

    dom.enterButton.addEventListener("click", () => {
        if (dom.editorView.hidden) enterEditor();
        else leaveEditor();
    });
    dom.backButton.addEventListener("click", leaveEditor);
    const editorView = dom.editorView;
    document.addEventListener(OPEN_SCENE_EVENT, (event) => {
        // Skip if this page was re-rendered and this editor is no longer on it.
        if (!editorView.isConnected || !event.detail || !event.detail.sceneId) return;
        openSceneFromViewer(event.detail.sceneId);
    });
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
    if (dom.saveButton) dom.saveButton.addEventListener("click", () => handleSave());
    if (dom.duplicateButton) dom.duplicateButton.addEventListener("click", handleDuplicate);
    dom.fitToggle.addEventListener("click", () => setFitToWidth(!state.fitToWidth));
    if (dom.importToggle) {
        dom.importToggle.addEventListener("click", () => {
            if (dom.importForm.hidden) showImportForm();
            else hideImportForm();
        });
        dom.importForm.addEventListener("submit", handleImport);
        dom.importSelect.addEventListener("change", handleImportBoneChange);
        dom.importCancel.addEventListener("click", () => {
            hideImportForm();
            dom.importToggle.focus();
        });
    }

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