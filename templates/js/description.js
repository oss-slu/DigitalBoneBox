const GITHUB_RAW_URL = "https://raw.githubusercontent.com/oss-slu/DigitalBonesBox/data/data/descriptions/";

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
