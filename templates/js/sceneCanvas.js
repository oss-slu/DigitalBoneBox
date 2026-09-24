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
const SAFE_IMAGE_SRC = /^(\/|\.\/|https?:\/\/|data:image\/)/i;

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

function renderImage(image) {
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

    const node = el("image", {
        href: image.src,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
        preserveAspectRatio: "none",
        opacity: isNumber(image.opacity) ? image.opacity : undefined,
        transform: transforms.length ? transforms.join(" ") : undefined,
    });
    return { node, bounds: [[image.x, image.y], [image.x + image.width, image.y + image.height]] };
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
 * Renders a scene's images and annotations into an SVG element.
 * @param {{ images: object[], annotations: object[] }} scene
 * @returns {{ svg: SVGSVGElement, rendered: number, unsupported: number, width: number, height: number }}
 */
export function renderScene(scene) {
    const svg = el("svg", { class: "scene-svg", role: "img" });
    const defs = el("defs");
    const imageLayer = el("g", { class: "scene-layer-images" });
    const annotationLayer = el("g", { class: "scene-layer-annotations" });
    svg.append(defs, imageLayer, annotationLayer);

    let minX = 0;
    let minY = 0;
    let maxX = MIN_WIDTH;
    let maxY = MIN_HEIGHT;
    let rendered = 0;
    let unsupported = 0;

    const place = (result, layer) => {
        if (!result) {
            unsupported += 1;
            return;
        }
        layer.appendChild(result.node);
        rendered += 1;
        for (const [x, y] of result.bounds) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    };

    for (const image of scene.images || []) place(renderImage(image), imageLayer);
    for (const annotation of scene.annotations || []) place(renderAnnotation(annotation, defs), annotationLayer);

    const x = minX < 0 ? minX - PADDING : 0;
    const y = minY < 0 ? minY - PADDING : 0;
    const width = maxX - x + (maxX > MIN_WIDTH ? PADDING : 0);
    const height = maxY - y + (maxY > MIN_HEIGHT ? PADDING : 0);
    svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);

    return { svg, rendered, unsupported, width, height };
}
