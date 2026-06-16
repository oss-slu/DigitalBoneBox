import { fetchSearch } from "./api.js";

let selectedIndex = -1;
let searchTimeout;
let isInitialized = false;

/**
 * Sets up the search bar's input, keyboard navigation, and outside-click
 * handlers. Should be called once after the DOM is ready.
 * @returns {void}
 */
export function initializeSearch() {
    if (isInitialized) return;
    const searchBar = document.getElementById("search-bar");
    const searchResultsContainer = document.getElementById("search-results");
    const searchLoading = document.getElementById("search-loading");
    
    if (!searchBar || !searchResultsContainer) {
        console.error("Search elements not found");
        return;
    }

    console.log("Search initialized");
    isInitialized = true;
    
    // Handle typing in search bar
    searchBar.addEventListener("input", (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        
        if (query.length < 2) {
            searchResultsContainer.innerHTML = "";
            searchLoading.style.display = "none";
            return;
        }
        
        searchLoading.style.display = "block";
        
        searchTimeout = setTimeout(() => {
            performSearch(query);
        }, 300);
    });

    // Handle keyboard navigation
    searchBar.addEventListener("keydown", (e) => {
        const results = searchResultsContainer.querySelectorAll(".search-result");
        
        if (e.key === "ArrowDown") {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
            updateSelection(results);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateSelection(results);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (selectedIndex >= 0 && results[selectedIndex]) {
                selectSearchResult(results[selectedIndex]);
            }
        } else if (e.key === "Escape") {
            clearSearch();
        }
    });

    // Handle clicks outside search to close results
    document.addEventListener("click", (e) => {
        if (!searchBar.contains(e.target) && !searchResultsContainer.contains(e.target)) {
            if (!e.target.closest(".search-result")) {
                clearSearchResults();
            }
        }
    });
}

/**
 * Sends a search query to the API and renders the resulting HTML into
 * the search-results container.
 * @param {string} query - The search string typed by the user.
 * @returns {Promise<void>}
 */
async function performSearch(query) {
    const searchResultsContainer = document.getElementById("search-results");
    const searchLoading = document.getElementById("search-loading");
    
    try {
        console.log("Performing search for:", query);
        const html = await fetchSearch(query);
        searchResultsContainer.innerHTML = html;
        searchLoading.style.display = "none";
        selectedIndex = -1;
        
        attachClickHandlers();
        
    } catch (error) {
        console.error("Search error:", error);
        searchResultsContainer.innerHTML = "<li class=\"search-error\">Search failed. Please try again.</li>";
        searchLoading.style.display = "none";
    }
}

/**
 * Attaches click-event listeners to every `.search-result` element currently
 * in the DOM so that clicking one triggers {@link selectSearchResult}.
 * @returns {void}
 */
function attachClickHandlers() {
    const results = document.querySelectorAll(".search-result");
    results.forEach(result => {
        result.addEventListener("click", (e) => {
            e.preventDefault();
            selectSearchResult(result);
        });
    });
}

/**
 * Highlights the result at `selectedIndex` and removes highlighting from all
 * others, scrolling the highlighted item into view.
 * @param {NodeListOf<HTMLElement>} results - The current set of result elements.
 * @returns {void}
 */
function updateSelection(results) {
    results.forEach((result, index) => {
        if (index === selectedIndex) {
            result.classList.add("selected");
            result.scrollIntoView({ block: "nearest" });
        } else {
            result.classList.remove("selected");
        }
    });
}

/**
 * Reads the data attributes from a result element and delegates to
 * {@link updateDropdowns} to navigate the main viewer to that bone.
 * @param {HTMLElement} resultElement - The clicked or keyboard-selected result
 *   element carrying `data-type`, `data-boneset`, `data-bone`, and optionally
 *   `data-subbone` attributes.
 * @returns {void}
 */
function selectSearchResult(resultElement) {
    const type = resultElement.dataset.type;
    const bonesetId = resultElement.dataset.boneset;
    const boneId = resultElement.dataset.bone;
    const subboneId = resultElement.dataset.subbone;

    console.log("Selected search result:", { type, bonesetId, boneId, subboneId });

    // Update dropdowns based on search result
    updateDropdowns(type, bonesetId, boneId, subboneId);
    
    // Clear search after selection
    clearSearch();
}

/**
 * Cascades selection through the boneset → bone → subbone dropdowns by
 * dispatching `change` events with short timeouts between each tier.
 * @param {string} type - The type of result: `'boneset'`, `'bone'`, or `'subbone'`.
 * @param {string} bonesetId - The boneset ID to set on the boneset dropdown.
 * @param {string} boneId - The bone ID to set on the bone dropdown (when relevant).
 * @param {string} subboneId - The subbone ID to set on the subbone dropdown
 *   (only used when `type` is `'subbone'`).
 * @returns {void}
 */
function updateDropdowns(type, bonesetId, boneId, subboneId) {
    const bonesetSelect = document.getElementById("boneset-select");
    const boneSelect = document.getElementById("bone-select");
    const subboneSelect = document.getElementById("subbone-select");

    // Always set boneset first
    if (bonesetId && bonesetSelect) {
        bonesetSelect.value = bonesetId;
        bonesetSelect.dispatchEvent(new Event("change"));
        
        // Wait for bone dropdown to populate, then set bone
        if (boneId && (type === "bone" || type === "subbone")) {
            setTimeout(() => {
                if (boneSelect) {
                    boneSelect.disabled = false;
                    boneSelect.value = boneId;
                    boneSelect.dispatchEvent(new Event("change"));
                    
                    // Wait for subbone dropdown to populate, then set subbone
                    if (subboneId && type === "subbone") {
                        setTimeout(() => {
                            if (subboneSelect) {
                                subboneSelect.disabled = false;
                                subboneSelect.value = subboneId;
                                subboneSelect.dispatchEvent(new Event("change"));
                            }
                        }, 200);
                    }
                }
            }, 200);
        }
    }
}

/**
 * Clears the search bar input and removes all results.
 * @returns {void}
 */
function clearSearch() {
    const searchBar = document.getElementById("search-bar");
    searchBar.value = "";
    clearSearchResults();
}

/**
 * Empties the search-results container, hides the loading indicator, and
 * resets the keyboard-navigation index.
 * @returns {void}
 */
function clearSearchResults() {
    const searchResults = document.getElementById("search-results");
    const searchLoading = document.getElementById("search-loading");
    
    if (searchResults) {
        searchResults.innerHTML = "";
    }
    if (searchLoading) {
        searchLoading.style.display = "none";
    }
    selectedIndex = -1;
}

document.addEventListener("DOMContentLoaded", initializeSearch);