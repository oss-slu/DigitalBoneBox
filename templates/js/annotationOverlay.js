function ensureStage(container) {
  let stage = container.querySelector(".annotation-stage");
  if (!stage) {
    stage = document.createElement("div");
    stage.className = "annotation-stage";
    stage.innerHTML = `
      <svg class="annotation-svg" width="100%" height="100%" preserveAspectRatio="none"></svg>
      <div class="annotation-labels"></div>
    `;
    container.appendChild(stage);
  }
  return stage;
}

export function clearAnnotations(container) {
  if (!container) return;
  const stage = container.querySelector(".annotation-stage");
  if (stage) stage.remove();
}

/**
 * Calculates pixel dimensions from NORMALIZED coordinates (0.0 to 1.0).
 * Backend now sends coordinates normalized against the full PPT size.
 * @param {Object} rect - The NORMALIZED rectangle {x, y, width, height}. <--- CHANGED INPUT MEANING
 * @param {Object} box - The current container pixel size {w, h}.
 * @param {Object} norm - The normalized geometry {normX, normY, normW, normH}.
 * @returns {Object} Pixel coordinates {left, top, width, height}.
 */
function normalizedRectToPx(rect, box, norm) {
  // Input coordinates (rect.x, rect.y, etc.) are now normalized decimals (0.0 to 1.0).

  // Normalized Offset (normX, normY are also 0.0 to 1.0)
  const normalizedOffsetX = norm.normX;
  const normalizedOffsetY = norm.normY;

  // We calculate pixel coordinates by: (Normalized Coord - Normalized Offset) * Effective Pixel Size (box.w/h)
  return {
    left: (rect.x - normalizedOffsetX) * box.w,
    top: (rect.y - normalizedOffsetY) * box.h,
    width: rect.width * box.w,
    height: rect.height * box.h,
  };
}

/**
 * Calculates pixel point from NORMALIZED coordinates (0.0 to 1.0).
 * @param {Object} pt - The NORMALIZED point {x, y}. <--- CHANGED INPUT MEANING
 * @param {Object} box - The current container pixel size {w, h}.
 * @param {Object} norm - The normalized geometry {normX, normY, normW, normH}.
 * @returns {Object} Pixel coordinates {x, y}.
 */
function normalizedPointToPx(pt, box, norm) { // <--- RENAMED to reflect change
  // Input coordinates (pt.x, pt.y) are normalized decimals (0.0 to 1.0).
  const normalizedOffsetX = norm.normX;
  const normalizedOffsetY = norm.normY;

  return {
    x: (pt.x - normalizedOffsetX) * box.w,
    y: (pt.y - normalizedOffsetY) * box.h
  };
}

/**
 * Draw labels + lines from a JSON object:
 * { annotations: [...], normalized_geometry: { normX, normY, normW, normH } }
 */
export function drawAnnotations(container, annotationsJson) {
  if (!container || !annotationsJson) return;

  const stage = ensureStage(container);
  const svg = stage.querySelector(".annotation-svg");
  const labels = stage.querySelector(".annotation-labels");

  // Clear previous
  svg.innerHTML = "";
  labels.innerHTML = "";

  // Get current pixel dimensions of the image container.
  const rect = container.getBoundingClientRect();

  // Extract the normalization factors from the JSON (provided by backend).
  const norm = annotationsJson.normalized_geometry || { normX: 0, normY: 0, normW: 1, normH: 1 };

  // Define the *effective* coordinate box for scaling.
  // We scale the container size (rect.width/height) by the crop ratios (normW/normH).
  // This calculates the effective pixel dimensions relative to the full PPT slide size.
  const box = {
    w: rect.width / norm.normW,
    h: rect.height / norm.normH
  };

  // Get the list of annotations.
  const list = annotationsJson.annotations || annotationsJson.text_annotations || [];

  list.forEach((a) => {
    if (!a || !a.text_box) return;

    // Text label
    const px = normalizedRectToPx(a.text_box, box, norm);
    const el = document.createElement("div");
    el.className = "annotation-label";

    // this preserves "\n" as real line breaks
    el.innerText = a.text_content ?? "";

    Object.assign(el.style, {
      position: "absolute",
      left: `${px.left}px`,
      top: `${px.top}px`,
      width: `${px.width}px`,
      height: `${px.height}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      whiteSpace: "pre-line",   // show newlines
      textAlign: "center",      // center both lines
    });

    labels.appendChild(el);

    // Pointer lines
    (a.pointer_lines || []).forEach((line) => {
      if (!line?.start_point || !line?.end_point) return;
      const p1 = normalizedPointToPx(line.start_point, box, norm); // <--- CALLING NEW FUNCTION
      const p2 = normalizedPointToPx(line.end_point, box, norm);   // <--- CALLING NEW FUNCTION
      const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l.setAttribute("x1", p1.x);
      l.setAttribute("y1", p1.y);
      l.setAttribute("x2", p2.x);
      l.setAttribute("y2", p2.y);
      l.setAttribute("class", "annotation-line");
      svg.appendChild(l);
    });
  });

  // Store last json for autoscale redraw
  stage.__lastJson = annotationsJson;
}

/** Load JSON from a URL and draw it. Returns a promise. */
export async function loadAndDrawAnnotations(container, jsonUrl) {
  if (!container || !jsonUrl) return;
  const res = await fetch(jsonUrl);
  if (!res.ok) return;
  const data = await res.json();

  // The backend provides data in the structure expected by drawAnnotations
  drawAnnotations(container, data);
  attachAutoscale(container); // keep aligned on resize
}

/** Re-draw on container resize using the last JSON used. */
function attachAutoscale(container) {
  const stage = ensureStage(container);
  if (stage.__resizeObs) return; // already attached

  const ro = new ResizeObserver(() => {
    // Pass the normalization data back in for correct recalculation
    if (stage.__lastJson) drawAnnotations(container, stage.__lastJson);
  });
  ro.observe(container);
  stage.__resizeObs = ro;
}