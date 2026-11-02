// Read-only SVG renderer for scene objects.
//
// The API stores images and annotations as opaque objects, so this renderer only
// reads the fields listed below and never modifies the objects it is given.
// Coordinates are scene pixels.
//   image:            { src, x, y, width, height, rotation?, flipX?, flipY?, opacity? }
//   text annotation:  { type: "text", text, x, y, fontSize?, color?, fontWeight? }
//                     (`text` may hold several lines separated by "\n")
//   line / arrow:     { type: "line" | "arrow", x1, y1, x2, y2 } or { points: [[x, y], ...] },
//                     plus stroke?, strokeWidth?
//   polygon:          { type: "polygon", points: [[x, y], ...] or [{ x, y }, ...] },
//                     plus fill?, fillOpacity?, stroke?, strokeWidth?, opacity?
// Objects that don't match are skipped and reported as unsupported.
//
// Linked annotations (PR #493 review): an annotation imported with a bone's
// images carries `sourceImageId` and `sourceImageFrame` ({ x, y, width,
// height }: its image's box when the annotation was created). Its stored
// coordinates are scene pixels relative to that frame and are never rewritten;
// it is drawn mapped onto its image's *current* box, flip and rotation, in
// the same order renderImage applies them to the image, so it follows the
// image when it is moved, resized, flipped, or rotated. Text is moved and
// scaled but kept upright so it stays readable. On a cropped image, colored
// regions (painted on the bone) are clipped to the visible crop area; labels
// and pointer lines are kept, unclipped, because they usually sit beside the
// image. If the source image is no longer in the scene, the annotation is
// drawn unchanged and counted in `unlinked`.

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
const POINT_HANDLE_RADIUS = 6;
// A region traced from a legacy outline can have hundreds of points; past this
// many, it can still be moved as a whole but its points get no handles.
const MAX_POINT_HANDLES = 40;
const DEFAULT_FONT_SIZE = 18;
const TEXT_LINE_HEIGHT = 1.2;
// Thin lines are hard to click, so each line also gets a wider invisible stroke.
const LINE_HIT_WIDTH = 12;

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

function isValidBox(box) {
    return Boolean(box) && [box.x, box.y, box.width, box.height].every(isNumber) && box.width > 0 && box.height > 0;
}

/**
 * The transform from an annotation's sourceImageFrame to where its image is
 * drawn now: `toBox` moves/resizes into the image's current box, and
 * `toScreen` then flips and rotates about the box center exactly as
 * renderImage's SVG transform does (flip first, then rotate).
 */
function imageTransform(image, frame) {
    const sx = image.width / frame.width;
    const sy = image.height / frame.height;
    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    const rotation = isNumber(image.rotation) ? image.rotation : 0;
    const toBox = ([x, y]) => [image.x + (x - frame.x) * sx, image.y + (y - frame.y) * sy];
    const toScreen = ([x, y]) => {
        const flipped = [image.flipX ? 2 * cx - x : x, image.flipY ? 2 * cy - y : y];
        return rotation ? rotatePoints([flipped], rotation, cx, cy)[0] : flipped;
    };
    // The exact inverse, for storing an edit made on the drawn annotation.
    const fromScreen = (point) => {
        const [x, y] = rotation ? rotatePoints([point], -rotation, cx, cy)[0] : point;
        const unflipped = [image.flipX ? 2 * cx - x : x, image.flipY ? 2 * cy - y : y];
        return [frame.x + (unflipped[0] - image.x) / sx, frame.y + (unflipped[1] - image.y) / sy];
    };
    return { map: (point) => toScreen(toBox(point)), unmap: fromScreen, toScreen, scale: (sx + sy) / 2 };
}

/**
 * The box a text annotation is drawn in. Width is estimated from the longest
 * line (the same 0.6em-per-character estimate legacyAnnotations.js uses);
 * a single line is exactly `fontSize` tall, as before multi-line labels.
 * @param {{ text: string, x: number, y: number, fontSize?: number }} annotation
 */
export function textBox(annotation) {
    const fontSize = isNumber(annotation.fontSize) ? annotation.fontSize : DEFAULT_FONT_SIZE;
    const lines = annotation.text.split("\n");
    const longest = Math.max(...lines.map((line) => line.length));
    return {
        x: annotation.x,
        y: annotation.y,
        width: longest * fontSize * 0.6,
        height: fontSize + (lines.length - 1) * fontSize * TEXT_LINE_HEIGHT,
        fontSize,
        lines,
    };
}

/** A copy of a linked annotation with its coordinates mapped onto its image. */
function mapLinkedAnnotation(annotation, transform) {
    const scaled = (value) => (isNumber(value) ? value * transform.scale : value);
    switch (annotation.type) {
        case "text": {
            if (typeof annotation.text !== "string" || !isNumber(annotation.x) || !isNumber(annotation.y)) return annotation;
            const box = textBox(annotation);
            const [centerX, centerY] = transform.map([box.x + box.width / 2, box.y + box.height / 2]);
            return {
                ...annotation,
                x: centerX - (box.width * transform.scale) / 2,
                y: centerY - (box.height * transform.scale) / 2,
                fontSize: box.fontSize * transform.scale,
            };
        }
        case "line":
        case "arrow": {
            const points = linePoints(annotation);
            if (!points) return annotation;
            const { x1: _x1, y1: _y1, x2: _x2, y2: _y2, ...rest } = annotation;
            return { ...rest, points: points.map(transform.map), strokeWidth: scaled(annotation.strokeWidth) };
        }
        case "polygon": {
            const points = toPoints(annotation.points);
            if (!points) return annotation;
            return { ...annotation, points: points.map(transform.map), strokeWidth: scaled(annotation.strokeWidth) };
        }
        default:
            return annotation;
    }
}

/**
 * The points that shape a line, arrow, or polygon, as [x, y] pairs, or null
 * for text and for objects without usable points.
 */
export function annotationPoints(annotation) {
    if (!annotation) return null;
    if (annotation.type === "line" || annotation.type === "arrow") return linePoints(annotation);
    if (annotation.type === "polygon") return toPoints(annotation.points);
    return null;
}

/** The transform for an annotation linked to an image still in the scene, else null. */
function linkedTransform(annotation, scene) {
    if (!annotation || annotation.sourceImageId === undefined || !isValidBox(annotation.sourceImageFrame)) return null;
    const image = (scene.images || []).find((candidate) => candidate && candidate.id === annotation.sourceImageId);
    return image && isValidBox(image) ? imageTransform(image, annotation.sourceImageFrame) : null;
}

/**
 * An annotation as it is drawn, in scene pixels: a linked annotation is mapped
 * onto its image's current box; any other annotation is returned as-is.
 * Editing tools work on this and store the result with storeAnnotationGeometry.
 */
export function displayedAnnotation(annotation, scene) {
    const transform = linkedTransform(annotation, scene);
    return transform ? mapLinkedAnnotation(annotation, transform) : annotation;
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Writes the geometry of `displayed` (an edited copy of displayedAnnotation's
 * result) back into `annotation`, mapped into its own coordinates if it is
 * linked to an image, so the stored frame never changes. Keeps the
 * annotation's own format: x1/y1/x2/y2 or points, and [x, y] or { x, y } points.
 * @param {object} annotation - The stored annotation; changed in place.
 * @param {object} displayed
 * @param {{ images: object[] }} scene
 */
export function storeAnnotationGeometry(annotation, displayed, scene) {
    const transform = linkedTransform(annotation, scene);
    const scale = transform ? transform.scale : 1;
    const toStored = (point) => (transform ? transform.unmap(point) : point).map(round2);

    if (annotation.type === "text") {
        const box = textBox(displayed);
        const fontSize = box.fontSize / scale;
        const [centerX, centerY] = toStored([box.x + box.width / 2, box.y + box.height / 2]);
        annotation.fontSize = round2(fontSize);
        annotation.x = round2(centerX - box.width / scale / 2);
        annotation.y = round2(centerY - box.height / scale / 2);
        return;
    }

    const points = annotationPoints(displayed);
    if (!points) return;
    const stored = points.map(toStored);
    const hasEndpoints = [annotation.x1, annotation.y1, annotation.x2, annotation.y2].every(isNumber);
    if (hasEndpoints && stored.length === 2) {
        [[annotation.x1, annotation.y1], [annotation.x2, annotation.y2]] = stored;
    } else {
        const asObjects = Array.isArray(annotation.points) && annotation.points.length > 0 && !Array.isArray(annotation.points[0]);
        annotation.points = asObjects ? stored.map(([x, y]) => ({ x, y })) : stored;
    }
    if (isNumber(displayed.strokeWidth)) annotation.strokeWidth = round2(displayed.strokeWidth / scale);
}

function clipsToCrop(annotation) {
    return Boolean(annotation.source) && annotation.source.type === "legacy-colored-region";
}

/** The visible crop area of an image as a screen polygon, or null if uncropped. */
function visibleCropPolygon(image, transform) {
    const crop = cropRectFor(image);
    if (crop.x === 0 && crop.y === 0 && crop.width === image.width && crop.height === image.height) return null;
    return [
        [image.x + crop.x, image.y + crop.y],
        [image.x + crop.x + crop.width, image.y + crop.y],
        [image.x + crop.x + crop.width, image.y + crop.y + crop.height],
        [image.x + crop.x, image.y + crop.y + crop.height],
    ].map(transform.toScreen);
}

function renderText(annotation) {
    if (typeof annotation.text !== "string" || !isNumber(annotation.x) || !isNumber(annotation.y)) return null;
    const box = textBox(annotation);
    const node = el("text", {
        x: annotation.x,
        y: annotation.y,
        "font-size": box.fontSize,
        "font-weight": annotation.fontWeight,
        fill: annotation.color || DEFAULT_STROKE,
        "dominant-baseline": "hanging",
        class: "scene-text",
    });
    if (box.lines.length === 1) {
        node.textContent = annotation.text;
    } else {
        box.lines.forEach((line, index) => {
            const tspan = el("tspan", {
                x: annotation.x,
                y: annotation.y + index * box.fontSize * TEXT_LINE_HEIGHT,
                "dominant-baseline": "hanging",
            });
            tspan.textContent = line;
            node.appendChild(tspan);
        });
    }
    return { node, bounds: [[box.x, box.y], [box.x + box.width, box.y + box.height]] };
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
        "fill-opacity": isNumber(annotation.fillOpacity) ? annotation.fillOpacity : undefined,
        stroke: annotation.stroke || DEFAULT_STROKE,
        "stroke-width": isNumber(annotation.strokeWidth) ? annotation.strokeWidth : 1.5,
        opacity: isNumber(annotation.opacity) ? annotation.opacity : undefined,
    });
    return { node, bounds: points };
}

/**
 * An invisible, easier-to-click target over a drawn annotation: the text's
 * whole box, or a wide stroke along a line. Polygons are clickable on their fill.
 */
function renderHitArea(annotation) {
    if (annotation.type === "text") {
        const box = textBox(annotation);
        return el("rect", { x: box.x, y: box.y, width: box.width, height: box.height, class: "scene-annotation-hit" });
    }
    if (annotation.type === "line" || annotation.type === "arrow") {
        const width = isNumber(annotation.strokeWidth) ? annotation.strokeWidth : 2;
        // A <path>, not a <polyline>, so it is never mistaken for the drawn line.
        return el("path", {
            d: linePoints(annotation).map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" "),
            "stroke-width": Math.max(LINE_HIT_WIDTH, width + 8),
            class: "scene-annotation-hit scene-annotation-hit-line",
        });
    }
    return null;
}

/**
 * The selection outline and handles for a drawn annotation: a resize handle
 * on a text label's corner, or a handle on each point of a line or polygon.
 */
function renderAnnotationSelection(annotation, layer) {
    if (annotation.type === "text") {
        const box = textBox(annotation);
        layer.appendChild(el("rect", {
            class: "scene-selection-outline",
            x: box.x - 3,
            y: box.y - 3,
            width: box.width + 6,
            height: box.height + 6,
            "pointer-events": "none",
        }));
        layer.appendChild(el("rect", {
            class: "scene-resize-handle",
            x: box.x + box.width + 3 - RESIZE_HANDLE_SIZE / 2,
            y: box.y + box.height + 3 - RESIZE_HANDLE_SIZE / 2,
            width: RESIZE_HANDLE_SIZE,
            height: RESIZE_HANDLE_SIZE,
            "data-annotation-handle": "resize",
        }));
        return;
    }
    const points = annotationPoints(annotation);
    if (!points) return;
    layer.appendChild(el(annotation.type === "polygon" ? "polygon" : "polyline", {
        class: "scene-selection-outline",
        points: points.map((p) => p.join(",")).join(" "),
        "pointer-events": "none",
    }));
    if (points.length > MAX_POINT_HANDLES) return;
    points.forEach(([x, y], index) => {
        layer.appendChild(el("circle", {
            class: "scene-point-handle",
            cx: x,
            cy: y,
            r: POINT_HANDLE_RADIUS,
            "data-annotation-handle": "point",
            "data-point-index": index,
        }));
    });
}

/** The shape being drawn: a line or arrow being dragged, or a polygon's points so far. */
function renderDraft(draft, defs, layer) {
    const points = toPoints(draft.points);
    if (!points || points.length === 0) return;
    const group = el("g", { class: "scene-draft" });
    if (draft.type === "polygon") {
        group.appendChild(el("polyline", { points: points.map((p) => p.join(",")).join(" "), class: "scene-draft-shape" }));
        if (points.length >= 3) {
            const [first, last] = [points[0], points[points.length - 1]];
            group.appendChild(el("line", {
                x1: last[0], y1: last[1], x2: first[0], y2: first[1], class: "scene-draft-closing",
            }));
        }
        points.forEach(([x, y], index) => {
            group.appendChild(el("circle", {
                cx: x,
                cy: y,
                r: index === 0 ? POINT_HANDLE_RADIUS + 2 : POINT_HANDLE_RADIUS - 2,
                class: index === 0 ? "scene-draft-point scene-draft-start" : "scene-draft-point",
                "data-draft-start": index === 0 ? "true" : undefined,
            }));
        });
    } else if (points.length >= 2) {
        const result = renderLine({ ...draft, points }, defs);
        if (result) group.appendChild(result.node);
    }
    layer.appendChild(group);
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
 * @param {{ selectedIndex?: number, cropMode?: boolean, selectedAnnotationIndex?: number,
 *   draft?: { type: string, points: number[][] } }} [options] - cropMode
 *   shows the selected image uncropped with handles on its *draft* crop rect
 *   instead of the normal selection outline/resize handles (Issue #417).
 *   selectedAnnotationIndex outlines that annotation and adds its handles;
 *   each drawn annotation carries its index as `data-scene-annotation-index`.
 *   draft draws a shape that is still being created (Issues #431-#434).
 * @returns {{ svg: SVGSVGElement, rendered: number, unsupported: number, unlinked: number,
 *   width: number, height: number }} `unlinked` counts linked annotations whose
 *   source image is missing (drawn unchanged).
 */
export function renderScene(scene, { selectedIndex, cropMode = false, selectedAnnotationIndex, draft } = {}) {
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
    let unlinked = 0;

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
    const imagesById = new Map();
    (scene.images || []).forEach((image, index) => {
        if (image && typeof image.id === "string") imagesById.set(image.id, { image, index });
    });

    (scene.annotations || []).forEach((annotation, index) => {
        let toRender = annotation;
        let clipPoints = null;
        if (annotation && annotation.sourceImageId !== undefined) {
            const entry = imagesById.get(annotation.sourceImageId);
            if (entry && isValidBox(entry.image) && isValidBox(annotation.sourceImageFrame)) {
                const transform = imageTransform(entry.image, annotation.sourceImageFrame);
                toRender = mapLinkedAnnotation(annotation, transform);
                const isEditingCrop = cropMode && entry.index === selectedIndex;
                if (clipsToCrop(annotation) && !isEditingCrop) clipPoints = visibleCropPolygon(entry.image, transform);
            } else {
                unlinked += 1;
            }
        }
        const result = annotation ? renderAnnotation(toRender, defs) : null;
        if (result && clipPoints) {
            markerCount += 1;
            const clipId = `scene-annotation-clip-${markerCount}`;
            const clipPath = el("clipPath", { id: clipId });
            clipPath.appendChild(el("polygon", { points: clipPoints.map((p) => p.join(",")).join(" ") }));
            defs.appendChild(clipPath);
            const group = el("g", { "clip-path": `url(#${clipId})` });
            group.appendChild(result.node);
            result.node = group;
        }
        if (!place(result, annotationLayer)) return;
        result.node.setAttribute("data-scene-annotation-index", index);
        const hitArea = renderHitArea(toRender);
        if (hitArea) {
            hitArea.setAttribute("data-scene-annotation-index", index);
            annotationLayer.appendChild(hitArea);
        }
        if (index === selectedAnnotationIndex) renderAnnotationSelection(toRender, selectionLayer);
    });
    if (draft) renderDraft(draft, defs, selectionLayer);

    const x = minX < 0 ? minX - PADDING : 0;
    const y = minY < 0 ? minY - PADDING : 0;
    const width = maxX - x + (maxX > MIN_WIDTH ? PADDING : 0);
    const height = maxY - y + (maxY > MIN_HEIGHT ? PADDING : 0);
    svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);

    return { svg, rendered, unsupported, unlinked, width, height };
}
