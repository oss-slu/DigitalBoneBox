// boneset-api/server.js
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const fs = require("fs").promises; // Use promises for async/await file reading
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const LOCAL_DATA_DIR = path.join(__dirname, "data");
const BONESET_DIR = path.join(LOCAL_DATA_DIR, "boneset");
const BONES_DIR = path.join(LOCAL_DATA_DIR, "bones");
const COLORED_REGIONS_DIR = path.join(LOCAL_DATA_DIR, "annotations", "ColoredRegions");
const TEXT_LABEL_ANNOTATIONS_DIR = path.join(LOCAL_DATA_DIR, "annotations", "text_label_annotations");
const ROTATIONS_TEMPLATE_DIR = path.join(LOCAL_DATA_DIR, "annotations", "rotations annotations");
const DESCRIPTIONS_DIR = path.join(LOCAL_DATA_DIR, "descriptions");
const IMAGES_DIR = path.join(LOCAL_DATA_DIR, "images");

const BONESET_NAMES = ["bony_pelvis", "skull", "thorax", "vertebrae", "upper_limb", "lower_limb"];

app.use("/api/images", express.static(IMAGES_DIR));

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
    if (typeof boneId !== "string") {
        return false;
    }
    const validBoneIdPattern = /^[a-z0-9_]+$/i;
    return validBoneIdPattern.test(boneId) && boneId.length > 0 && boneId.length <= 100;
}

async function readJSON(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return { data: JSON.parse(raw), status: 200 };
    } catch (error) {
        if (error.code === "ENOENT") {
            return { data: null, status: 404 };
        }
        console.error(`Failed to read JSON ${filePath}:`, error.message);
        return { data: null, status: 500 };
    }
}

async function initializeSearchCache() {
    try {
        const searchData = [];
        console.log("Initializing search cache...");

        for (const bonesetName of BONESET_NAMES) {
            const bonesetPath = path.join(BONESET_DIR, `${bonesetName}.json`);
            const bonesetResult = await readJSON(bonesetPath);
            const bonesetData = bonesetResult.data;
            if (!bonesetData) {
                console.warn(`Failed to load boneset data from ${bonesetName}`);
                continue;
            }

            searchData.push({
                id: bonesetData.id,
                name: bonesetData.name,
                type: "boneset",
                boneset: bonesetData.id,
                bone: null,
                subbone: null,
            });

            for (const boneId of bonesetData.bones || []) {
                const bonePath = path.join(BONES_DIR, `${boneId}.json`);
                const boneResult = await readJSON(bonePath);
                const boneData = boneResult.data;
                if (boneData) {
                    searchData.push({
                        id: boneData.id,
                        name: boneData.name,
                        type: "bone",
                        boneset: bonesetData.id,
                        bone: boneData.id,
                        subbone: null,
                    });

                    for (const subBoneId of boneData.subBones || []) {
                        searchData.push({
                            id: subBoneId,
                            name: subBoneId.replace(/_/g, " "),
                            type: "subbone",
                            boneset: bonesetData.id,
                            bone: boneData.id,
                            subbone: subBoneId,
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
            const bonesetPath = path.join(BONESET_DIR, `${bonesetName}.json`);
            const bonesetResult = await readJSON(bonesetPath);
            const bonesetData = bonesetResult.data;
            if (!bonesetData) {
                return res.status(bonesetResult.status).json({ error: "Failed to load boneset data" });
            }

            bonesets.push({ id: bonesetData.id, name: bonesetData.name });

            for (const boneId of bonesetData.bones || []) {
                const bonePath = path.join(BONES_DIR, `${boneId}.json`);
                const boneResult = await readJSON(bonePath);
                const boneData = boneResult.data;
                if (boneData) {
                    bones.push({ id: boneData.id, name: boneData.name, boneset: bonesetData.id });
                    (boneData.subBones || []).forEach((subBoneId) => {
                        subbones.push({ id: subBoneId, name: subBoneId.replace(/_/g, " "), bone: boneData.id });
                    });
                }
            }
        }

        res.json({ bonesets, bones, subbones });
    } catch (error) {
        console.error("Error fetching combined data:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * Gets colored region data for a specific bone.
 * Expects a 'boneId' query parameter.
 */
app.get("/api/colored-regions", async (req, res) => {
    const { boneId } = req.query;

    if (!boneId) {
        return res.status(400).json({ error: "boneId query parameter is required" });
    }

    if (!isValidBoneId(boneId)) {
        return res.status(400).json({ error: "Invalid boneId format" });
    }

    const filename = `${boneId}_colored_regions.json`;
    const filePath = path.join(COLORED_REGIONS_DIR, filename);
    const result = await readJSON(filePath);

    if (!result.data) {
        if (result.status === 404) {
            return res.status(404).json({ error: `Colored region data not available for boneId: ${boneId}` });
        }
        return res.status(500).json({ error: "Failed to load colored region data" });
    }

    res.json(result.data);
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

    if (!isValidBoneId(boneId)) {
        return res.send("<li>Invalid bone ID.</li>");
    }

    const descriptionPath = path.join(DESCRIPTIONS_DIR, `${boneId}_description.json`);
    const descriptionResult = await readJSON(descriptionPath);
    if (!descriptionResult.data) {
        return res.send("<li>Description not available.</li>");
    }

    const descriptionData = descriptionResult.data;
    let html = `<li><strong>${escapeHtml(descriptionData.name)}</strong></li>`;
    (descriptionData.description || []).forEach((point) => {
        html += `<li>${escapeHtml(point)}</li>`;
    });
    res.send(html);
});

/**
 * Gets detailed bone data including plaintext description and image URLs.
 * Expects a 'boneId' query parameter.
 */
app.get("/api/bone-data/", async (req, res) => {
    const { boneId } = req.query;

    if (!boneId) {
        return res.status(400).json({ error: "boneId query parameter is required" });
    }

    if (!isValidBoneId(boneId)) {
        return res.status(400).json({ error: "Invalid boneId format. Only alphanumeric characters and underscores are allowed." });
    }

    const descriptionPath = path.join(DESCRIPTIONS_DIR, `${boneId}_description.json`);
    const descriptionResult = await readJSON(descriptionPath);
    if (!descriptionResult.data) {
        return res.status(descriptionResult.status === 404 ? 404 : 500).json({ error: "Failed to fetch bone data" });
    }

    const descriptionData = descriptionResult.data;
    const imagesArray = descriptionData.images || [];
    const images = imagesArray.map((filename) => ({
        filename,
        url: `/api/images/${encodeURIComponent(filename)}`,
    }));

    res.json({
        name: descriptionData.name,
        id: descriptionData.id,
        description: descriptionData.description,
        images,
    });
});

/**
 * Gets annotation data for a specific boneId.
 */
app.get("/api/annotations/:boneId", searchLimiter, async (req, res) => {
    const { boneId } = req.params;

    if (!isValidBoneId(boneId)) {
        return res.status(400).json({ error: "Invalid boneId format." });
    }

    // Define the view/rotation to select from the template geometry
    // This assumes all current bone views use the 'right' view coordinates for scaling.
    const geometryView = "right";

    const annotationFilename = `${boneId}_text_annotations.json`;
    const annotationPath = path.join(TEXT_LABEL_ANNOTATIONS_DIR, annotationFilename);
    const templateFilename = "template_bony_pelvis.json";
    const templatePath = path.join(ROTATIONS_TEMPLATE_DIR, templateFilename);

    const annotationResult = await readJSON(annotationPath);
    if (!annotationResult.data) {
        return res.status(annotationResult.status).json({ error: `Failed to load annotation data (HTTP ${annotationResult.status})` });
    }

    const templateResult = await readJSON(templatePath);
    if (!templateResult.data) {
        return res.status(templateResult.status).json({ error: `Failed to load template data (HTTP ${templateResult.status})` });
    }

    const annotationData = annotationResult.data;
    const templateData = templateResult.data;

    // Define Full Slide Dimensions for Normalization. We normalize the text annotation dimentions to the slide
    //  widths so that the values used by the frontend are decoupled from the slide dimensions.
    const slideWidth = 9144000;
    const slideHeight = 5143500;

    let normalizedGeometry = templateData.normalized_geometry
        ? templateData.normalized_geometry[geometryView]
        : { normX: 0, normY: 0, normW: 1, normH: 1 };

    if (boneId === "bony_pelvis" && normalizedGeometry) {
        normalizedGeometry.normX = normalizedGeometry.normX + 0.001;
        console.log("ALIGNMENT WORKAROUND APPLIED: Bony Pelvis normX shifted by +0.001");
    }

    const normalizedAnnotations = (annotationData.text_annotations || []).map((annotation) => {
        if (annotation.text_box && slideWidth && slideHeight) {
            annotation.text_box.x = annotation.text_box.x / slideWidth;
            annotation.text_box.y = annotation.text_box.y / slideHeight;
            annotation.text_box.width = annotation.text_box.width / slideWidth;
            annotation.text_box.height = annotation.text_box.height / slideHeight;

            (annotation.pointer_lines || []).forEach((line) => {
                if (line.start_point) {
                    line.start_point.x = line.start_point.x / slideWidth;
                    line.start_point.y = line.start_point.y / slideHeight;
                }
                if (line.end_point) {
                    line.end_point.x = line.end_point.x / slideWidth;
                    line.end_point.y = line.end_point.y / slideHeight;
                }
            });
        }
        return annotation;
    });

    const combinedData = {
        annotations: normalizedAnnotations,
        normalized_geometry: normalizedGeometry,
    };

    console.log(`SUCCESS: Serving annotation data for ${boneId} from local data combined with template (Coordinates Normalized).`);
    return res.json(combinedData);
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