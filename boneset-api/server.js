// boneset-api/server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const fs = require("fs").promises; // Use promises for async/await file reading
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const GITHUB_REPO = "https://raw.githubusercontent.com/oss-slu/DigitalBonesBox/data/data/";
const BONESET_DIR_URL = `${GITHUB_REPO}boneset/`;
const BONESET_NAMES = ["bony_pelvis", "skull", "thorax", "vertebrae", "upper_limb", "lower_limb"];
const BONES_DIR_URL = `${GITHUB_REPO}bones/`;
const GITHUB_COLORED_REGIONS_URL = `${GITHUB_REPO}annotations/ColoredRegions/`;

// Rate limiter for search endpoint
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

// Cache for search data
let searchCache = null;

// HTML escaping helper
function escapeHtml(str = "") {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[c]);
}

// Input validation helper for boneId
function isValidBoneId(boneId) {
    // Ensure boneId is a string (not an array or other type)
    if (typeof boneId !== "string") {
        return false;
    }
    
    // Only allow alphanumeric characters and underscores
    // This prevents path traversal and URL injection attacks
    const validBoneIdPattern = /^[a-z0-9_]+$/i;
    return validBoneIdPattern.test(boneId) && boneId.length > 0 && boneId.length <= 100;
}

// GitHub JSON fetcher
async function fetchJSON(url) {
    try {
        const response = await axios.get(url, { timeout: 10_000 });
        return { data: response.data, status: response.status };
    } catch (error) {
        console.error(`Failed to fetch ${url}:`, error.message);
        const status = error.response?.status || 500;
        return { data: null, status };
    }
}

// Initialize search cache at startup
async function initializeSearchCache() {
    try {
        const searchData = [];
        console.log("Initializing search cache...");
        for (const bonesetName of BONESET_NAMES) {
            const bonesetJsonUrl = `${BONESET_DIR_URL}${bonesetName}.json`;
            const bonesetResult = await fetchJSON(bonesetJsonUrl);
            const bonesetData = bonesetResult.data;
            if (!bonesetData) {
                console.warn(`Failed to load boneset data from ${bonesetName}`);
                continue;
            }

            // Add boneset to search data
            searchData.push({
                id: bonesetData.id,
                name: bonesetData.name,
                type: "boneset",
                boneset: bonesetData.id,
                bone: null,
                subbone: null
            });

            // Load all bones and sub-bones
            for (const boneId of bonesetData.bones || []) {
                const boneResult = await fetchJSON(`${BONES_DIR_URL}${boneId}.json`);
                const boneData = boneResult.data;
                if (boneData) {
                    // Add bone to search data
                    searchData.push({
                        id: boneData.id,
                        name: boneData.name,
                        type: "bone",
                        boneset: bonesetData.id,
                        bone: boneData.id,
                        subbone: null
                    });

                    // Add sub-bones to search data
                    for (const subBoneId of boneData.subBones || []) {
                        const subBoneName = subBoneId.replace(/_/g, " ");
                        searchData.push({
                            id: subBoneId,
                            name: subBoneName,
                            type: "subbone",
                            boneset: bonesetData.id,
                            bone: boneData.id,
                            subbone: subBoneId
                        });
                    }
                }
            }
        }
        searchCache = searchData;
        console.log(`Search cache initialized with ${searchData.length} items`);
    } catch (error) {
        console.error("Error initializing search cache:", error);
    }
}

// Search function with ranking
function searchItems(query, limit = 20) {
    if (!searchCache) return [];
    
    const q = query.toLowerCase().trim();
    const results = [];
    
    // First pass: prefix matches (higher priority)
    for (const item of searchCache) {
        if (!item.name) continue;
        
        if (item.name.toLowerCase().startsWith(q)) {
            results.push({ ...item, priority: 1 });
        }
    }
    
    // Second pass: substring matches (lower priority)
    for (const item of searchCache) {
        if (!item.name) continue;
        
        if (!item.name.toLowerCase().startsWith(q) && item.name.toLowerCase().includes(q)) {
            results.push({ ...item, priority: 2 });
        }
    }
    
    // Sort by priority, then by name
    results.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.name.localeCompare(b.name);
    });
    
    return results.slice(0, limit);
}

// Routes
app.get("/", (_req, res) => {
    res.json({ message: "Welcome to the Boneset API" });
});

/**
 * Gets combined data for all bonesets, bones, and subbones.
 */
app.get("/combined-data", async (_req, res) => {
    try {
        const bonesets = [];
        const bones = [];
        const subbones = [];
        for (const bonesetName of BONESET_NAMES) {
            const bonesetJsonUrl = `${BONESET_DIR_URL}${bonesetName}.json`;
            const bonesetResult = await fetchJSON(bonesetJsonUrl);
            const bonesetData = bonesetResult.data;
            if (!bonesetData) {
                return res.status(bonesetResult.status).json({ error: "Failed to load boneset data" });
            }

            bonesets.push({id: bonesetData.id, name: bonesetData.name});

            for (const boneId of bonesetData.bones || []) {
                const boneResult = await fetchJSON(`${BONES_DIR_URL}${boneId}.json`);
                const boneData = boneResult.data;
                if (boneData) {
                    bones.push({ id: boneData.id, name: boneData.name, boneset: bonesetData.id });
                    (boneData.subBones || []).forEach((subBoneId) => {
                        subbones.push({ id: subBoneId, name: subBoneId.replace(/_/g, " "), bone: boneData.id });
                    });
                }
            }
        }
        res.json({bonesets, bones, subbones});
    } catch (error) {
        console.error("Error fetching combined data:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * Gets colored region data for a specific bone.
 * Dynamically constructs the GitHub filename from the boneId and fetches the data.
 * Expects a 'boneId' query parameter.
 */
app.get("/api/colored-regions", async (req, res) => {
    const { boneId } = req.query;

    if (!boneId) {
        return res.status(400).json({ 
            error: "boneId query parameter is required"
        });
    }

    if (!isValidBoneId(boneId)) {
        return res.status(400).json({ 
            error: "Invalid boneId format"
        });
    }

    const filename = `${boneId}_colored_regions.json`;
    const githubUrl = `${GITHUB_COLORED_REGIONS_URL}${filename}`;

    try {
        const response = await axios.get(githubUrl, { timeout: 5000 });
        return res.json(response.data);
    } catch (error) {
        if (error.response?.status === 404) {
            console.log(`[ColoredRegions API] Not found: ${filename}`);
            return res.status(404).json({ 
                error: `Colored region data not available for boneId: ${boneId}`
            });
        }
        
        console.error(`[ColoredRegions API] Error fetching ${filename}:`, error.message);
        return res.status(502).json({ 
            error: "Failed to fetch colored region data from GitHub"
        });
    }
});

/**
 * Gets description of boneset, bone, or subbone, formatted as HTML list items.
 * Expects a 'boneId' query parameter.
 */
app.get("/api/description/", async (req, res) => {
    const { boneId } = req.query;
    if (!boneId) {
        return res.send(" ");
    }
    
    // Validate boneId to prevent SSRF attacks
    if (!isValidBoneId(boneId)) {
        return res.send("<li>Invalid bone ID.</li>");
    }
    
    const GITHUB_DESC_URL = `https://raw.githubusercontent.com/oss-slu/DigitalBonesBox/data/data/descriptions/${boneId}_description.json`;

    try {
        const response = await axios.get(GITHUB_DESC_URL);
        const descriptionData = response.data;

        let html = `<li><strong>${escapeHtml(descriptionData.name)}</strong></li>`;
        descriptionData.description.forEach(point => {
            html += `<li>${escapeHtml(point)}</li>`;
        });
        res.send(html);
    } catch (error) {
        res.send("<li>Description not available.</li>");
    }
});

/**
 * Gets detailed bone data including plaintext description and image URLs.
 * Expects a 'boneId' query parameter.
 */
app.get("/api/bone-data/", async (req, res) => {
    const { boneId } = req.query;
    
    // Validate boneId parameter
    if (!boneId) {
        return res.status(400).json({ 
            error: "boneId query parameter is required"
        });
    }
    
    // Validate boneId format to prevent SSRF attacks
    if (!isValidBoneId(boneId)) {
        return res.status(400).json({ 
            error: "Invalid boneId format. Only alphanumeric characters and underscores are allowed."
        });
    }
    
    // Build GitHub URL for the description JSON
    const GITHUB_DESC_URL = `https://raw.githubusercontent.com/oss-slu/DigitalBonesBox/data/data/descriptions/${boneId}_description.json`;
    const GITHUB_IMAGES_BASE_URL = "https://raw.githubusercontent.com/oss-slu/DigitalBonesBox/data/data/images/";

    try {
        // Fetch the description JSON from GitHub
        const response = await axios.get(GITHUB_DESC_URL, { timeout: 10000 });
        const descriptionData = response.data;

        // Extract the images array from the JSON
        const imagesArray = descriptionData.images || [];
        
        // Build image objects with filename and full URL
        const images = imagesArray.map(filename => ({
            filename: filename,
            url: `${GITHUB_IMAGES_BASE_URL}${filename}`
        }));

        // Return the complete bone data as JSON
        res.json({
            name: descriptionData.name,
            id: descriptionData.id,
            description: descriptionData.description,
            images: images
        });

    } catch (error) {
        return res.status(error.response?.status || 500).json({
            error: error.response?.error || "Failed to fetch bone data"
        });
    }
});

/**
 * Gets annotation data for a specific boneId.
 */
app.get("/api/annotations/:boneId", searchLimiter, async (req, res) => {
    const { boneId } = req.params;

    // 1. Validation
    if (!isValidBoneId(boneId)) {
        return res.status(400).json({ 
            error: "Invalid boneId format."
        });
    }

    // Define the view/rotation to select from the template geometry
    // This assumes all current bone views use the 'right' view coordinates for scaling.
    const geometryView = "right"; 

    // Construct GitHub URLs for annotation data and template
    const annotationFilename = `${boneId}_text_annotations.json`;
    const GITHUB_ANNOTATION_URL = `${GITHUB_REPO}annotations/text_label_annotations/${annotationFilename}`;
    const templateFilename = "template_bony_pelvis.json";
    const GITHUB_TEMPLATE_URL = `${GITHUB_REPO}annotations/rotations%20annotations/${templateFilename}`;

    try {
        // Fetch annotation data from GitHub
        const annotationResult = await fetchJSON(GITHUB_ANNOTATION_URL);
        const annotationData = annotationResult.data;
        if (!annotationData) {
            const status = annotationResult.status;
            const errorMessage = `Failed to fetch annotation data (HTTP ${status})`;
            return res.status(status).json({ 
                error: errorMessage
            });
        }
        
        // Fetch the rotation/scaling template data from GitHub
        const templateResult = await fetchJSON(GITHUB_TEMPLATE_URL);
        const templateData = templateResult.data;
        if (!templateData) {
            const status = templateResult.status;
            const errorMessage = `Failed to fetch template data (HTTP ${status})`;
            return res.status(status).json({ 
                error: errorMessage
            });
        }

        // Define Full Slide Dimensions for Normalization. We normalize the text annotation dimentions to the slide
        //  widths so that the values used by the frontend are decoupled from the slide dimensions.
        const slideWidth = 9144000;
        const slideHeight = 5143500;
        
        // Combine required data for the frontend
        let normalizedGeometry = templateData.normalized_geometry
            ? templateData.normalized_geometry[geometryView] 
            : { normX: 0, normY: 0, normW: 1, normH: 1 }; 
        
        // *** ALIGNMENT WORKAROUND (Leave this in) ***
        if (boneId === "bony_pelvis" && normalizedGeometry) {
            normalizedGeometry.normX = normalizedGeometry.normX + 0.001; 
            console.log("ALIGNMENT WORKAROUND APPLIED: Bony Pelvis normX shifted by +0.001");
        }
        // *** END ALIGNMENT WORKAROUND ***
        
        // Normalize Text Annotation Coordinates
        const normalizedAnnotations = (annotationData.text_annotations || []).map(annotation => {
            if (annotation.text_box && slideWidth && slideHeight) {
                // Normalize all coordinate values for the bounding box
                annotation.text_box.x = annotation.text_box.x / slideWidth;
                annotation.text_box.y = annotation.text_box.y / slideHeight;
                annotation.text_box.width = annotation.text_box.width / slideWidth;
                annotation.text_box.height = annotation.text_box.height / slideHeight;

                // Normalize pointer lines (start and end points)
                (annotation.pointer_lines || []).forEach(line => {
                    if (line.start_point) {
                        line.start_point.x = line.start_point.x / slideWidth;
                        line.start_point.y = line.start_point.y / slideHeight;
                    }
                    if (line.end_point) {
                        line.end_point.x = line.end_point.x / slideWidth;
                        line.end_point.y = line.end_point.y / slideHeight;
                    }
                });
                
                // Note: Other coordinates like target_regions might also need normalization 
                // depending on your frontend implementation, but we start with text_box and pointer_lines.
            }
            return annotation;
        });

        const combinedData = {
            annotations: normalizedAnnotations,
            normalized_geometry: normalizedGeometry
        };

        console.log(`SUCCESS: Serving annotation data for ${boneId} from GitHub combined with template (Coordinates Normalized).`);
        return res.json(combinedData);
        
    } catch (error) {
        console.error("Error fetching annotation/template data:", error.message);
        res.status(500).json({ 
            error: "Internal Server Error", 
            message: `Failed to fetch annotation data for boneId: ${boneId}` 
        });
    }
});

/**
 * Looks for bonesets, bones, and sub-bones that match the search query.
 * Returns HTML list items with data attributes for frontend use.
 * Expects a 'q' query parameter for the search term.
 */
app.get("/api/search", searchLimiter, (req, res) => {
    const query = req.query.q;
    
    console.log("Search request received for:", query);

    // Handle empty or too short queries
    if (!query || query.trim().length < 2) {
        return res.send("<li class='search-placeholder'>Enter at least 2 characters to search</li>");
    }

    const searchTerm = query.trim();
    
    try {
        if (!searchCache) {
            return res.send("<li class='search-error'>Search not available - cache not initialized</li>");
        }

        const results = searchItems(searchTerm, 20);
        console.log(`Found ${results.length} results for "${searchTerm}"`);

        if (results.length === 0) {
            return res.send("<li class='search-no-results'>No results found</li>");
        }

        let html = "";
        for (const result of results) {
            const escapedName = escapeHtml(result.name);
            const escapedType = escapeHtml(result.type);
            let displayType;
            switch (escapedType) {
                case "subbone":
                    displayType = escapeHtml("bone part");
                    break;
                default:
                    displayType = escapedType;
            }
            
            html += `<li class="search-result" 
                        data-type="${escapedType}" 
                        data-id="${escapeHtml(result.id)}"
                        data-boneset="${escapeHtml(result.boneset || "")}"
                        data-bone="${escapeHtml(result.bone || "")}"
                        data-subbone="${escapeHtml(result.subbone || "")}"
                        tabindex="0"
                        role="option">
                        ${escapedName} <small>(${displayType})</small>
                     </li>`;
        }

        res.send(html);
    } catch (error) {
        console.error("Search error:", error);
        res.status(500).send("<li class='search-error'>Search error occurred</li>");
    }
});

async function startServer() {
    await initializeSearchCache();
    
    // Start the server only if this file is run directly (not imported)
    if (require.main == module) {
      app.listen(PORT, () => {
        console.log(`Server running on http://127.0.0.1:${PORT}`);
      });
    }
}

startServer();

// Export for tests or other modules if needed
module.exports = {
  app,
  escapeHtml,
  searchItems,
  initializeSearchCache,
};