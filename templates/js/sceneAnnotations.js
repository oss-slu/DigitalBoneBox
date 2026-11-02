// Annotation editing for the Scene Editor (Issue #426: #427-#438).
//
// Every function here works on an annotation's *displayed* geometry - scene
// pixels, as sceneCanvas.js draws it (see displayedAnnotation) - and returns a
// new object without changing the one it was given. The editor stores the
// result with storeAnnotationGeometry, which maps it back into the
// annotation's own coordinates if it is linked to an image. All annotation
// tools therefore share the scene's one coordinate system.

import { annotationPoints, textBox } from "./sceneCanvas.js";

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 200;
export const MIN_STROKE_WIDTH = 1;
export const MAX_STROKE_WIDTH = 20;
// The most opaque a highlight can be, so the bone and any labels under it stay visible.
export const MIN_HIGHLIGHT_OPACITY = 0.1;
export const MAX_HIGHLIGHT_OPACITY = 0.8;

export const DEFAULT_TEXT_COLOR = "#003366";
export const DEFAULT_LINE_COLOR = "#003366";
export const DEFAULT_HIGHLIGHT_COLOR = "#ffd700";
export const DEFAULT_HIGHLIGHT_OPACITY = 0.35;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The same annotation with its points replaced, in the format it already uses. */
function withPoints(annotation, points) {
    const hasEndpoints = ["x1", "y1", "x2", "y2"].every((key) => typeof annotation[key] === "number");
    if (hasEndpoints && points.length === 2) {
        const [[x1, y1], [x2, y2]] = points;
        return { ...annotation, x1, y1, x2, y2 };
    }
    return { ...annotation, points };
}

/** The annotation moved by (dx, dy). */
export function translateAnnotation(annotation, dx, dy) {
    if (annotation.type === "text") return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
    const points = annotationPoints(annotation);
    if (!points) return annotation;
    return withPoints(annotation, points.map(([x, y]) => [x + dx, y + dy]));
}

/** The annotation with one of its points (a line endpoint or polygon corner) moved by (dx, dy). */
export function moveAnnotationPoint(annotation, index, dx, dy) {
    const points = annotationPoints(annotation);
    if (!points || index < 0 || index >= points.length) return annotation;
    return withPoints(annotation, points.map(([x, y], i) => (i === index ? [x + dx, y + dy] : [x, y])));
}

/** A text label at a new font size, keeping its top-left corner where it is. */
export function resizeText(annotation, fontSize) {
    return { ...annotation, fontSize: clamp(fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE) };
}

export function clampStrokeWidth(width) {
    return clamp(width, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH);
}

export function clampHighlightOpacity(opacity) {
    return clamp(opacity, MIN_HIGHLIGHT_OPACITY, MAX_HIGHLIGHT_OPACITY);
}

/**
 * Where a pointer line should meet a label: the point on the label's box
 * closest to `toward`. From inside the box, the middle of the nearest edge.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {[number, number]} toward
 * @returns {[number, number]}
 */
export function anchorOnBox(box, toward) {
    const [tx, ty] = toward;
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    const inside = tx > box.x && tx < right && ty > box.y && ty < bottom;
    if (!inside) return [clamp(tx, box.x, right), clamp(ty, box.y, bottom)];
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const edges = [
        { distance: tx - box.x, point: [box.x, centerY] },
        { distance: right - tx, point: [right, centerY] },
        { distance: ty - box.y, point: [centerX, box.y] },
        { distance: bottom - ty, point: [centerX, bottom] },
    ];
    return edges.reduce((best, edge) => (edge.distance < best.distance ? edge : best)).point;
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
 * A displayed pointer line with its label end moved back onto the label's
 * edge, after the label changed size or text.
 */
export function reanchorPointerLine(line, label) {
    const points = annotationPoints(line);
    if (!points || points.length < 2) return line;
    const box = textBox(label);
    const end = labelEndIndex(line, box);
    const other = end === 0 ? points[1] : points[points.length - 2];
    const [x, y] = anchorOnBox(box, other);
    return moveAnnotationPoint(line, end, x - points[end][0], y - points[end][1]);
}

/**
 * A color an `<input type="color">` can show: the value if it is #rrggbb
 * (or #rgb, expanded), otherwise the fallback.
 */
export function toColorInputValue(value, fallback) {
    if (typeof value !== "string") return fallback;
    const long = value.match(/^#([0-9a-f]{6})$/i);
    if (long) return `#${long[1].toLowerCase()}`;
    const short = value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (short) return `#${short.slice(1).map((c) => c + c).join("").toLowerCase()}`;
    return fallback;
}

/** A short name for an annotation, for the toolbar and announcements. */
export function describeAnnotation(annotation) {
    switch (annotation && annotation.type) {
        case "text":
            return "label";
        case "line":
            return typeof annotation.labelId === "string" ? "pointer line" : "line";
        case "arrow":
            return typeof annotation.labelId === "string" ? "pointer arrow" : "arrow";
        case "polygon":
            return "highlight";
        default:
            return "annotation";
    }
}
