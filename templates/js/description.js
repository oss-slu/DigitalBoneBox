import { fetchDescription } from "./api.js";

/**
 * Fetches the description HTML for the given bone/subbone ID and
 * places it inside the `#description-Container` element.
 * Shows an error message in the container if the fetch fails.
 * @param {string} id - The bone or subbone ID (e.g. `"ilium"`, `"iliac_crest"`),
 *   used to construct the filename `{id}_description.json`.
 * @returns {Promise<void>}
 */
// Counts requests so a slow answer for an item the user already left can't
// replace the description they're reading now (Issue #469).
let latestRequest = 0;

export async function loadDescription(id) {
    const container = document.getElementById("description-Container");
    container.innerHTML = "";
    const requestId = ++latestRequest;

    try {
        const html = await fetchDescription(id);
        if (requestId !== latestRequest) return;
        container.innerHTML = html;
    } catch (error) {
        if (requestId !== latestRequest) return;
        container.innerHTML = "<li>Error loading description.</li>";
        console.error("Failed to fetch description:", error);
    }
}
