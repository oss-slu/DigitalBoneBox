/**
 * Displays annotations list for the selected bone
 * @param {Array} annotations - Array of annotation objects
 */
export function displayAnnotations(annotations) {
    const annotationsOverlay = document.getElementById("annotations-overlay");
    if (!annotationsOverlay) {
        console.error("Annotations overlay element not found");
        return;
    }

    // Clear previous annotations
    annotationsOverlay.innerHTML = "";

    if (!annotations || annotations.length === 0) {
        annotationsOverlay.innerHTML = "<p>No annotations available for this bone.</p>";
        return;
    }

    // Create annotation list
    const annotationsList = document.createElement("ul");
    annotationsList.className = "annotations-list";
    
    annotations.forEach((annotation) => {
        const listItem = document.createElement("li");
        listItem.className = "annotation-item";
        listItem.textContent = annotation.text;
        annotationsList.appendChild(listItem);
    });

    annotationsOverlay.appendChild(annotationsList);
}

/**
 * Main function to display complete bone data (annotations only - images handled by imageDisplay.js)
 * @param {Object} boneData - The complete bone object
 */
export function displayBoneData(boneData) {
    if (!boneData) {
        console.error("No bone data provided to display");
        return;
    }

    displayAnnotations(boneData.annotations);
}

/**
 * Clears the viewer display (annotations only - images handled by imageDisplay.js)
 */
export function clearViewer() {
    // Images are cleared by imageDisplay.js
    // Only clear annotations here
    const annotationsOverlay = document.getElementById("annotations-overlay");
    
    if (annotationsOverlay) {
        annotationsOverlay.innerHTML = "<p>Select a bone to view image and annotations.</p>";
    }
}