// Links between the bone viewer and the Scene Editor while content is being
// migrated (Issue #469). Old bone viewer content and new scenes are both kept,
// so the viewer shows which scenes were made from the item that's open, and the
// Scene Editor can send the user back to the item a scene came from.

// Events the two views use to talk to each other.
export const OPEN_SCENE_EVENT = "bonebox:open-scene";
export const SHOW_IN_VIEWER_EVENT = "bonebox:show-in-viewer";

let latestRequest = 0;

/**
 * Turns an id like "iliac_crest" into a readable name ("Iliac crest").
 * @param {string} boneId
 * @returns {string}
 */
export function readableName(boneId) {
    const text = String(boneId || "").replace(/_/g, " ").trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Gets the saved scenes that have images imported from this item.
 * Returns an empty list if scenes can't be loaded, so the viewer still works
 * when the scene store is down.
 * @param {string} boneId
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function fetchScenesForItem(boneId) {
    try {
        const response = await fetch("/api/scenes");
        if (!response.ok) return [];
        const body = await response.json();
        const scenes = Array.isArray(body.scenes) ? body.scenes : [];
        return scenes.filter((scene) => Array.isArray(scene.sources) && scene.sources.includes(boneId));
    } catch (error) {
        console.warn("Could not load scenes for the bone viewer:", error);
        return [];
    }
}

function hideLinks(box) {
    box.hidden = true;
    box.replaceChildren();
}

/**
 * Shows buttons under the viewer's images for every scene made from this item.
 * Hides the box when there are none, so items that haven't been migrated look
 * exactly the same as before.
 * @param {string|null} boneId
 * @returns {Promise<void>}
 */
export async function showSceneLinks(boneId) {
    const box = document.getElementById("viewer-scene-links");
    if (!box) return;

    const requestId = ++latestRequest;
    hideLinks(box);
    if (!boneId) return;

    const scenes = await fetchScenesForItem(boneId);
    // Ignore the answer if the user already picked a different item.
    if (requestId !== latestRequest || scenes.length === 0) return;

    const label = document.createElement("p");
    label.className = "viewer-scene-links-label";
    label.textContent = scenes.length === 1
        ? "There is also a scene made from this item:"
        : `There are also ${scenes.length} scenes made from this item:`;
    box.append(label);

    for (const scene of scenes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "viewer-scene-link";
        button.textContent = `Open "${scene.name}" in the Scene Editor`;
        button.addEventListener("click", () => {
            document.dispatchEvent(new CustomEvent(OPEN_SCENE_EVENT, { detail: { sceneId: scene.id } }));
        });
        box.append(button);
    }
    box.hidden = false;
}

/**
 * The viewer items a scene's images were imported from, in order, without repeats.
 * @param {object} scene
 * @returns {string[]}
 */
export function sceneSources(scene) {
    const boneIds = ((scene && scene.images) || [])
        .filter((image) => image && image.source && image.source.type === "legacy-image")
        .map((image) => image.source.boneId)
        .filter((boneId) => typeof boneId === "string");
    return [...new Set(boneIds)];
}
