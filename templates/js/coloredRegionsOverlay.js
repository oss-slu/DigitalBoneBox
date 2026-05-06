const COLORED_REGIONS_CONFIG = {
    // API endpoint for fetching colored regions data by bone ID
    API_URL: "http://127.0.0.1:8000/api/colored-regions",
    // Default opacity for colored overlays (0.3 = 30% transparent)
    DEFAULT_OPACITY: 0.4
};

/**
 * Positioning adjustments for colored region overlays
 * Format: { boneId: { imageIndex: { x, y, scale, rotation } } }
 * imageIndex: 0 = left/first image, 1 = right/second image
 */
const OVERLAY_ADJUSTMENTS = {
    "bony_pelvis": {
        0: { x: -5, y: -5, scale: 1.0, rotation: 15 },   // Left image
        1: { x: 2, y: 5, scale: 0.9, rotation: 1 }      // Right image
    },
    "iliac_crest": {
        0: { x: -2, y: 15, scale: 1.0, rotation: 12},
        1: { x: 65, y: 20, scale: 1.0, rotation: 0 }
    },
    "anterior_iliac_spines": {
        0: { x: 2, y: 11, scale: 1.0, rotation: 10 },
        1: { x: 5, y: 4, scale: 1.0, rotation: 0 }
    },
    "posterior_iliac_spines": {
        0: { x: 10, y: -70, scale: 0.95, rotation: 0 },
        1: { x: -20, y: -15, scale: 1.0, rotation: 0 }
    },
    "posterior_superior_iliac_spines": {
        0: { x: 50, y: 200, scale: 1.0, rotation: 0 },
        1: { x: 60, y: 80, scale: 1.0, rotation: 0 }
    },
    "posterior_inferior_iliac_spines": {
        0: { x: 60, y: 60, scale: 1.0, rotation: 0 },
        1: { x: 80, y: 60, scale: 1.0, rotation: 0 }
    },
    "pectineal_line": {
        0: { x: 0, y: 5, scale: 1.0, rotation: -2 },
        1: { x: 5, y: 5, scale: 1.0, rotation: 0 }
    },
    "symphyseal_surface": {
        0: { x: 17, y: 245, scale: 1.0, rotation: 0 },
        1: { x: 0, y: 0, scale: 1.0, rotation: 0 }
    },
    "pubic_tubercle": {
        0: { x: 270, y: 210, scale: 1.0, rotation: 0 },
        1: { x: 0, y: 0, scale: 1.0, rotation: 0 }
    },
    "auricular_surface": {
        0: { x: 140, y: 135, scale: 1.0, rotation: 0 },
        1: { x: 0, y: 0, scale: 1.0, rotation: 0 }
    },
    "ramus": {
        0: { x: 50, y: 340, scale: 1.0, rotation: 8 },
        1: { x: 105, y: 323, scale: 1.0, rotation: 0 }
    },
    "ischial_tuberosity": {
        0: { x: 38, y: 290, scale: 1.0, rotation: 0 },
        1: { x: 105, y: 295, scale: 1.0, rotation: 0 }
    },
    "ischial_spine": {
        0: { x: 45, y: 260, scale: 1.0, rotation: 0 },
        1: { x: 192, y: 258, scale: 1.0, rotation: 0 }
    },
    "sciatic_notches": {
        0: { x: 5, y: 0, scale: 1.0, rotation: 17 },
        1: { x: -5, y: 0, scale: 1.0, rotation: 0 }
    },
    "pubic_rami": {
        0: { x: 10, y: 40, scale: 0.7, rotation: 7 },
        1: { x: 0, y: 0, scale: 1.0, rotation: 0 }
    }
};

/**
 * Fetch colored region data for a specific bone from the API server
 * @param {string} boneId - The bone identifier (e.g., "pubis", "ilium")
 * @param {boolean} isBonesetSelection - Whether this is a boneset selection (not individual bone)
 * @returns {Object|null} - The colored region data or null if not available
 */
async function fetchColoredRegionData(boneId, isBonesetSelection = false) {
    if (!boneId) {
        console.error("[ColoredRegions] No boneId provided for colored regions");
        return null;
    }

    console.log(`[ColoredRegions] Fetching colored region data for boneId: "${boneId}", isBonesetSelection: ${isBonesetSelection}`);
    
    // Map ilium to bony_pelvis for boneset selections
    let mappedBoneId = boneId;
    if (boneId === "ilium" && isBonesetSelection) {
        console.debug("[ColoredRegions] Mapping \"ilium\" to \"bony_pelvis\" for boneset selection");
        mappedBoneId = "bony_pelvis";
    }

    try {
        // Fetch from the API endpoint
        const url = `${COLORED_REGIONS_CONFIG.API_URL}?boneId=${encodeURIComponent(mappedBoneId)}`;
        
        const response = await fetch(url, {
            cache: "no-store",
            headers: {
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            }
        });

        if (!response.ok && response.status !== 404) {
            console.warn(`[ColoredRegions] API returned status ${response.status}: ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        console.log(`[ColoredRegions] Successfully fetched colored regions for ${mappedBoneId}`);
        return data;
    } catch (error) {
        return null;
    }
}

/**
 * Convert EMU coordinates to pixel coordinates
 * EMU (English Metric Units) are used in PowerPoint
 * @param {number} emuValue - Coordinate value in EMUs
 * @param {number} emuMax - Maximum EMU value (slide width or height)
 * @param {number} pixelMax - Maximum pixel value (image width or height)
 * @returns {number} - Converted pixel coordinate
 */
function emuToPixels(emuValue, emuMax, pixelMax) {
    return (emuValue / emuMax) * pixelMax;
}

/**
 * Convert a path command from EMU coordinates to pixel coordinates
 * @param {Object} command - Path command object with type and coordinates
 * @param {Object} dimensions - Object containing slideWidth, slideHeight, imageWidth, imageHeight
 * @param {Object} debugInfo - Optional debug info (e.g., isFirstCommand) for logging
 * @returns {Object} - Command with converted pixel coordinates
 */
function convertCommandToPixels(command, dimensions, debugInfo = {}) {
    const { slideWidth, slideHeight, imageWidth, imageHeight } = dimensions;
    const converted = { type: command.type };

    // Convert x, y coordinates (present in all command types)
    if (command.x !== undefined) {
        converted.x = emuToPixels(command.x, slideWidth, imageWidth);
        if (debugInfo.isFirstCommand) {
            console.debug(`[ColoredRegions] First coord conversion: EMU(${command.x}, ${command.y}) -> Pixel(${converted.x.toFixed(2)}, ${emuToPixels(command.y, slideHeight, imageHeight).toFixed(2)})`);
            console.debug(`[ColoredRegions]   EMU dimensions: ${slideWidth} x ${slideHeight}`);
            console.debug(`[ColoredRegions]   Pixel dimensions: ${imageWidth} x ${imageHeight}`);
        }
    }
    if (command.y !== undefined) {
        converted.y = emuToPixels(command.y, slideHeight, imageHeight);
    }

    // Convert control points for Bezier curves (cubicBezTo)
    if (command.type === "cubicBezTo") {
        converted.x1 = emuToPixels(command.x1, slideWidth, imageWidth);
        converted.y1 = emuToPixels(command.y1, slideHeight, imageHeight);
        converted.x2 = emuToPixels(command.x2, slideWidth, imageWidth);
        converted.y2 = emuToPixels(command.y2, slideHeight, imageHeight);
    }

    return converted;
}

/**
 * Convert path data commands to SVG path string
 * @param {Array} commands - Array of path command objects
 * @param {Object} dimensions - Dimension conversion info
 * @returns {string} - SVG path d attribute string
 */
function commandsToSVGPath(commands, dimensions) {
    let pathString = "";

    commands.forEach((command, idx) => {
        const pixelCmd = convertCommandToPixels(command, dimensions, { isFirstCommand: idx === 0 });

        switch (pixelCmd.type) {
            case "moveTo":
                // M x y - Move to point
                pathString += `M ${pixelCmd.x} ${pixelCmd.y} `;
                break;
            
            case "lineTo":
                // L x y - Line to point
                pathString += `L ${pixelCmd.x} ${pixelCmd.y} `;
                break;
            
            case "cubicBezTo":
                // C x1 y1 x2 y2 x y - Cubic Bezier curve
                pathString += `C ${pixelCmd.x1} ${pixelCmd.y1} ${pixelCmd.x2} ${pixelCmd.y2} ${pixelCmd.x} ${pixelCmd.y} `;
                break;
            
            case "close":
                // Z - Close path
                pathString += "Z ";
                break;
            
            default:
                console.warn("Unknown path command type:", pixelCmd.type);
        }
    });

    return pathString.trim();
}

/**
 * Create an SVG element with colored region paths
 * @param {Array} coloredRegions - Array of colored region data
 * @param {number} imageWidth - Width of the image in pixels
 * @param {number} imageHeight - Height of the image in pixels
 * @param {Object} imageData - Image metadata (width, height, etc.)
 * @param {string} boneId - Bone identifier for data-bone attribute
 * @param {number} imageIndex - Index of the image (for applying specific adjustments)
 * @returns {SVGElement} - SVG element with colored regions
 */
function createColoredRegionsSVG(coloredRegions, imageWidth, imageHeight, imageData, boneId, imageIndex = 0) {
    // Create SVG namespace
    const svgNS = "http://www.w3.org/2000/svg";
    
    // Create SVG element that will overlay the image
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "colored-regions-overlay");
    svg.setAttribute("data-bone", boneId); // Add bone identifier for CSS targeting
    svg.setAttribute("width", imageWidth);
    svg.setAttribute("height", imageHeight);
    svg.setAttribute("viewBox", `0 0 ${imageWidth} ${imageHeight}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.pointerEvents = "none"; // Allow clicks to pass through to image

    console.debug(`[ColoredRegions DEBUG] Creating SVG for bone: ${boneId}, imageIndex: ${imageIndex}`);
    console.debug("[ColoredRegions DEBUG] OVERLAY_ADJUSTMENTS lookup:", OVERLAY_ADJUSTMENTS[boneId]);
    
    // Apply positioning adjustments if defined for this bone and image
    if (OVERLAY_ADJUSTMENTS[boneId] && OVERLAY_ADJUSTMENTS[boneId][imageIndex]) {
        const adjustments = OVERLAY_ADJUSTMENTS[boneId][imageIndex];
        console.debug("[ColoredRegions DEBUG] Found adjustments:", adjustments);
        const transforms = [];
        
        if (adjustments.x !== 0 || adjustments.y !== 0) {
            transforms.push(`translate(${adjustments.x}px, ${adjustments.y}px)`);
        }
        
        if (adjustments.scale !== 1.0) {
            transforms.push(`scale(${adjustments.scale})`);
        }
        
        if (adjustments.rotation !== 0) {
            transforms.push(`rotate(${adjustments.rotation}deg)`);
        }
        
        if (transforms.length > 0) {
            svg.style.transform = transforms.join(" ");
            svg.style.transformOrigin = "center";
            console.debug(`[ColoredRegions] Applied positioning adjustments for ${boneId} image ${imageIndex}: ${svg.style.transform}`);
        }
    }

    // Set up dimension conversion parameters
    // New format: coordinates are relative to the image and scaled to pixel size
    // Old format: coordinates are in EMUs relative to slide and require full conversion
    const dimensions = {
        slideWidth: imageData.width,
        slideHeight: imageData.height,
        imageWidth: imageWidth,
        imageHeight: imageHeight
    };

    console.debug("[ColoredRegions] Coordinate conversion:", {
        sourceWidth: dimensions.slideWidth,
        sourceHeight: dimensions.slideHeight,
        targetWidth: dimensions.imageWidth,
        targetHeight: dimensions.imageHeight
    });

    // Create path elements for each colored region
    coloredRegions.forEach((region, regionIndex) => {
        try {
            // path_data can be an array of path objects or a single path object
            const pathDataArray = Array.isArray(region.path_data) ? region.path_data : [region.path_data];
            
            // Process each path in the path_data array
            pathDataArray.forEach((pathDataObj, pathIndex) => {
                try {
                    // Convert path commands to SVG path string
                    const pathData = commandsToSVGPath(pathDataObj.commands, dimensions);
                    
                    // Create path element
                    const path = document.createElementNS(svgNS, "path");
                    path.setAttribute("d", pathData);
                    
                    // Apply offset if present (for shapes that need to be positioned relative to image)
                    if (region.offset_x !== undefined && region.offset_y !== undefined) {
                        // Convert EMU offsets to pixels
                        const offsetXPixels = emuToPixels(region.offset_x, dimensions.slideWidth, dimensions.imageWidth);
                        const offsetYPixels = emuToPixels(region.offset_y, dimensions.slideHeight, dimensions.imageHeight);
                        path.setAttribute("transform", `translate(${offsetXPixels}, ${offsetYPixels})`);
                        console.debug(`Applied offset transform: translate(${offsetXPixels}, ${offsetYPixels})`);
                    }
                    
                    // Apply color (add # to hex code from JSON)
                    const color = region.color.startsWith("#") ? region.color : `#${region.color}`;
                    
                    // Check if this is a stroked path (outline only) or filled region
                    if (region.stroke === true) {
                        // This is a stroked path (outline only) - like sciatic notches
                        path.setAttribute("fill", "none"); // No fill for stroked paths
                        path.setAttribute("stroke", color); // Use region color for stroke
                        
                        // Convert stroke width from EMU to pixels
                        const strokeWidthEMU = region.stroke_width || 38100;
                        const strokeWidthPixels = emuToPixels(strokeWidthEMU, dimensions.slideWidth, dimensions.imageWidth);
                        path.setAttribute("stroke-width", strokeWidthPixels);
                        path.setAttribute("stroke-linecap", "round");
                        path.setAttribute("stroke-linejoin", "round");
                        
                        console.debug(`Created stroked path: ${region.anatomical_name} (stroke: ${color}, width: ${strokeWidthPixels.toFixed(2)}px)`);
                    } else {
                        // This is a filled region - standard colored region
                        path.setAttribute("fill", color);
                        
                        // Create darker stroke color - handle multiple colors
                        let darkerStroke;
                        const colorUpper = color.toUpperCase();
                        if (colorUpper === "#C133AD") {
                            darkerStroke = "#8B2471"; // Darker pink for pink regions
                        } else if (colorUpper === "#FF00E6") {
                            darkerStroke = "#B300A3"; // Darker magenta for magenta regions
                        } else if (colorUpper === "#008000" || colorUpper === "#2F8E29") {
                            darkerStroke = "#1F5E1C"; // Darker green for green regions
                        } else {
                            darkerStroke = "#1F5E1C"; // Default to darker green
                        }
                        path.setAttribute("stroke", darkerStroke); // Darker dashed border
                        
                        // Apply transparency
                        path.setAttribute("opacity", COLORED_REGIONS_CONFIG.DEFAULT_OPACITY);
                    }
                    
                    // Add descriptive attributes for debugging
                    path.setAttribute("data-region-name", region.anatomical_name || `region-${regionIndex}`);
                    path.setAttribute("data-color-name", region.color_name || "unknown");
                    path.setAttribute("data-path-index", pathIndex);
                    
                    // Mark stroked paths for CSS styling
                    if (region.stroke === true) {
                        path.setAttribute("data-region-type", "stroke");
                    } else {
                        path.setAttribute("data-region-type", "fill");
                    }
                    
                    svg.appendChild(path);
                    
                    console.debug(`Created colored region path ${pathIndex + 1}/${pathDataArray.length}: ${region.anatomical_name} (${region.color_name})`);
                } catch (error) {
                    console.error(`Error creating path ${pathIndex} for region ${region.anatomical_name}:`, error);
                }
            });
        } catch (error) {
            console.error(`Error processing region ${region.anatomical_name}:`, error);
        }
    });

    return svg;
}

/**
 * Display colored regions over a bone image
 * @param {HTMLImageElement} imageElement - The bone image element
 * @param {string} boneId - The bone identifier
 * @param {number} imageIndex - The index of the image (0 for left, 1 for right, etc.)
 * @param {boolean} isBonesetSelection - Whether this is a boneset selection (not individual bone)
 * @returns {Promise<void>}
 */
export async function displayColoredRegions(imageElement, boneId, imageIndex = 0, isBonesetSelection = false) {
    console.debug(`[ColoredRegions] boneId: ${boneId}, imageIndex: ${imageIndex}, isBonesetSelection: ${isBonesetSelection}`);
    console.debug("[ColoredRegions] imageElement:", imageElement);
    
    if (!imageElement || !boneId) {
        console.debug("[ColoredRegions] Missing image element or boneId for colored regions");
        return;
    }

    // Map ilium to bony_pelvis for positioning lookups (same as in fetchColoredRegionData)
    let mappedBoneId = boneId;
    if (boneId === "ilium" && isBonesetSelection) {
        mappedBoneId = "bony_pelvis";
        console.debug("[ColoredRegions] Using mapped bone ID \"bony_pelvis\" for positioning adjustments");
    }

    // Fetch colored region data
    const regionData = await fetchColoredRegionData(boneId, isBonesetSelection);
    console.log("[ColoredRegions] Fetched regionData:", regionData);
    
    // Return early if no colored region data exists
    if (!regionData) {
        console.log(`[ColoredRegions] No colored regions to display for ${boneId}`);
        return;
    }

    // Handle new structure with separate images
    let imageData = null;
    let regionsToDisplay = [];
    
    if (regionData.images && Array.isArray(regionData.images)) {
        // One possible structure: data organized by image
        console.debug(`[ColoredRegions] Using organized-by-image structure with ${regionData.images.length} images`);
        
        if (imageIndex >= 0 && imageIndex < regionData.images.length) {
            imageData = regionData.images[imageIndex];
            regionsToDisplay = imageData.colored_regions || [];
        } else {
            console.warn(`[ColoredRegions] Invalid imageIndex ${imageIndex}, expected 0-${regionData.images.length - 1}`);
            return;
        }
    } else if (regionData.colored_regions) {
        // Alternate structure: single set of regions for all images
        console.debug("[ColoredRegions] Using alternate structure");
        regionsToDisplay = regionData.colored_regions;
        imageData = {
            width: regionData.image_dimensions?.width,
            height: regionData.image_dimensions?.height
        };
    }
    
    if (!regionsToDisplay || regionsToDisplay.length === 0) {
        console.debug(`[ColoredRegions] No colored regions found for image ${imageIndex}`);
        return;
    }

    console.log(`[ColoredRegions] Found ${regionsToDisplay.length} colored regions for image ${imageIndex}`);

    // Wait for image to load to get correct dimensions
    if (!imageElement.complete) {
        console.debug("[ColoredRegions] Waiting for image to complete loading...");
        await new Promise(resolve => {
            imageElement.addEventListener("load", resolve, { once: true });
        });
    }

    // Get image dimensions
    // Use naturalWidth/naturalHeight to get the actual image file dimensions
    // This ensures the SVG coordinates match the actual image, then CSS will scale both together
    const imageWidth = imageElement.naturalWidth;
    const imageHeight = imageElement.naturalHeight;

    console.debug(`[ColoredRegions] Image natural dimensions: ${imageWidth}x${imageHeight}`);
    console.debug(`[ColoredRegions] Image displayed dimensions: ${imageElement.offsetWidth}x${imageElement.offsetHeight}`);

    if (imageWidth === 0 || imageHeight === 0) {
        console.warn("[ColoredRegions] Image has zero dimensions, cannot display colored regions");
        return;
    }

    // Create SVG overlay (use mappedBoneId for positioning lookups)
    const svg = createColoredRegionsSVG(
        regionsToDisplay,
        imageWidth,
        imageHeight,
        imageData,
        mappedBoneId,
        imageIndex
    );

    // Find the parent container to add SVG overlay
    const parent = imageElement.parentElement;
    if (!parent) {
        console.warn("[ColoredRegions] Image element has no parent, cannot add overlay");
        return;
    }

    // Ensure parent has position relative for absolute positioning of SVG
    if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
    }

    // Add class to disable image rotation (so CSS transforms on overlay work correctly)
    parent.classList.add("with-annotations");

    // Remove any existing colored region overlays
    clearColoredRegions(parent);

    // Add the SVG overlay
    parent.appendChild(svg);

    console.debug("[ColoredRegions] SVG appended to parent container");
    console.debug("[ColoredRegions] Parent element:", parent);
    console.debug("[ColoredRegions] Parent classes:", parent.className);
    console.debug("[ColoredRegions] SVG data-bone attribute:", svg.getAttribute("data-bone"));
    console.debug("[ColoredRegions] SVG element:", svg);
    console.debug(`[ColoredRegions] SVG has ${svg.children.length} path elements`);

    console.log(`[ColoredRegions] Successfully displayed ${regionsToDisplay.length} colored regions for image ${imageIndex}`);
}

/**
 * Clear all colored region overlays from a container
 * @param {HTMLElement} container - The container element
 */
export function clearColoredRegions(container) {
    if (!container) return;
    
    const existingOverlays = container.querySelectorAll(".colored-regions-overlay");
    existingOverlays.forEach(overlay => overlay.remove());
}

/**
 * Clear all colored region overlays in the entire image container
 */
export function clearAllColoredRegions() {
    const container = document.getElementById("bone-image-container");
    if (container) {
        clearColoredRegions(container);
    }
}
