import { loadDescription } from "./description.js";
import {displayBoneImages, showPlaceholder} from "./imageDisplay.js";
import {clearAnnotations} from "./annotationOverlay.js";
import {fetchBoneData} from "./api.js";

document.addEventListener("DOMContentLoaded", () => {
  showPlaceholder();
});

function getImageStage() {
  return (document.getElementById("bone-image-container"));
}

// Backend API base (runs on 8000)
const API_BASE = "http://127.0.0.1:8000";

/** Helper: fetch images for a bone/sub-bone and render them */
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

export function setupDropdownListeners(combinedData) {
  const bonesetSelect  = document.getElementById("boneset-select");
  const boneSelect     = document.getElementById("bone-select");
  const subboneSelect  = document.getElementById("subbone-select");

  if (!combinedData) return;

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

  if (stage) {
    clearAnnotations(stage);
    stage.classList.remove("with-annotations");
  }

  if (selectedSubboneId) {
    loadDescription(selectedSubboneId);

    const opts = {
      annotationsUrl: `${API_BASE}/api/annotations/${selectedSubboneId}`,
    };

    loadBoneImages(selectedSubboneId, opts);
  } else {
    showPlaceholder();
  }
});
}