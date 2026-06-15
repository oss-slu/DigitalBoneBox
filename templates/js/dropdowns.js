// templates/js/dropdowns.js
import { loadDescription } from "./description.js";
import { displayBoneImages, clearImages, showPlaceholder } from "./imageDisplay.js";
import { loadAndDrawAnnotations, clearAnnotations } from "./annotationOverlay.js";
import {fetchBoneData} from "./api.js";

// Show the placeholder ASAP
document.addEventListener("DOMContentLoaded", () => {
  showPlaceholder();
});

// ---- Map/lookup you can extend later -----------------
let _boneById = {}; // filled in setupDropdownListeners

/**
 * Returns the `#bone-image-container` element, which serves as the host for
 * displayed bone images and their annotation overlays.
 * @returns {HTMLElement|null} The image container element, or null if not found.
 */
function getImageStage() {
  return /** @type {HTMLElement|null} */ (document.getElementById("bone-image-container"));
}

/**
 * Clears any existing annotation overlay from the image stage.
 * Annotation loading is now handled directly in the dropdown change listeners
 * via the `opts.annotationsUrl` option passed to `loadBoneImages`.
 * @param {string} boneId - The bone ID (unused; retained for future use).
 * @returns {Promise<void>}
 */
// Function maybeLoadAnnotations: Logic removed. Annotation URL construction is now in the listeners.
async function maybeLoadAnnotations(boneId) {
  const stage = getImageStage();
  if (!stage) return;

  // remove any previous overlay
  clearAnnotations(stage);
  stage.classList.remove("with-annotations");
  
  // Note: The logic for loading the annotation file used to be here, but has been 
  // refactored into the dropdown listeners (using the 'opts' object) to use the API endpoint.
}

// Backend API base (runs on 8000)
const API_BASE = "http://127.0.0.1:8000";

/** Helper: fetch images for a bone/sub-bone and render them
 * @param {string} boneId - The bone or subbone ID to load images for.
 * @param {Object} [options={}] - Options forwarded to `displayBoneImages`.
 * @returns {Promise<void>}
 */
async function loadBoneImages(boneId, options = {}) {
  const stage = getImageStage();
  if (!boneId) {
    showPlaceholder();
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
    return;
  }
  try {
    const data = await fetchBoneData(boneId);
    const images = Array.isArray(data.images) ? data.images : [];
    if (images.length === 0) {
      showPlaceholder();
      if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
    } else {
      // Pass both boneId (for colored regions) and options (for text annotations)
      displayBoneImages(images, { ...options, boneId });
    }
  } catch (err) {
    console.error("Failed to load bone images:", err);
    showPlaceholder();
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
  }
}

/**
 * Populates the boneset `<select>` element with options from the provided array.
 * Disables the dropdown if no bonesets are available.
 * @param {Array<{id: string, name: string}>} bonesets - Array of boneset objects.
 * @returns {void}
 */
export function populateBonesetDropdown(bonesets) {
  const bonesetSelect = document.getElementById("boneset-select");
  if (!bonesetSelect) {
    console.error("populateBonesetDropdown: #boneset-select not found in DOM");
    return;
  }
  bonesetSelect.innerHTML = "<option value=\"\">--Please select a Boneset--</option>";
  if (!bonesets || bonesets.length === 0) {
    bonesetSelect.innerHTML = "<option value=\"\">--No bonesets available--</option>";
    bonesetSelect.disabled = true;
    return;
  }
  bonesets.forEach((set) => {
    const option = document.createElement("option");
    option.value = set.id;
    option.textContent = set.name;
    bonesetSelect.appendChild(option);
  });
  bonesetSelect.disabled = false;
}

/**
 * Wires up change event listeners on the boneset, bone, and subbone `<select>` elements.
 * Each listener loads images, descriptions, and annotations appropriate to the selection.
 * @param {Object} combinedData - The full application data set containing:
 *   `bonesets` {Array}, `bones` {Array}, and `subbones` {Array}.
 * @returns {void}
 */
export function setupDropdownListeners(combinedData) {
  const bonesetSelect  = document.getElementById("boneset-select");
  const boneSelect     = document.getElementById("bone-select");
  const subboneSelect  = document.getElementById("subbone-select");

  if (!combinedData) return;

  // Build quick lookup
  _boneById = Object.fromEntries((combinedData.bones || []).map(b => [b.id, b]));

// Boneset change
bonesetSelect.addEventListener("change", (e) => {
  const selectedBonesetId = e.target.value;

  boneSelect.innerHTML    = "<option value=\"\">--Please choose a Bone--</option>";
  subboneSelect.innerHTML = "<option value=\"\">--Please choose a Bone Part--</option>";
  subboneSelect.disabled  = true;

  const relatedBones = combinedData.bones.filter(b => b.boneset === selectedBonesetId);
  relatedBones.forEach(b => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    boneSelect.appendChild(opt);
  });
  boneSelect.disabled = relatedBones.length === 0;

  if (!selectedBonesetId || relatedBones.length === 0) {
    showPlaceholder();
    const stage = getImageStage();
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
    return;
  }

  // --- START FIX for Boneset Selection (Loads Slide 2 for Bony Pelvis) ---
  const bonesetName =
    (bonesetSelect.options[bonesetSelect.selectedIndex]?.text || "").trim().toLowerCase();

  let targetId = selectedBonesetId; // Use the Boneset ID (e.g., 'bony_pelvis')

  // Set annotation URL using the Boneset ID.
  const opts = (bonesetName === "bony pelvis")
    ? { 
        annotationsUrl: `${API_BASE}/api/annotations/${targetId}`,
        isBonesetSelection: true // Flag to indicate boneset selection
      }
    : {};

  // Load the Boneset description (which shows the overall Boneset text)
  loadDescription(targetId);

  // Load the boneset image using the Boneset ID (e.g., 'bony_pelvis')
  loadBoneImages(targetId, opts); 
  // --- END FIX ---
});


// Bone change
boneSelect.addEventListener("change", (e) => {
  const selectedBoneId = e.target.value;

  subboneSelect.innerHTML = "<option value=\"\">--Please choose a Bone Part--</option>";

  const relatedSubbones = combinedData.subbones.filter(sb => sb.bone === selectedBoneId);
  relatedSubbones.forEach(sb => {
    const opt = document.createElement("option");
    opt.value = sb.id;
    opt.textContent = sb.name;
    subboneSelect.appendChild(opt);
  });
  subboneSelect.disabled = relatedSubbones.length === 0;

  if (selectedBoneId) {
    loadDescription(selectedBoneId);
    
    // --- FIX for Bone Selection (Ensures all Bone annotations load) ---
    // Always build the annotation URL using the selectedBoneId
    const opts = { 
      annotationsUrl: `${API_BASE}/api/annotations/${selectedBoneId}` 
    };    
    
    loadBoneImages(selectedBoneId, opts);
  } else {
    showPlaceholder();
    const stage = getImageStage();
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
  }
});


// Sub-bone change
subboneSelect.addEventListener("change", (e) => {
  const selectedSubboneId = e.target.value;
  const stage = getImageStage();

  // Always clear any existing annotations from the bone-level view
  if (stage) {
    clearAnnotations(stage);
    stage.classList.remove("with-annotations");
  }

  if (selectedSubboneId) {
    // Load the text description for this sub-bone
    loadDescription(selectedSubboneId);

    // 🔑 IMPORTANT:
    // For sub-bones, load the sub-bone–specific annotation JSON,
    // e.g. /api/annotations/pubic_tubercle  (mapped to slide20 JSON on the server)
    const opts = {
      annotationsUrl: `${API_BASE}/api/annotations/${selectedSubboneId}`,
    };

    // This will draw the sub-bone image AND its own labels
    // (or none, if that annotation file has an empty text_annotations array)
    loadBoneImages(selectedSubboneId, opts);
  } else {
    // No sub-bone selected → show placeholder
    showPlaceholder();
  }
});
}