let currentBone = null;
let currentSubboneIndex = -1;
let subbones = [];

/**
 * Initialises the previous/next subbone navigation buttons and the Home button.
 * @param {HTMLButtonElement} prevButton - The "previous" navigation button.
 * @param {HTMLButtonElement} nextButton - The "next" navigation button.
 * @param {HTMLSelectElement} subboneDropdown - The subbone `<select>` element to keep in sync.
 * @returns {void}
 */
export function setupNavigation(prevButton, nextButton, subboneDropdown) {
  // Setup Previous/Next button navigation
  prevButton.addEventListener("click", () => {
    if (prevSubbone()) updateUI(subboneDropdown);
  });

  nextButton.addEventListener("click", () => {
    if (nextSubbone()) updateUI(subboneDropdown);
  });

  disableButtons(prevButton, nextButton);

  setupHomeButton();
}

/**
 * Sets up the Home button to reset the application to initial state
 */
function setupHomeButton() {
  const homeButton = document.getElementById("text-button-Home");
  
  if (!homeButton) {
    console.warn("Home button not found in DOM");
    return;
  }

  homeButton.addEventListener("click", resetToInitialState);

  homeButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      resetToInitialState();
    }
  });

  // Add visual feedback on hover
  homeButton.style.cursor = "pointer";
}

/**
 * Resets the entire application to its initial load state
 */
function resetToInitialState() {
  // Provide immediate visual feedback
  const homeButton = document.getElementById("text-button-Home");
  if (homeButton) {
    homeButton.style.opacity = "0.6";
    setTimeout(() => {
      homeButton.style.opacity = "1";
    }, 150);
  }
  
  window.location.reload();
}

/**
 * Sets the currently active bone and its associated subbones for navigation,
 * resetting the index to the first subbone.
 * @param {string} bone - The ID of the currently selected bone.
 * @param {string[]} boneSubbones - Array of subbone IDs belonging to that bone.
 * @returns {void}
 */
export function setBoneAndSubbones(bone, boneSubbones) {
  currentBone = bone;
  subbones = boneSubbones || [];
  currentSubboneIndex = subbones.length > 0 ? 0 : -1;
}

/**
 * Decrements the current subbone index (moves to the previous subbone), if greater than 0.
 * @returns {boolean} True if the index moved, false if already at the first subbone.
 */
function prevSubbone() {
  if (currentSubboneIndex > 0) {
    currentSubboneIndex--;
    return true;
  }
  return false;
}

/**
 * Increments the current subbone index (moves to the next subbone), if less than the array of subbones.
 * @returns {boolean} True if the index moved, false if already at the last subbone.
 */
function nextSubbone() {
  if (currentSubboneIndex < subbones.length - 1) {
    currentSubboneIndex++;
    return true;
  }
  return false;
}

/**
 * Syncs the subbone dropdown to the current index and dispatches a native "change"
 * event so the same listeners that handle a manual dropdown selection (description,
 * image, and annotation loading) also run for Prev/Next navigation. Setting
 * `selectedIndex` alone does not fire "change", which is why those listeners were
 * previously skipped. The dropdown is set by `.value` rather than `.selectedIndex`
 * because the real `<select>` has a placeholder option before the subbone options,
 * so `currentSubboneIndex` (0-based into `subbones`) does not match the option's
 * position in the dropdown. Does nothing if no subbones are loaded.
 * @param {HTMLSelectElement} subboneDropdown - The subbone select element to update.
 * @returns {void}
 */
function updateUI(subboneDropdown) {
  if (subbones.length === 0 || currentSubboneIndex === -1) return;

  subboneDropdown.value = subbones[currentSubboneIndex];
  subboneDropdown.dispatchEvent(new Event("change"));
}

/**
 * Enables or disables the previous/next buttons depending on whether any subbones
 * are currently loaded.
 * @param {HTMLButtonElement} prevButton - The "previous" navigation button.
 * @param {HTMLButtonElement} nextButton - The "next" navigation button.
 * @returns {void}
 */
export function disableButtons(prevButton, nextButton) {
  const disabled = subbones.length === 0;
  prevButton.disabled = disabled;
  nextButton.disabled = disabled;
}
