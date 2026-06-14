const API_CONFIG = {
    BASE_URL: "http://127.0.0.1:8000",
    ENDPOINTS: {
        COMBINED_DATA: "/combined-data",
        MOCK_BONE_DATA: "./js/mock-bone-data.json",
        BONE_DATA: "/api/bone-data",
        COLORED_REGIONS: "/api/colored-regions",
        ANNOTATIONS: "/api/annotations",
        SEARCH: "/api/search",
        DESCRIPTION: "/api/description"
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

/**
 * Fetch colored region data for a specific bone from the API server
 * @param {string} boneId - The bone identifier (e.g., "pubis", "ilium")
 * @returns {Object|null} - The colored region data or null if not available
 */
export async function fetchColoredRegionsData(boneId) {
    if (!boneId) return null;

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.COLORED_REGIONS}?boneId=${encodeURIComponent(boneId)}`;
    try {
        const response = await fetch(url, {
            cache: "no-store",
            headers: {
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            }
        });

        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            console.warn(`[ColoredRegions] API returned status ${response.status}: ${response.statusText}`);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error(`Error fetching colored regions for ${boneId}:`, error);
        return null;
    }
}

/**
 * Fetch annotation data for a specific bone from the API server
 * @param {string} boneId - The bone identifier
 * @returns {Object|null} - The annotation data (includes annotations and normalized_geometry) or null on error
 */
export async function fetchAnnotations(boneId) {
    if (!boneId) return null;

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.ANNOTATIONS}/${encodeURIComponent(boneId)}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error fetching annotations for ${boneId}:`, error);
        return null;
    }
}

/**
 * Fetch search results from the API server
 * @param {string} query - The search query string
 * @returns {string} - HTML content with search results or error message
 */
export async function fetchSearch(query) {
    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}?q=${encodeURIComponent(query)}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error("Error performing search:", error);
        return "<li class='search-error'>Search error occurred</li>";
    }
}

/**
 * Fetch description data for a specific bone from the API server
 * @param {string} boneId - The bone identifier
 * @returns {string} - HTML content with description or error message
 */
export async function fetchDescription(boneId) {
    if (!boneId) return " ";

    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.DESCRIPTION}/?boneId=${encodeURIComponent(boneId)}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error(`Error fetching description for ${boneId}:`, error);
        return "<li>Error loading description.</li>";
    }
}

// Export configuration for other modules to use
export { API_CONFIG };
