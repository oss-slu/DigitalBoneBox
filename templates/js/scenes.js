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
            return "Another scene already uses that name. Choose a different name.";
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
};

let dom = null;

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

function renderCanvas() {
    const scene = state.active;
    dom.canvas.replaceChildren();
    const isEmpty = scene.images.length === 0 && scene.annotations.length === 0;
    dom.canvasEmpty.hidden = !isEmpty;
    dom.canvas.hidden = isEmpty;
    dom.fitToggle.hidden = isEmpty;
    dom.canvasNote.hidden = true;
    if (isEmpty) return;

    const { svg, unsupported, width, height } = renderScene(scene, { selectedIndex: state.selectedImageIndex });
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
    state.selectedImageIndex = null;
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
        state.selectedImageIndex = null;
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
        state.selectedImageIndex = null;
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
    for (const image of images) {
        try {
            await saveImageToScene(sceneId, image);
        } catch {
            stillFailing.push(image);
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
            const natural = await loadImageDimensions(dataUrl);
            const { width, height } = scaleToFit(natural.width, natural.height, MAX_IMPORT_DIMENSION);
            const offset = IMPORT_OFFSET_STEP * (state.active.images.length + 1);
            const image = { id: crypto.randomUUID(), src: dataUrl, x: offset, y: offset, width, height };
            state.active.images.push(image);
            added.push(image);
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
        renderWorkspace();
        announce(`${plural(added.length, "image")} added to the scene.`);
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
        const target = event.target.closest("[data-scene-image-index]");
        const index = target ? Number(target.dataset.sceneImageIndex) : null;
        state.selectedImageIndex = state.selectedImageIndex === index ? null : index;
        renderCanvas();
    });
    dom.canvas.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && state.selectedImageIndex !== null) {
            state.selectedImageIndex = null;
            renderCanvas();
        }
    });

    renderWorkspace();
}

document.addEventListener("DOMContentLoaded", () => initializeSceneEditor());
