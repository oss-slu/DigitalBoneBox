import { fetchDescription } from "./api.js";

/**
 * Fetches the description HTML for the given bone/subbone ID and
 * places it inside the `#description-Container` element.
 * Shows an error message in the container if the fetch fails.
 * @param {string} id - The bone or subbone ID (e.g. `"ilium"`, `"iliac_crest"`),
 *   used to construct the filename `{id}_description.json`.
 * @returns {Promise<void>}
 */
export async function loadDescription(id) {
    const container = document.getElementById("description-Container");
    container.innerHTML = "";

    try {
        const html = await fetchDescription(id);
        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = "<li>Error loading description.</li>";
        console.error("Failed to fetch description:", error);
    }
}
