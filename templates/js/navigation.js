let currentBone = null;
let currentSubboneIndex = -1;
let subbones = [];

/**
 * Initialises the previous/next subbone navigation buttons and the Home button.
 * @param {HTMLButtonElement} prevButton - The "previous" navigation button.
 * @param {HTMLButtonElement} nextButton - The "next" navigation button.
 * @param {HTMLSelectElement} subboneDropdown - The subbone `<select>` element to keep in sync.
 * @param {function(string): void} updateDescription - Callback invoked with the selected subbone ID
 *   whenever the navigation changes.
 * @returns {void}
 */
export function setupNavigation(prevButton, nextButton, subboneDropdown, updateDescription) {
  // Setup Previous/Next button navigation
  prevButton.addEventListener("click", () => {
    prevSubbone();
    updateUI(subboneDropdown, updateDescription);
  });

  nextButton.addEventListener("click", () => {
    nextSubbone();
    updateUI(subboneDropdown, updateDescription);
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
 * Decrements the current subbone index (moves to the previous subbone), if greater than 0..
 * @returns {void}
 */
function prevSubbone() {
  if (currentSubboneIndex > 0) {
    currentSubboneIndex--;
  }
}

/**
 * Increments the current subbone index (moves to the next subbone), if less than the array of subbones.
 * @returns {void}
 */
function nextSubbone() {
  if (currentSubboneIndex < subbones.length - 1) {
    currentSubboneIndex++;
  }
}

/**
 * Syncs the subbone dropdown to the current index and invokes the description callback.
 * Does nothing if no subbones are loaded.
 * @param {HTMLSelectElement} subboneDropdown - The subbone select element to update.
 * @param {function(string): void} updateDescription - Callback invoked with the selected subbone ID.
 * @returns {void}
 */
function updateUI(subboneDropdown, updateDescription) {
  if (subbones.length === 0 || currentSubboneIndex === -1) return;

  subboneDropdown.selectedIndex = currentSubboneIndex;
  const selectedSubbone = subbones[currentSubboneIndex];
  updateDescription(selectedSubbone);
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
