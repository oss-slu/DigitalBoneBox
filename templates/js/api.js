const API_CONFIG = {
    BASE_URL: "http://127.0.0.1:8000",
    ENDPOINTS: {
        COMBINED_DATA: "/combined-data",
        MOCK_BONE_DATA: "./js/mock-bone-data.json",
        BONE_DATA: "/api/bone-data"
    }
};

export async function fetchCombinedData() {
    const API_URL = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.COMBINED_DATA}`;

    try {
        const response = await fetch(API_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error("Error fetching combined data:", error);
        throw error;
    }
}

/**
 * Fetch full bone data (description + images) for a single bone from the backend API.
 * The backend pulls these files from the data GitHub branch.
 * @param {string} boneId
 * @returns {Object|null} bone data or null on error
 */
export async function fetchBoneData(boneId) {
    if (!boneId) return null;

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.BONE_DATA}/?boneId=${encodeURIComponent(boneId)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`HTTP error! status: ${resp.status}`);
        }
        return await resp.json();
    } catch (err) {
        console.error(`Error fetching bone data for ${boneId}:`, err);
        return null;
    }
}

// Export configuration for other modules to use
export { API_CONFIG };
