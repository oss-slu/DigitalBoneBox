import {clearAnnotations, drawAnnotations, attachAutoscale} from "./annotationOverlay.js";
import { displayColoredRegions, clearAllColoredRegions } from "./coloredRegionsOverlay.js";
import { imageCaptions } from "./imageCaptions.js";
import { fetchAnnotations } from "./api.js";

let currentBoneId = null;

/**
 * Returns the `#bone-image-container` DOM element.
 * @returns {HTMLElement|null} The image container element, or null if not found.
 */
function getImageContainer() {
  return (
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

  clearAnnotations(c);
  clearAllColoredRegions();
  currentBoneId = null;

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

  clearCaptionContainer();

  currentBoneId = null;

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
 * @param {Object} [options={}] - Optional display configuration.
 * @param {string} [options.annotationsUrl] - API URL for text annotations JSON.
 * @param {string} [options.boneId] - Bone ID used for colored region overlays.
 * @param {boolean} [options.isBonesetSelection] - True when displaying the full boneset view.
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

  if (!Array.isArray(images) || images.length === 0) {
    showPlaceholder();
    return;
  }

  if (images.length === 1) {
    displaySingleImage(images[0], container);
  } else if (images.length === 2) {
    displayTwoImages(images, container);
  } else {
    displayMultipleImages(images, container);
  }

  const imagesContent = document.querySelector(".images-content");
  if (imagesContent) imagesContent.classList.add("has-images");

  // Load and draw annotations based on boneId (fire and forget)
  if (options.boneId) {
    fetchAnnotations(options.boneId)
      .then(annotationData => {
        if (annotationData) {
          drawAnnotations(container, annotationData);
          attachAutoscale(container); // keep aligned on resize
        }
      })
      .catch(err => console.warn("Failed to load annotations:", err));
  }
}

/* Single image */
/**
 * Renders a single bone image with its colored region overlay and text annotations.
 * @param {{url?: string, src?: string, alt?: string, filename?: string}} image - The image object to display.
 * @param {HTMLElement} container - The image container element.
 * @param {Object} [options={}] - Options forwarded from `displayBoneImages`.
 * @returns {void}
 */
function displaySingleImage(image, container) {
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

/**
 * Renders two bone images side by side, each with its own colored region overlay.
 * Appends a two-column caption bar beneath the images if captions are available.
 * @param {Array<{url?: string, src?: string, alt?: string, filename?: string}>} images - Array of exactly two image
 *   objects.
 * @param {HTMLElement} container - The image container element.
 * @returns {void}
 */
function displayTwoImages(images, container) {
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
        displayColoredRegions(img, currentBoneId, index).catch(err => {
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