// js/description.js
const GITHUB_RAW_URL = "https://raw.githubusercontent.com/oss-slu/DigitalBonesBox/data/data/descriptions/";

/**
 * Fetches the description JSON for the given bone/subbone ID and
 * renders it as a list of bullet points inside the `#description-Container` element.
 * Shows an error message in the container if the fetch fails.
 * @param {string} id - The bone or subbone ID (e.g. `"ilium"`, `"iliac_crest"`),
 *   used to construct the filename `{id}_description.json`.
 * @returns {Promise<void>}
 */
export async function loadDescription(id) {
    const container = document.getElementById("description-Container");
    container.innerHTML = "";
    const descUrl = `${GITHUB_RAW_URL}${id}_description.json`;

    try {
        const response = await fetch(descUrl);
        const data = await response.json();

        const nameItem = document.createElement("li");
        nameItem.innerHTML = `<strong>${data.name}</strong>`;
        container.appendChild(nameItem);

        data.description.forEach(point => {
            const li = document.createElement("li");
            li.textContent = point;
            container.appendChild(li);
        });
    } catch (error) {
        container.innerHTML = "<li>Error loading description.</li>";
        console.error("Failed to fetch description:", error);
    }
}
