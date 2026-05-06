export async function initializeSidebar() {
    const toggleButton = document.getElementById("toggle-sidebar");
    const sidebarContainer = document.getElementById("sidebar-container");

    async function loadSidebar() {
        if (!sidebarContainer.innerHTML) {
            try {
                const response = await fetch("sidebar.html");
                const sidebarHTML = await response.text();
                sidebarContainer.innerHTML = sidebarHTML;
            } catch (error) {
                console.error("Error loading sidebar:", error);
            }
        }
    }

    if (toggleButton) {
        toggleButton.addEventListener("click", async () => {
            await loadSidebar();
            const sidebarElement = document.getElementById("sidebar");

            if (sidebarElement) {
                const currentLeft = window.getComputedStyle(sidebarElement).left;
                if (currentLeft === "0px") {
                    sidebarElement.style.left = "-300px"; // Close sidebar
                } else {
                    sidebarElement.style.left = "0px"; // Open sidebar
                }
            }
        });
    }
}