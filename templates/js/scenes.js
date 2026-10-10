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

export function deleteScene(sceneId) {
    return request(scenePath(sceneId), { method: "DELETE" });
}

/**
 * Adds an existing bone's images, and optionally its annotations, to a scene. Issues #466, #467.
 * @param {string} sceneId
 * @param {string} boneId
 * @param {string[]} [filenames] which of the bone's images to add (default: all)
 * @param {{ labels?: boolean, regions?: boolean }} [annotations] which annotations to add (default: none)
 * @returns {Promise<{ scene: object, imported: { boneId: string, name: string, count: number },
 *   importedAnnotations?: { labels: number, lines: number, regions: number }, warnings: object[] }>}
 */
export function importLegacyImages(sceneId, boneId, filenames, annotations) {
    const body = { boneId };
    if (filenames) body.filenames = filenames;
    if (annotations) body.annotations = annotations;
    return request(`${scenePath(sceneId)}/import-legacy`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

/**
 * Turns an API error into a message a user can act on.
 * @param {Error} error
 * @param {"rename"|"load"|"open"|"create"|"delete"|"import"} context
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
            if (context === "import" && !/scene not found/i.test(error.message)) {
                return "That item has no saved content to import.";
            }
            return "This scene is no longer available. It may have been deleted.";
        case 409:
            return "Another scene already uses that name. Choose a different name.";
        case 422:
            return "That item has no images to import. Choose a different bone.";
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
    boneOptions: null,
    importRequest: 0,
};

let dom = null;

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
    if (dom.importToggle) {
        dom.importToggle.disabled = busy || !state.active;
        dom.importSubmit.disabled = busy || !state.boneOptions;
    }
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

    const { svg, unsupported, width, height } = renderScene(scene);
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
    if (!scene) hideImportForm();
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
    setBusy(true);
    dom.importError.hidden = true;
    announce(`Importing images from ${label}\u2026`);
    try {
        const annotations = dom.importLabels
            ? { labels: dom.importLabels.checked, regions: dom.importRegions.checked }
            : undefined;
        const { scene, imported, importedAnnotations, warnings } =
            await importLegacyImages(state.active.id, boneId, filenames, annotations);
        state.active = scene;
        setBusy(false);
        hideImportForm();
        renderWorkspace();
        await loadLibrary();

        const annotationCount = importedAnnotations
            ? importedAnnotations.labels + importedAnnotations.lines + importedAnnotations.regions
            : 0;
        let message = annotationCount > 0
            ? `Imported ${plural(imported.count, "image")} and ${plural(annotationCount, "annotation")} from ${imported.name}.`
            : `Imported ${plural(imported.count, "image")} from ${imported.name}.`;
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

    renderWorkspace();
}

document.addEventListener("DOMContentLoaded", () => initializeSceneEditor());