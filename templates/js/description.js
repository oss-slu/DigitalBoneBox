import { fetchDescription } from "./api.js";

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
