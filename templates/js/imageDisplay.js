// js/imageDisplay.js
// Rendering helpers for the image area (no dropdown wiring).

import { clearAnnotations, loadAndDrawAnnotations } from "./annotationOverlay.js";
import { displayColoredRegions, clearAllColoredRegions } from "./coloredRegionsOverlay.js";
import { imageCaptions } from "./imageCaptions.js";

// Track the current boneId for colored regions
let currentBoneId = null;
let currentIsBonesetSelection = false; // Track if this is a boneset selection

/**
 * Returns the `#bone-image-container` DOM element.
 * @returns {HTMLElement|null} The image container element, or null if not found.
 */
function getImageContainer() {
  return /** @type {HTMLElement|null} */ (
    document.getElementById("bone-image-container")
  );
}

/** Helper function to get captions for a boneId
 * @param {string|null} boneId - The bone or subbone ID.
 * @returns {{image1: string|null, image2: string|null}} Caption strings for the two images, or nulls if not found.
 */
function getCaptionsForBone(boneId) {
  if (!boneId || !imageCaptions[boneId]) {
    return { image1: null, image2: null };
  }
  return imageCaptions[boneId];
}

/** Removes the `#caption-container` element from the DOM if it exists.
 * @returns {void}
 */
function clearCaptionContainer() {
  const existingCaptions = document.getElementById("caption-container");
  if (existingCaptions) {
    existingCaptions.remove();
  }
}

/**
 * Renders the empty-state placeholder message inside the image container
 * and clears all text annotations, colored regions, and captions.
 * @returns {void}
 */
export function showPlaceholder() {
  const c = getImageContainer();
  if (!c) return;
  c.innerHTML = `
    <div class="images-placeholder full-width-placeholder">
      <p>Please select a bone from the dropdown to view its image.</p>
    </div>
  `;
  // Clear both text annotations and colored regions
  clearAnnotations(c);
  clearAllColoredRegions();
  currentBoneId = null;

  // Clear caption container
  clearCaptionContainer();

  // Remove black background class when showing placeholder
  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.remove("has-images");
}

/**
 * Clears all images, text annotations, colored regions, and captions from the image container.
 * @returns {void}
 */
export function clearImages() {
  const c = getImageContainer();
  if (c) {
    c.innerHTML = "";
    clearAnnotations(c);
    clearAllColoredRegions();
  }

  // Clear caption container
  clearCaptionContainer();

  currentBoneId = null;
  currentIsBonesetSelection = false; // Reset the flag

  // Remove black background class when clearing images
  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.remove("has-images");
}

/**
 * Renders one or more bone images into the image container, applying the appropriate
 * layout (single, two-up, or grid) based on the number of images provided.
 * Also loads colored region overlays and text annotation overlays if applicable.
 * @param {Array<{url?: string, src?: string, alt?: string, filename?: string}>} images - Array of image objects to
 *   display.
 * @param {Object} [options={}] - Optional display configuration:
 *   @param {string} [options.annotationsUrl] - API URL for text annotation JSON.
 *   @param {string} [options.boneId] - Bone ID used for colored region overlays.
 *   @param {boolean} [options.isBonesetSelection] - True when displaying the full boneset view.
 * @returns {void}
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

  // Add has-images class when images are displayed
  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.add("has-images");

  // Draw annotations if provided
  if (options.annotationsUrl) {
    loadAndDrawAnnotations(container, options.annotationsUrl).catch(err =>
      console.warn("Failed to load annotations:", err)
    );
  }
}

//** ---- Single image ------------------------------------------------------ */
/**
 * Renders a single bone image with its colored region overlay and text annotations.
 * @param {{url?: string, src?: string, alt?: string, filename?: string}} image - The image object to display.
 * @param {HTMLElement} container - The image container element.
 * @param {Object} [options={}] - Options forwarded from `displayBoneImages`.
 * @returns {void}
 */
function displaySingleImage(image, container, options = {}) {
  // Get captions for this bone
  const captions = getCaptionsForBone(currentBoneId);

  // 1. CRITICAL FIX: Add the 'single-image' class to the main container.
  container.className = "single-image";

  // 2. Use innerHTML to directly create the necessary structure
  container.innerHTML = `
    <div class="single-image-wrapper">
      <img
        class="bone-image"
        src="${image.url || image.src || ""}"
        alt="${image.alt || image.filename || "Bone image"}"
      >
    </div>
  `;

  // --- MODIFIED: Caption Logic ---
  if (captions.image1) {
    clearCaptionContainer();

    const captionContainer = document.createElement("div");
    captionContainer.id = "caption-container";

    // UPDATED: Added margin-top: 15px to move it down
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

  // 3. Get reference to the image element for colored regions and event handlers
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

/** ---- Two images (with rotation template) ------------------------------- */
const TWO_IMAGE_ROTATION = {
  left: { rot_deg: -16.999, flipH: false },
  right: { rot_deg: 0, flipH: false },
};

/**
 * Applies a CSS rotation (and optional horizontal flip) to an image element
 * based on the PowerPoint rotation template for the given view.
 * @param {HTMLImageElement} imgEl - The image element to transform.
 * @param {Object} [options={}] - Rotation parameters.
 * @param {number} [options.rot_deg=0] - Rotation angle in degrees.
 * @param {boolean} [options.flipH=false] - Whether to flip the image horizontally.
 * @returns {void}
 */
function applyRotation(imgEl, { rot_deg = 0, flipH = false } = {}) {
  const parts = [];
  if (flipH) parts.push("scaleX(-1)");
  if (rot_deg && Math.abs(rot_deg) > 0.001) parts.push(`rotate(${rot_deg}deg)`);
  imgEl.style.transform = parts.join(" ") || "none";
  imgEl.style.transformOrigin = "50% 50%";
  imgEl.style.willChange = "transform";
}

/**
 * Renders two bone images side by side, each with its own colored region overlay.
 * Appends a two-column caption bar beneath the images if captions are available.
 * @param {Array<{url?: string, src?: string, alt?: string, filename?: string}>} images - Array of exactly two image
 *   objects.
 * @param {HTMLElement} container - The image container element.
 * @param {Object} [options={}] - Options forwarded from `displayBoneImages`.
 * @returns {void}
 */
function displayTwoImages(images, container, options = {}) {
  // Get captions for this bone
  const captions = getCaptionsForBone(currentBoneId);

  // Add the two-images class to the container for CSS styling
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

  // --- MODIFIED: Caption Logic ---
  if (captions.image1 || captions.image2) {
    clearCaptionContainer();

    const captionContainer = document.createElement("div");
    captionContainer.id = "caption-container";

    // UPDATED: Added margin-top: 15px to move it down
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

    // UPDATED: Changed text color to white for visibility
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

/** ---- 3+ images grid ---------------------------------------------------- */
/**
 * Renders three or more bone images in a wrapping grid layout.
 * Does not load colored regions or annotations (used for supplementary views).
 * @param {Array<{url?: string, src?: string, alt?: string, filename?: string}>} images - Array of image objects.
 * @param {HTMLElement} container - The image container element.
 * @returns {void}
 */
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