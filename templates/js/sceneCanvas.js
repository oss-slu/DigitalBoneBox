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
    // Flipped and rotated the same way as the image itself (Issue #473), so
    // a flipped crop is outlined where it is drawn, and each handle sits on
    // the drawn position of the corner its data-corner names.
    const { toScreen } = imageTransform(image, image);

    return {
        node,
        // The visible (cropped, if applicable) region - used for the normal
        // selection outline and the canvas's auto-sizing.
        bounds: visibleCorners.map(toScreen),
        // The current crop rect regardless of skipClip - used only while
        // actively editing the crop, to draw its own handles/outline.
        cropBounds: cropCorners.map(toScreen),
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
 * How far a text annotation's x sits from the left edge of its box: 0 for
 * left-aligned text (the default, and every label made before `align`
 * existed), half the width for "center", the full width for "right". Labels
 * imported from PowerPoint keep their paragraph alignment this way, so a
 * centered multi-line label stays centered on the same point at any size.
 */
function alignOffset(annotation, width) {
    if (annotation.align === "center") return width / 2;
    if (annotation.align === "right") return width;
    return 0;
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
    const width = longest * fontSize * 0.6;
    return {
        x: annotation.x - alignOffset(annotation, width),
        y: annotation.y,
        width,
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
                x: centerX + (alignOffset(annotation, box.width) - box.width / 2) * transform.scale,
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
 * Whether `line` is a pointer line for `label` (Issue #432): one created for it
 * (`labelId`), or one imported with it from the same legacy label and image.
 */
export function isPointerLineFor(line, label) {
    if (!line || !label || (line.type !== "line" && line.type !== "arrow")) return false;
    if (typeof line.labelId === "string") return line.labelId === label.id;
    const lineSource = line.source;
    const labelSource = label.source;
    return Boolean(lineSource && labelSource) &&
        lineSource.type === "legacy-pointer-line" &&
        labelSource.type === "legacy-label" &&
        lineSource.boneId === labelSource.boneId &&
        lineSource.annotationId === labelSource.annotationId &&
        line.sourceImageId === label.sourceImageId;
}

/**
 * Which end of a displayed pointer line sits at its label: the first point of
 * a line created for the label, otherwise whichever end is nearer the label.
 * @returns {number} The point index.
 */
export function labelEndIndex(line, labelBox) {
    const points = annotationPoints(line);
    if (!points) return -1;
    const last = points.length - 1;
    if (typeof line.labelId === "string") return 0;
    const centerX = labelBox.x + labelBox.width / 2;
    const centerY = labelBox.y + labelBox.height / 2;
    const distance = ([x, y]) => Math.hypot(x - centerX, y - centerY);
    return distance(points[0]) <= distance(points[last]) ? 0 : last;
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

// Issue #538: how far, in the label's own (source image) pixels, a pointer
// line's label end can be from the label's box and still count as touching it.
const POINTER_TOUCH_TOLERANCE = 2;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function distanceToBox([x, y], box) {
    return Math.hypot(Math.max(box.x - x, 0, x - box.x - box.width), Math.max(box.y - y, 0, y - box.y - box.height));
}

const sameFrame = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Issue #538 (R4 in docs/rendering-validation): a linked label is drawn
 * upright so it stays readable, but its pointer lines turn with the image, so
 * on a rotated image a line that touched the label comes away from it. This
 * is how far to move the drawn label, `shown`, so that the label end of every
 * pointer line that touches the label in its own coordinates still lands on
 * the drawn label's box. The move is the smallest one that does it, so a label
 * whose lines already land on it (no rotation, or only a flip) doesn't move.
 * If no one position can reach every line, the earlier lines win.
 * @returns {[number, number]} The move in scene pixels.
 */
function pointerLineShift(label, shown, scene) {
    if (!scene || !Array.isArray(scene.annotations)) return [0, 0];
    const ownBox = textBox(label);
    const box = textBox(shown);
    let range = null;
    for (const line of scene.annotations) {
        if (!line || line === label || !isPointerLineFor(line, label)) continue;
        if (line.sourceImageId !== label.sourceImageId || !isValidBox(line.sourceImageFrame) ||
            !sameFrame(line.sourceImageFrame, label.sourceImageFrame)) continue;
        const points = linePoints(line);
        if (!points) continue;
        const end = points[labelEndIndex(line, ownBox)];
        if (distanceToBox(end, ownBox) > POINTER_TOUCH_TOLERANCE) continue;
        const transform = linkedTransform(line, scene);
        if (!transform) continue;
        const [x, y] = transform.map(end);
        // Where the box's top-left corner can be with (x, y) on or in the box.
        const reach = { x0: x - box.width, x1: x, y0: y - box.height, y1: y };
        if (!range) {
            range = reach;
            continue;
        }
        const both = {
            x0: Math.max(range.x0, reach.x0), x1: Math.min(range.x1, reach.x1),
            y0: Math.max(range.y0, reach.y0), y1: Math.min(range.y1, reach.y1),
        };
        if (both.x0 <= both.x1 && both.y0 <= both.y1) range = both;
    }
    if (!range) return [0, 0];
    return [clamp(box.x, range.x0, range.x1) - box.x, clamp(box.y, range.y0, range.y1) - box.y];
}

/** A linked annotation mapped onto its image, with a label kept on its pointer lines (Issue #538). */
function drawnLinkedAnnotation(annotation, transform, scene) {
    const mapped = mapLinkedAnnotation(annotation, transform);
    if (annotation.type !== "text" || mapped === annotation) return mapped;
    const [dx, dy] = pointerLineShift(annotation, mapped, scene);
    return dx || dy ? { ...mapped, x: mapped.x + dx, y: mapped.y + dy } : mapped;
}

/**
 * An annotation as it is drawn, in scene pixels: a linked annotation is mapped
 * onto its image's current box; any other annotation is returned as-is.
 * Editing tools work on this and store the result with storeAnnotationGeometry.
 */
export function displayedAnnotation(annotation, scene) {
    const transform = linkedTransform(annotation, scene);
    return transform ? drawnLinkedAnnotation(annotation, transform, scene) : annotation;
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
        // Issue #538: `displayed` includes any move that keeps the label on its
        // pointer lines. That move is worked out again every time the label is
        // drawn, so it is taken off here instead of being stored.
        const [shiftX, shiftY] = transform
            ? pointerLineShift(annotation, mapLinkedAnnotation(annotation, transform), scene)
            : [0, 0];
        const box = textBox({ ...displayed, x: displayed.x - shiftX, y: displayed.y - shiftY });
        const fontSize = box.fontSize / scale;
        const [centerX, centerY] = toStored([box.x + box.width / 2, box.y + box.height / 2]);
        annotation.fontSize = round2(fontSize);
        const storedWidth = box.width / scale;
        annotation.x = round2(centerX + alignOffset(annotation, storedWidth) - storedWidth / 2);
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
    // Issue #475: centered in its box. The box width is an estimate (0.6em
    // per character) and real text is usually narrower, so drawing from the
    // left edge put every label left of where it belongs; an imported label
    // is placed by the center of its original box, as the viewer shows it.
    // A right-aligned label (align: "right", from PowerPoint) is the one
    // exception: its right edge is exact, so it is drawn from there.
    const right = annotation.align === "right";
    const anchorX = right ? box.x + box.width : box.x + box.width / 2;
    const node = el("text", {
        x: anchorX,
        y: annotation.y,
        "text-anchor": right ? "end" : "middle",
        "font-size": box.fontSize,
        "font-weight": annotation.fontWeight,
        "font-family": typeof annotation.fontFamily === "string" ? annotation.fontFamily : undefined,
        fill: annotation.color || DEFAULT_STROKE,
        "dominant-baseline": "hanging",
        class: "scene-text",
    });
    if (box.lines.length === 1) {
        node.textContent = annotation.text;
    } else {
        box.lines.forEach((line, index) => {
            const tspan = el("tspan", {
                x: anchorX,
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

// Issue #441: finding every object under a point, so overlapping objects can
// be reached and not only the one drawn on top. This repeats the browser's
// hit testing in scene geometry, matching what renderScene draws and what
// its hit areas make clickable.

/** Whether a point is inside a polygon (even-odd rule). */
function pointInPolygon([px, py], points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a point is within `tolerance` of a polyline (or a closed polygon's outline). */
function isNearPolyline(point, points, tolerance, closed = false) {
    const segments = closed ? points.length : points.length - 1;
    for (let i = 0; i < segments; i += 1) {
        if (distanceToSegment(point, points[i], points[(i + 1) % points.length]) <= tolerance) return true;
    }
    return false;
}

/** The visible (cropped) area of an image as drawn - flipped and rotated - or null if it isn't drawn. */
function imageHitArea(image) {
    if (!image || typeof image.src !== "string" || !SAFE_IMAGE_SRC.test(image.src)) return null;
    if (!isValidBox(image)) return null;
    const crop = cropRectFor(image);
    const corners = [
        [image.x + crop.x, image.y + crop.y],
        [image.x + crop.x + crop.width, image.y + crop.y],
        [image.x + crop.x + crop.width, image.y + crop.y + crop.height],
        [image.x + crop.x, image.y + crop.y + crop.height],
    ];
    return corners.map(imageTransform(image, image).toScreen);
}

/** Whether a drawn annotation (displayed geometry) covers a point. */
function annotationHit(annotation, point) {
    switch (annotation.type) {
        case "text": {
            if (typeof annotation.text !== "string" || !isNumber(annotation.x) || !isNumber(annotation.y)) return false;
            const box = textBox(annotation);
            const [x, y] = point;
            return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
        }
        case "line":
        case "arrow": {
            const points = linePoints(annotation);
            const width = isNumber(annotation.strokeWidth) ? annotation.strokeWidth : 2;
            return Boolean(points) && isNearPolyline(point, points, Math.max(LINE_HIT_WIDTH, width + 8) / 2);
        }
        case "polygon": {
            const points = toPoints(annotation.points);
            if (!points || points.length < 3) return false;
            const width = isNumber(annotation.strokeWidth) ? annotation.strokeWidth : 1.5;
            return pointInPolygon(point, points) || isNearPolyline(point, points, width / 2, true);
        }
        default:
            return false;
    }
}

/**
 * Every object drawn at a scene point, topmost first, as { kind, index }:
 * annotations (each later one before the ones under it), then images. Objects
 * the canvas can't draw are left out, and a colored region clipped to its
 * image's crop only counts inside the visible crop area.
 * @param {{ images: object[], annotations: object[] }} scene
 * @param {[number, number]} point - Scene pixels.
 * @returns {{ kind: "image" | "annotation", index: number }[]}
 */
export function objectsAt(scene, point) {
    const hits = [];
    const images = scene.images || [];
    const annotations = scene.annotations || [];
    const annotationHitAt = (index) => {
        const annotation = annotations[index];
        if (!annotation) return false;
        const transform = linkedTransform(annotation, scene);
        if (!annotationHit(transform ? drawnLinkedAnnotation(annotation, transform, scene) : annotation, point)) return false;
        if (transform && clipsToCrop(annotation)) {
            const image = images.find((candidate) => candidate && candidate.id === annotation.sourceImageId);
            const visible = visibleCropPolygon(image, transform);
            if (visible && !pointInPolygon(point, visible)) return false;
        }
        return true;
    };
    // Issue #535: the same order renderScene draws in, topmost first:
    // annotations on the top layer, then each image from front to back, with
    // the annotations stacked on it just above it.
    const { onImage, onTop } = stackAnnotations(scene);
    for (let i = onTop.length - 1; i >= 0; i -= 1) {
        if (annotationHitAt(onTop[i])) hits.push({ kind: "annotation", index: onTop[i] });
    }
    for (let index = images.length - 1; index >= 0; index -= 1) {
        const stacked = onImage[index];
        for (let i = stacked.length - 1; i >= 0; i -= 1) {
            if (annotationHitAt(stacked[i])) hits.push({ kind: "annotation", index: stacked[i] });
        }
        const area = imageHitArea(images[index]);
        if (area && pointInPolygon(point, area)) hits.push({ kind: "image", index });
    }
    return hits;
}

/**
 * Issue #535 (R1 in docs/rendering-validation): which annotations are drawn
 * with which image. An annotation linked to an image in the scene is stacked
 * just above that image, so an image in front of it covers it the way it
 * covers the image. Every other annotation (drawn by hand, or whose image was
 * removed) is drawn on the top layer, above all images, as before.
 * @returns {{ onImage: number[][], onTop: number[] }} Annotation indexes, in list order.
 */
function stackAnnotations(scene) {
    const images = scene.images || [];
    const imageIndexById = new Map();
    images.forEach((image, index) => {
        if (image && typeof image.id === "string" && isValidBox(image)) imageIndexById.set(image.id, index);
    });
    const onImage = images.map(() => []);
    const onTop = [];
    (scene.annotations || []).forEach((annotation, index) => {
        const imageIndex = annotation && isValidBox(annotation.sourceImageFrame)
            ? imageIndexById.get(annotation.sourceImageId)
            : undefined;
        if (imageIndex === undefined) onTop.push(index);
        else onImage[imageIndex].push(index);
    });
    return { onImage, onTop };
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

    // Every drawn object's node(s) and bounds, so that once the selection is
    // known, whatever overlaps it can be marked for touch-action: none (a drag
    // of the selected object can start on any object drawn over it).
    const touchTargets = [];
    let selectedBounds = null;
    const boundsBox = (points) => {
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    };

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

    const imagesById = new Map();
    (scene.images || []).forEach((image, index) => {
        if (image && typeof image.id === "string") imagesById.set(image.id, { image, index });
    });

    const stacks = stackAnnotations(scene);

    /** Draws one annotation into `layer`, with its hit area and selection. */
    function drawAnnotation(annotation, index, layer) {
        let toRender = annotation;
        let clipPoints = null;
        if (annotation && annotation.sourceImageId !== undefined) {
            const entry = imagesById.get(annotation.sourceImageId);
            if (entry && isValidBox(entry.image) && isValidBox(annotation.sourceImageFrame)) {
                const transform = imageTransform(entry.image, annotation.sourceImageFrame);
                toRender = drawnLinkedAnnotation(annotation, transform, scene);
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
        if (!place(result, layer)) return;
        result.node.setAttribute("data-scene-annotation-index", index);
        const hitArea = renderHitArea(toRender);
        if (hitArea) {
            hitArea.setAttribute("data-scene-annotation-index", index);
            layer.appendChild(hitArea);
        }
        if (result.bounds.length > 0) {
            touchTargets.push({ nodes: hitArea ? [result.node, hitArea] : [result.node], box: boundsBox(result.bounds) });
        }
        if (index === selectedAnnotationIndex) {
            result.node.classList.add("is-selected");
            if (hitArea) hitArea.classList.add("is-selected");
            if (result.bounds.length > 0) selectedBounds = boundsBox(result.bounds);
            renderAnnotationSelection(toRender, selectionLayer);
        }
    }

    (scene.images || []).forEach((image, index) => {
        const isEditingCrop = cropMode && index === selectedIndex;
        const result = place(renderImage(image, index, defs, { skipClip: isEditingCrop }), imageLayer);
        if (result && result.bounds.length > 0) {
            touchTargets.push({ nodes: [result.node], box: boundsBox(result.bounds) });
        }
        if (result && index === selectedIndex) {
            // Marks what a drag would move, so touch styles can stop the page
            // from scrolling when a finger starts on it (Issue #447).
            result.node.classList.add("is-selected");
            if (!isEditingCrop && result.bounds.length > 0) selectedBounds = boundsBox(result.bounds);
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
        // Issue #535: this image's own annotations, just above it and below
        // any image in front of it. The group has the annotation layer's class
        // so styles and lookups treat it the same way.
        if (stacks.onImage[index].length > 0) {
            const stack = el("g", { class: "scene-layer-annotations scene-image-annotations", "data-scene-image-stack": index });
            imageLayer.appendChild(stack);
            for (const annotationIndex of stacks.onImage[index]) {
                drawAnnotation(scene.annotations[annotationIndex], annotationIndex, stack);
            }
        }
    });
    // Issue #535: annotations that aren't stacked on an image, on top of everything.
    for (const index of stacks.onTop) drawAnnotation(scene.annotations[index], index, annotationLayer);
    // Issue #447: a press on the selected object drags it even through another
    // object drawn over it, so those objects need touch-action: none too, or
    // the browser may take the gesture for a scroll. Only objects whose bounds
    // overlap the selection are marked; the rest of the canvas still scrolls.
    if (selectedBounds && !cropMode) {
        const s = selectedBounds;
        for (const { nodes, box } of touchTargets) {
            if (box.x0 > s.x1 || box.x1 < s.x0 || box.y0 > s.y1 || box.y1 < s.y0) continue;
            for (const node of nodes) node.classList.add("scene-drag-through");
        }
    }
    if (draft) renderDraft(draft, defs, selectionLayer);

    const x = minX < 0 ? minX - PADDING : 0;
    const y = minY < 0 ? minY - PADDING : 0;
    const width = maxX - x + (maxX > MIN_WIDTH ? PADDING : 0);
    const height = maxY - y + (maxY > MIN_HEIGHT ? PADDING : 0);
    svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);

    return { svg, rendered, unsupported, unlinked, width, height };
}
