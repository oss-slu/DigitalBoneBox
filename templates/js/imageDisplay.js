import { clearAnnotations, loadAndDrawAnnotations } from "./annotationOverlay.js";
import { displayColoredRegions, clearAllColoredRegions } from "./coloredRegionsOverlay.js";
import { imageCaptions } from "./imageCaptions.js";

let currentBoneId = null;
let currentIsBonesetSelection = false; // Track if this is a boneset selection

function getImageContainer() {
  return (
    document.getElementById("bone-image-container")
  );
}

/** Helper function to get captions for a boneId */
function getCaptionsForBone(boneId) {
  if (!boneId || !imageCaptions[boneId]) {
    return { image1: null, image2: null };
  }
  return imageCaptions[boneId];
}

/** Helper to clear existing caption container */
function clearCaptionContainer() {
  const existingCaptions = document.getElementById("caption-container");
  if (existingCaptions) {
    existingCaptions.remove();
  }
}

/** Empty-state / clearing */
export function showPlaceholder() {
  const c = getImageContainer();
  if (!c) return;
  c.innerHTML = `
    <div class="images-placeholder full-width-placeholder">
      <p>Please select a bone from the dropdown to view its image.</p>
    </div>
  `;

  clearAnnotations(c);
  clearAllColoredRegions();
  currentBoneId = null;

  clearCaptionContainer();

  // Remove black background class when showing placeholder
  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.remove("has-images");
}

export function clearImages() {
  const c = getImageContainer();
  if (c) {
    c.innerHTML = "";
    clearAnnotations(c);
    clearAllColoredRegions();
  }

  clearCaptionContainer();

  currentBoneId = null;
  currentIsBonesetSelection = false; // Reset the flag

  // Remove black background class when clearing images
  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.remove("has-images");
}

/** ---- Public entry: render images array --------------------------------
 * Optionally pass { annotationsUrl: 'templates/data/annotations/xyz.json', boneId: 'bone_name' }
 */
export function displayBoneImages(images, options = {}) {
  const container = getImageContainer();
  if (!container) {
    console.warn("bone-image-container not found");
    return;
  }

  clearImages();

  // Store boneId for colored regions AFTER clearing (so it doesn't get reset to null)
  currentBoneId = options.boneId || null;
  currentIsBonesetSelection = options.isBonesetSelection || false; // Store boneset flag

  if (!Array.isArray(images) || images.length === 0) {
    showPlaceholder();
    return;
  }

  if (images.length === 1) {
    displaySingleImage(images[0], container, options);
  } else if (images.length === 2) {
    displayTwoImages(images, container, options);
  } else {
    displayMultipleImages(images, container);
  }

  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.add("has-images");

  if (options.annotationsUrl) {
    loadAndDrawAnnotations(container, options.annotationsUrl).catch(err =>
      console.warn("Failed to load annotations:", err)
    );
  }
}

/* Single image */
function displaySingleImage(image, container, options = {}) {
  const captions = getCaptionsForBone(currentBoneId);

  container.className = "single-image";
  container.innerHTML = `
    <div class="single-image-wrapper">
      <img
        class="bone-image"
        src="${image.url || image.src || ""}"
        alt="${image.alt || image.filename || "Bone image"}"
      >
    </div>
  `;

  // Caption Logic
  if (captions.image1) {
    clearCaptionContainer();

    const captionContainer = document.createElement("div");
    captionContainer.id = "caption-container";

    captionContainer.style.cssText = `
      text-align: center;
      padding: 12px 0 5px 0;
      background: #000000;
      color: #ffffff; 
      font-size: 14px;
      font-weight: 600;
      width: 100%;
      box-sizing: border-box;
      margin-top: 15px; 
    `;
    captionContainer.textContent = captions.image1;

    // Insert right after the bone-image-container (inside the Visual Reference panel)
    container.insertAdjacentElement("afterend", captionContainer);
  }

  // Get reference to the image element for colored regions and event handlers
  const img = container.querySelector("img");
  if (img) {
    const loadColoredRegions = () => {
      img.classList.add("loaded");
      // Display colored regions after image loads
      if (currentBoneId) {
        displayColoredRegions(img, currentBoneId, 0).catch(err => {
          console.warn(`Could not display colored regions for ${currentBoneId}:`, err);
        });
      }
      // Load text annotations if provided
      if (options.annotationsUrl) {
        loadAndDrawAnnotations(container, options.annotationsUrl).catch(err => {
          console.warn("Failed to load text annotations:", err);
        });
      }
    };

    img.addEventListener("load", loadColoredRegions);
    img.addEventListener("error", () => {
      const wrapper = img.parentElement;
      if (wrapper) wrapper.textContent = "Failed to load image.";
    });

    // Check if already loaded (cached) - use setTimeout to let browser process
    setTimeout(() => {
      if (img.complete && img.naturalHeight !== 0) {
        loadColoredRegions();
      }
    }, 0);
  }
}

function displayTwoImages(images, container, options = {}) {
  const captions = getCaptionsForBone(currentBoneId);

  container.className = "two-images";

  images.slice(0, 2).forEach((image, index) => {
    const imgItem = document.createElement("div");
    imgItem.className = "image-item";

    const img = document.createElement("img");
    img.alt = image.alt || image.filename || "Bone image";

    const loadColoredRegions = () => {
      img.classList.add("loaded");
      // Display colored regions for this image
      if (currentBoneId) {
        displayColoredRegions(img, currentBoneId, index, currentIsBonesetSelection).catch(err => {
          console.error(`[ImageDisplay] Could not display colored regions for ${currentBoneId} image ${index}:`, err);
        });
      } else {
        console.warn(`[ImageDisplay] currentBoneId is NULL, cannot load colored regions for image ${index}`);
      }
    };

    // Add event listeners BEFORE setting src
    img.addEventListener("load", loadColoredRegions);
    img.addEventListener("error", () => {
      console.error(`[ImageDisplay] Image ${index} failed to load`);
      imgItem.textContent = "Failed to load image.";
    });

    imgItem.appendChild(img);
    container.appendChild(imgItem);

    // Set src LAST - this triggers the load
    img.src = image.url || image.src || "";

    // Check if image is already loaded from cache after setting src
    // Use setTimeout to allow the browser to process the src assignment first
    setTimeout(() => {
      if (img.complete && img.naturalWidth > 0) {
        loadColoredRegions();
      }
    }, 10);
  });

  // Caption Logic
  if (captions.image1 || captions.image2) {
    clearCaptionContainer();

    const captionContainer = document.createElement("div");
    captionContainer.id = "caption-container";

    captionContainer.style.cssText = `
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 12px 0 5px 0;
      width: 100%;
      background: #000000;
      box-sizing: border-box;
      margin-top: 15px;
    `;

    const captionStyle = `
      text-align: center;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
    `;

    // Add first caption
    const caption1 = document.createElement("div");
    caption1.style.cssText = captionStyle;
    caption1.textContent = captions.image1 || "";
    captionContainer.appendChild(caption1);

    // Add second caption
    const caption2 = document.createElement("div");
    caption2.style.cssText = captionStyle;
    caption2.textContent = captions.image2 || "";
    captionContainer.appendChild(caption2);

    // Insert right after the bone-image-container (inside the Visual Reference panel)
    container.insertAdjacentElement("afterend", captionContainer);
  }
}

/** 3+ images grid */
function displayMultipleImages(images, container) {
  const wrapper = document.createElement("div");
  wrapper.className = "multiple-image-wrapper";

  images.forEach((image) => {
    const imgBox = document.createElement("div");
    imgBox.className = "image-box";

    const img = document.createElement("img");
    img.className = "bone-image";
    img.src = image.url || image.src || "";
    img.alt = image.alt || image.filename || "Bone image";

    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => (imgBox.textContent = "Failed to load image."));

    imgBox.appendChild(img);
    wrapper.appendChild(imgBox);
  });

  container.appendChild(wrapper);
}