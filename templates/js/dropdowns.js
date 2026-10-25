import { loadDescription } from "./description.js";
import {displayBoneImages, showPlaceholder} from "./imageDisplay.js";
import {clearAnnotations} from "./annotationOverlay.js";
import { fetchBoneDataResult, BONE_DATA_STATUS } from "./api.js";
import { imageAnnotationToDropdownMap } from "./imageAnnotationToDropdownMap.js";
import { showSceneLinks, SHOW_IN_VIEWER_EVENT } from "./sceneLinks.js";

document.addEventListener("DOMContentLoaded", () => {
  showPlaceholder();
});

/**
 * Returns the `#bone-image-container` element, which serves as the host for
 * displayed bone images and their annotation overlays.
 * @returns {HTMLElement|null} The image container element, or null if not found.
 */
function getImageStage() {
  return (document.getElementById("bone-image-container"));
}


// Counts image requests so a slow answer for an item the user already left
// can't replace the item they're looking at now (Issue #469).
let latestImageRequest = 0;

/**
 * Shows a message in the image area when the selected item has no images yet,
 * instead of the "please select a bone" prompt (Issue #469). Some items in the
 * dropdowns (like the Skull views) don't have migrated content yet.
 * @returns {void}
 */
function showNoImagesMessage() {
  showPlaceholder();
  const message = document.querySelector("#bone-image-container .images-placeholder p");
  if (message) {
    message.textContent = "There are no images for this item yet. Try one of the bones or bone parts under it.";
  }
}

/**
 * Shows an error in the image area when the item's data couldn't be loaded
 * (network problem or server error), with a button to try again.
 * This is kept separate from the "no images yet" message so an outage doesn't
 * make real content look like it hasn't been migrated.
 * @param {Function} onRetry - Called when the user clicks "Try again".
 * @returns {void}
 */
function showLoadErrorMessage(onRetry) {
  showPlaceholder();
  const placeholder = document.querySelector("#bone-image-container .images-placeholder");
  if (!placeholder) return;
  placeholder.classList.add("images-load-error");
  placeholder.setAttribute("role", "alert");

  const message = placeholder.querySelector("p");
  if (message) {
    message.textContent = "We couldn't load the images for this item. Check your connection and try again.";
  }

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "images-retry-button";
  retryButton.textContent = "Try again";
  retryButton.addEventListener("click", () => onRetry());
  placeholder.appendChild(retryButton);
}

/** Helper: fetch images for a bone/sub-bone and render them.
 * @param {string} boneId - The bone or subbone ID to load images for.
 * @param {Object} [options={}] - Options forwarded to `displayBoneImages`.
 * @returns {Promise<void>}
 */
async function loadBoneImages(boneId, options = {}) {
  const stage = getImageStage();
  const requestId = ++latestImageRequest;
  const resetStage = () => {
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
  };

  resetStage();

  // Links to any scenes made from this item (hidden when there are none).
  showSceneLinks(boneId || null);

  if (!boneId) {
    showPlaceholder();
    resetStage();
    return;
  }

  const showError = () => {
    showLoadErrorMessage(() => loadBoneImages(boneId, options));
    resetStage();
  };

  try {
    const result = await fetchBoneDataResult(boneId);
    if (requestId !== latestImageRequest) return;

    if (!result || result.status === BONE_DATA_STATUS.ERROR) {
      showError();
      return;
    }

    const data = result.status === BONE_DATA_STATUS.OK ? result.data : null;
    const images = data && Array.isArray(data.images) ? data.images : [];
    if (images.length === 0) {
      // Confirmed missing (404) or the item exists but has no images yet.
      showNoImagesMessage();
      resetStage();
    } else {
      // Pass both boneId (for colored regions) and options (for text annotations)
      displayBoneImages(images, { ...options, boneId });
    }
  } catch (err) {
    if (requestId !== latestImageRequest) return;
    console.error("Failed to load bone images:", err);
    showError();
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
 * @param {Object} combinedData - The full application data set.
 * @param {Array<Object>} combinedData.bonesets - Array of boneset objects.
 * @param {Array<Object>} combinedData.bones - Array of bone objects.
 * @param {Array<Object>} combinedData.subbones - Array of subbone objects.
 * @returns {void}
 */
export function setupDropdownListeners(combinedData) {
  const bonesetSelect  = document.getElementById("boneset-select");
  const boneSelect     = document.getElementById("bone-select");
  const subboneSelect  = document.getElementById("subbone-select");

  if (!combinedData) return;

  // The Scene Editor asks the viewer to show the item a scene came from (Issue #469).
  document.addEventListener(SHOW_IN_VIEWER_EVENT, (e) => {
    // Skip if this page was re-rendered and these dropdowns are no longer on it.
    if (!bonesetSelect || !bonesetSelect.isConnected) return;
    showItemInViewer(combinedData, e.detail && e.detail.boneId);
  });

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
    const stage = getImageStage();
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }
    loadBoneImages(null);
    return;
  }

  let targetId = selectedBonesetId; // Use the Boneset ID (e.g., 'bony_pelvis')

  // Pass boneId and boneset selection flag to the image loader
  const opts = {
    boneId: targetId,
  };

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

    const opts = { boneId: selectedBoneId };

    loadBoneImages(selectedBoneId, opts);
  } else {
    const stage = getImageStage();
    if (stage) { clearAnnotations(stage); stage.classList.remove("with-annotations"); }

    // Deselecting the bone shouldn't blank the display if a boneset is still
    // selected (Issue #248) - fall back to showing that boneset's info.
    const selectedBonesetId = bonesetSelect.value;
    if (selectedBonesetId) {
      loadDescription(selectedBonesetId);
      loadBoneImages(selectedBonesetId, { boneId: selectedBonesetId });
    } else {
      loadBoneImages(null);
    }
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
      boneId: selectedSubboneId,
    };

    loadBoneImages(selectedSubboneId, opts);
  } else {
    // Same fallback as the bone-change listener above, one level down:
    // deselecting the sub-bone should reveal the parent bone's info, not go blank.
    const selectedBoneId = boneSelect.value;
    if (selectedBoneId) {
      loadDescription(selectedBoneId);
      loadBoneImages(selectedBoneId, { boneId: selectedBoneId });
    } else {
      loadBoneImages(null);
    }
  }
});

  document.addEventListener("checkAnnotationLink", (e) => {
    let checkText = e.detail.text;
    if (!checkText) return;

    checkText = checkText.replace(/\s+/g, " ").trim().toLowerCase();
    const currentBone = boneSelect.value;

    if (currentBone && imageAnnotationToDropdownMap[currentBone] && imageAnnotationToDropdownMap[currentBone][checkText]) {
        checkText = imageAnnotationToDropdownMap[currentBone][checkText];
    }

    const isValidSubbone = combinedData.subbones.some(sb => sb.name?.toLowerCase() === checkText);
    const isValidBone = combinedData.bones.some(b => b.name?.toLowerCase() === checkText);

    if (isValidSubbone || isValidBone) {
        e.detail.isValid = true;
    }
  });

  // Image annotation clicked
  document.addEventListener("annotationSelected", (e) => {
    let clickedText = e.detail.text;
    if (!clickedText) return;

    clickedText = clickedText.replace(/\s+/g, " ").trim().toLowerCase();

    const currentBone = boneSelect.value;

    // Mapping the image annotation to dropdown option
    // If the currently viewed bone has a dictionary, and the clicked text is in it, translate it.
    if (currentBone && imageAnnotationToDropdownMap[currentBone] && imageAnnotationToDropdownMap[currentBone][clickedText]) {
        clickedText = imageAnnotationToDropdownMap[currentBone][clickedText];
    }

    // Check Sub-bones
    const matchedSubbone = combinedData.subbones.find(
      sb => sb.name?.toLowerCase() === clickedText
    );

    if (matchedSubbone) {
      if (boneSelect.value !== matchedSubbone.bone) {
         boneSelect.value = matchedSubbone.bone;
         boneSelect.dispatchEvent(new Event("change"));
      }
      subboneSelect.value = matchedSubbone.id;
      subboneSelect.dispatchEvent(new Event("change"));
      return;
    }

    // Check Bones
    const matchedBone = combinedData.bones.find(
      b => b.name?.toLowerCase() === clickedText
    );

    if (matchedBone) {
      boneSelect.value = matchedBone.id;
      boneSelect.dispatchEvent(new Event("change"));
      return;
    }

  });
}

/**
 * Selects an item in the boneset, bone, and bone part dropdowns, the same as
 * if the user picked it, so its description and images load (Issue #469).
 * @param {Object} combinedData - The full application data set.
 * @param {string} itemId - A boneset, bone, or bone part id.
 * @returns {boolean} false if the item isn't in the dropdowns.
 */
export function showItemInViewer(combinedData, itemId) {
  const bonesetSelect = document.getElementById("boneset-select");
  const boneSelect = document.getElementById("bone-select");
  const subboneSelect = document.getElementById("subbone-select");
  if (!combinedData || !itemId || !bonesetSelect || !boneSelect || !subboneSelect) return false;

  const subbone = combinedData.subbones.find((sb) => sb.id === itemId);
  const bone = combinedData.bones.find((b) => b.id === (subbone ? subbone.bone : itemId));
  let bonesetId = null;
  if (bone) {
    bonesetId = bone.boneset;
  } else if (combinedData.bonesets.some((set) => set.id === itemId)) {
    bonesetId = itemId;
  }
  if (!bonesetId) return false;

  const choose = (select, value) => {
    select.disabled = false;
    select.value = value;
    select.dispatchEvent(new Event("change"));
  };
  choose(bonesetSelect, bonesetId);
  if (bone) choose(boneSelect, bone.id);
  if (subbone) choose(subboneSelect, subbone.id);
  return true;
}
