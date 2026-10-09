// Read-only SVG renderer for scene objects.
//
// The API stores images and annotations as opaque objects, so this renderer only
// reads the fields listed below and never modifies the objects it is given.
// Coordinates are scene pixels.
//   image:            { src, x, y, width, height, rotation?, flipX?, flipY?, opacity? }
//   text annotation:  { type: "text", text, x, y, fontSize?, color?, fontWeight? }
//   line / arrow:     { type: "line" | "arrow", x1, y1, x2, y2 } or { points: [[x, y], ...] },
//                     plus stroke?, strokeWidth?
//   polygon:          { type: "polygon", points: [[x, y], ...] or [{ x, y }, ...] },
//                     plus fill?, stroke?, strokeWidth?, opacity?
// Objects that don't match are skipped and reported as unsupported.

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;
const PADDING = 40;
const DEFAULT_STROKE = "#003366";
// `blob:` is included alongside the existing schemes because Issue #411's image
// import flow previews a freshly chosen file via `URL.createObjectURL(file)` -
// the browser mints that URL itself from a real File/Blob, so it's exactly as
// safe as the already-allowed `data:image/` scheme, never attacker-controllable.
const SAFE_IMAGE_SRC = /^(\/|\.\/|https?:\/\/|data:image\/|blob:)/i;
// Order matches renderImage's own `corners` array: [TL, TR, BR, BL].
const RESIZE_HANDLE_CORNERS = ["nw", "ne", "se", "sw"];
const RESIZE_HANDLE_SIZE = 10;

let markerCount = 0;

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function toPoints(points) {
    if (!Array.isArray(points)) return null;
    const result = [];
    for (const point of points) {
        if (Array.isArray(point) && isNumber(point[0]) && isNumber(point[1])) {
            result.push([point[0], point[1]]);
        } else if (point && isNumber(point.x) && isNumber(point.y)) {
            result.push([point.x, point.y]);
        } else {
            return null;
        }
    }
    return result;
}

function linePoints(annotation) {
    if ([annotation.x1, annotation.y1, annotation.x2, annotation.y2].every(isNumber)) {
        return [[annotation.x1, annotation.y1], [annotation.x2, annotation.y2]];
    }
    const points = toPoints(annotation.points);
    return points && points.length >= 2 ? points : null;
}

function el(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    return node;
}

/**
 * The visible sub-rectangle of an image's own local box (0,0 to width,height)
 * - Issue #417. Defaults to the full box when no crop fields are set, so an
 * uncropped image behaves exactly as before.
 */
function cropRectFor(image) {
    const hasCrop = [image.cropX, image.cropY, image.cropWidth, image.cropHeight].every(isNumber);
    return hasCrop
        ? { x: image.cropX, y: image.cropY, width: image.cropWidth, height: image.cropHeight }
        : { x: 0, y: 0, width: image.width, height: image.height };
}

/**
 * @param {object} image
 * @param {number} index
 * @param {SVGDefsElement} defs
 * @param {{ skipClip?: boolean }} [options] - skipClip shows the full,
 *   unclipped image regardless of any saved crop - used only while actively
 *   editing the crop (Issue #417), so the user can see the whole source to
 *   choose a region from.
 */
function renderImage(image, index, defs, { skipClip = false } = {}) {
    if (typeof image.src !== "string" || !SAFE_IMAGE_SRC.test(image.src)) return null;
    if (![image.x, image.y, image.width, image.height].every(isNumber)) return null;
    if (image.width <= 0 || image.height <= 0) return null;

    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    const transforms = [];
    if (isNumber(image.rotation) && image.rotation !== 0) {
        transforms.push(`rotate(${image.rotation} ${cx} ${cy})`);
    }
    if (image.flipX || image.flipY) {
        const sx = image.flipX ? -1 : 1;
        const sy = image.flipY ? -1 : 1;
        transforms.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
    }

    const crop = cropRectFor(image);
    const isCropped =
        !skipClip && (crop.x !== 0 || crop.y !== 0 || crop.width !== image.width || crop.height !== image.height);

    let clipId;
    if (isCropped) {
        markerCount += 1;
        clipId = `scene-image-clip-${markerCount}`;
        const clipPath = el("clipPath", { id: clipId });
        // In the SAME pre-rotation, absolute coordinates as the image's own
        // x/y/width/height below - both live inside the same transformed <g>
        // when rotated/flipped, so the crop window rotates/flips WITH the
        // image as one rigid unit, not independently of it.
        clipPath.appendChild(el("rect", {
            x: image.x + crop.x,
            y: image.y + crop.y,
            width: crop.width,
            height: crop.height,
        }));
        defs.appendChild(clipPath);
    }

    const imageNode = el("image", {
        href: image.src,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
        preserveAspectRatio: "none",
        opacity: isNumber(image.opacity) ? image.opacity : undefined,
        "clip-path": clipId ? `url(#${clipId})` : undefined,
        class: "scene-image-object",
        "data-scene-image-index": index,
    });

    // The transform only moves to a wrapping <g> when a clip-path is also in
    // play (so the clip rotates/flips with the image, see above) - otherwise
    // it stays directly on the <image>, unchanged from before #417.
    let node = imageNode;
    if (transforms.length) {
        if (clipId) {
            const group = el("g", { transform: transforms.join(" ") });
            group.appendChild(imageNode);
            node = group;
        } else {
            imageNode.setAttribute("transform", transforms.join(" "));
        }
    }

    const fullCorners = [
        [image.x, image.y],
        [image.x + image.width, image.y],
        [image.x + image.width, image.y + image.height],
        [image.x, image.y + image.height],
    ];
    const cropCorners = [
        [image.x + crop.x, image.y + crop.y],
        [image.x + crop.x + crop.width, image.y + crop.y],
        [image.x + crop.x + crop.width, image.y + crop.y + crop.height],
        [image.x + crop.x, image.y + crop.y + crop.height],
    ];
    const visibleCorners = isCropped ? cropCorners : fullCorners;
    const rotation = image.rotation;

    return {
        node,
        // The visible (cropped, if applicable) region - used for the normal
        // selection outline and the canvas's auto-sizing.
        bounds: isNumber(rotation) ? rotatePoints(visibleCorners, rotation, cx, cy) : visibleCorners,
        // The current crop rect regardless of skipClip - used only while
        // actively editing the crop, to draw its own handles/outline.
        cropBounds: isNumber(rotation) ? rotatePoints(cropCorners, rotation, cx, cy) : cropCorners,
    };
}

function rotatePoints(points, degrees, cx, cy) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return points.map(([x, y]) => [
        cx + (x - cx) * cos - (y - cy) * sin,
        cy + (x - cx) * sin + (y - cy) * cos,
    ]);
}

function renderText(annotation) {
    if (typeof annotation.text !== "string" || !isNumber(annotation.x) || !isNumber(annotation.y)) return null;
    const fontSize = isNumber(annotation.fontSize) ? annotation.fontSize : 18;
    const node = el("text", {
        x: annotation.x,
        y: annotation.y,
        "font-size": fontSize,
        "font-weight": annotation.fontWeight,
        fill: annotation.color || DEFAULT_STROKE,
        "dominant-baseline": "hanging",
        class: "scene-text",
    });
    node.textContent = annotation.text;
    const approxWidth = annotation.text.length * fontSize * 0.6;
    return { node, bounds: [[annotation.x, annotation.y], [annotation.x + approxWidth, annotation.y + fontSize]] };
}

function renderLine(annotation, defs) {
    const points = linePoints(annotation);
    if (!points) return null;
    const stroke = annotation.stroke || DEFAULT_STROKE;
    let markerEnd;
    if (annotation.type === "arrow") {
        markerCount += 1;
        const id = `scene-arrowhead-${markerCount}`;
        const marker = el("marker", {
            id,
            viewBox: "0 0 10 10",
            refX: 9,
            refY: 5,
            markerWidth: 8,
            markerHeight: 8,
            orient: "auto-start-reverse",
        });
        marker.appendChild(el("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: stroke }));
        defs.appendChild(marker);
        markerEnd = `url(#${id})`;
    }
    const node = el("polyline", {
        points: points.map((p) => p.join(",")).join(" "),
        fill: "none",
        stroke,
        "stroke-width": isNumber(annotation.strokeWidth) ? annotation.strokeWidth : 2,
        "stroke-linecap": "round",
        "marker-end": markerEnd,
    });
    return { node, bounds: points };
}

function renderPolygon(annotation) {
    const points = toPoints(annotation.points);
    if (!points || points.length < 3) return null;
    const node = el("polygon", {
        points: points.map((p) => p.join(",")).join(" "),
        fill: annotation.fill || "rgba(255, 215, 0, 0.35)",
        stroke: annotation.stroke || DEFAULT_STROKE,
        "stroke-width": isNumber(annotation.strokeWidth) ? annotation.strokeWidth : 1.5,
        opacity: isNumber(annotation.opacity) ? annotation.opacity : undefined,
    });
    return { node, bounds: points };
}

function renderAnnotation(annotation, defs) {
    switch (annotation.type) {
        case "text":
            return renderText(annotation);
        case "line":
        case "arrow":
            return renderLine(annotation, defs);
        case "polygon":
            return renderPolygon(annotation);
        default:
            return null;
    }
}

/**
 * Renders a scene's images and annotations into an SVG element. Optionally draws a
 * non-interactive selection outline around one image, identified by its index in
 * `scene.images` - the same index each rendered `<image>` carries as its
 * `data-scene-image-index` attribute, letting a caller wire up click-to-select
 * without this renderer owning any selection state itself.
 * @param {{ images: object[], annotations: object[] }} scene
 * @param {{ selectedIndex?: number, cropMode?: boolean }} [options] - cropMode
 *   shows the selected image uncropped with handles on its *draft* crop rect
 *   instead of the normal selection outline/resize handles (Issue #417).
 * @returns {{ svg: SVGSVGElement, rendered: number, unsupported: number, width: number, height: number }}
 */
export function renderScene(scene, { selectedIndex, cropMode = false } = {}) {
    const svg = el("svg", { class: "scene-svg", role: "img" });
    const defs = el("defs");
    const imageLayer = el("g", { class: "scene-layer-images" });
    const annotationLayer = el("g", { class: "scene-layer-annotations" });
    const selectionLayer = el("g", { class: "scene-layer-selection" });
    svg.append(defs, imageLayer, annotationLayer, selectionLayer);

    let minX = 0;
    let minY = 0;
    let maxX = MIN_WIDTH;
    let maxY = MIN_HEIGHT;
    let rendered = 0;
    let unsupported = 0;

    const place = (result, layer) => {
        if (!result) {
            unsupported += 1;
            return null;
        }
        layer.appendChild(result.node);
        rendered += 1;
        for (const [x, y] of result.bounds) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        return result;
    };

    (scene.images || []).forEach((image, index) => {
        const isEditingCrop = cropMode && index === selectedIndex;
        const result = place(renderImage(image, index, defs, { skipClip: isEditingCrop }), imageLayer);
        if (result && index === selectedIndex) {
            // While actively editing the crop, the outline/handles track the
            // *draft* crop rect instead of the image's visible bounds, so
            // they can be dragged inward from the full (now unclipped) image.
            const handleBounds = isEditingCrop ? result.cropBounds : result.bounds;
            selectionLayer.appendChild(el("polygon", {
                class: isEditingCrop ? "scene-crop-outline" : "scene-selection-outline",
                points: handleBounds.map((p) => p.join(",")).join(" "),
                "pointer-events": "none",
            }));
            // One square handle per corner (Issues #413/#414/#417), at the
            // same already-rotated bounds the outline above uses -
            // axis-aligned regardless of the image's own rotation.
            handleBounds.forEach(([x, y], cornerIndex) => {
                selectionLayer.appendChild(el("rect", {
                    class: "scene-resize-handle",
                    x: x - RESIZE_HANDLE_SIZE / 2,
                    y: y - RESIZE_HANDLE_SIZE / 2,
                    width: RESIZE_HANDLE_SIZE,
                    height: RESIZE_HANDLE_SIZE,
                    "data-corner": RESIZE_HANDLE_CORNERS[cornerIndex],
                }));
            });
        }
    });
    for (const annotation of scene.annotations || []) place(renderAnnotation(annotation, defs), annotationLayer);

    const x = minX < 0 ? minX - PADDING : 0;
    const y = minY < 0 ? minY - PADDING : 0;
    const width = maxX - x + (maxX > MIN_WIDTH ? PADDING : 0);
    const height = maxY - y + (maxY > MIN_HEIGHT ? PADDING : 0);
    svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);

    return { svg, rendered, unsupported, width, height };
}
