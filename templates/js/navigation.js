let currentBone = null;
let currentSubboneIndex = -1;
let subbones = [];

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

export function setBoneAndSubbones(bone, boneSubbones) {
  currentBone = bone;
  subbones = boneSubbones || [];
  currentSubboneIndex = subbones.length > 0 ? 0 : -1;
}

function prevSubbone() {
  if (currentSubboneIndex > 0) {
    currentSubboneIndex--;
  }
}

function nextSubbone() {
  if (currentSubboneIndex < subbones.length - 1) {
    currentSubboneIndex++;
  }
}

function updateUI(subboneDropdown, updateDescription) {
  if (subbones.length === 0 || currentSubboneIndex === -1) return;

  subboneDropdown.selectedIndex = currentSubboneIndex;
  const selectedSubbone = subbones[currentSubboneIndex];
  updateDescription(selectedSubbone);
}

export function disableButtons(prevButton, nextButton) {
  const disabled = subbones.length === 0;
  prevButton.disabled = disabled;
  nextButton.disabled = disabled;
}
