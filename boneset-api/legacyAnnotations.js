// boneset-api/legacyAnnotations.js
// Turns existing (legacy) labels, pointer lines, and colored regions into Scene
// Editor annotations. Issue #467 (parent #463).
//
// Positions follow the same rules the bone viewer uses, so imported annotations
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const DEFAULT_ANNOTATIONS_DIR = path.join(__dirname, "data", "annotations");

// Same slide size server.js uses to normalize label coordinates.
const SLIDE_WIDTH = 9144000;
const SLIDE_HEIGHT = 5143500;
const FULL_CROP = { normX: 0, normY: 0, normW: 1, normH: 1 };

// The viewer shows bony_pelvis colored regions when "ilium" is selected.
const COLORED_REGION_ALIASES = { ilium: "bony_pelvis" };

const CURVE_STEPS = 8; // points used to approximate each curved segment
// The viewer draws white labels on a black panel. Scene images have black backgrounds but the
// canvas around them is light, so labels and lines use a color that reads on both.
const LABEL_COLOR = "#F97316";
const LINE_COLOR = "#F97316";
const REGION_OPACITY = 0.4; // same as the viewer's DEFAULT_OPACITY
const REGION_STROKES = { C133AD: "#8B2471", FF00E6: "#B300A3" };
const DEFAULT_REGION_STROKE = "#1F5E1C";

const round = (value) => Math.round(value * 10) / 10;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

async function readJsonIfPresent(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(`${path.basename(filePath)} could not be read`);
    }
}

/**
 * The rectangle covering a set of scene images.
 */
function boundingBox(images) {
    const left = Math.min(...images.map((image) => image.x));
    const top = Math.min(...images.map((image) => image.y));
    const right = Math.max(...images.map((image) => image.x + image.width));
    const bottom = Math.max(...images.map((image) => image.y + image.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Returns a function that converts a slide position (EMU) to a scene position,
 * mapping the slide crop onto `box` the same way the viewer maps it onto its image area.
 */
function slideToScene(box, crop) {
    return (x, y) => ({
        x: box.x + ((x / SLIDE_WIDTH - crop.normX) / crop.normW) * box.width,
        y: box.y + ((y / SLIDE_HEIGHT - crop.normY) / crop.normH) * box.height,
    });
}

async function readLabelCrop(annotationsDir) {
    const template = await readJsonIfPresent(
        path.join(annotationsDir, "rotations annotations", "template_bony_pelvis.json")
    );
    const crop = template && template.normalized_geometry && template.normalized_geometry.right;
    const valid = crop && [crop.normX, crop.normY, crop.normW, crop.normH].every(isNumber) && crop.normW > 0 && crop.normH > 0;
    return valid ? crop : FULL_CROP;
}

/**
 * One font size for every label of a bone, scaled to the size of its images,
 * so labels stay readable and consistent whatever their original text box height.
 */
function labelFontSize(box) {
    return Math.min(16, Math.max(10, Math.round(box.height / 30)));
}

function convertLabels(data, boneId, toScene, fontSize, warnings) {
    const annotations = [];
    const counts = { labels: 0, lines: 0 };

    for (const label of data.text_annotations || []) {
        const labelId = label.annotation_id || "label";
        const box = label.text_box;
        const text = typeof label.text_content === "string" ? label.text_content.replace(/\s+/g, " ").trim() : "";
        if (!box || ![box.x, box.y, box.width, box.height].every(isNumber) || !text) {
            warnings.push({ item: `label ${labelId}`, reason: "Label has no text or no position" });
            continue;
        }

        // Center the text in its original box, as the viewer does.
        const topLeft = toScene(box.x, box.y);
        const bottomRight = toScene(box.x + box.width, box.y + box.height);
        const centerX = (topLeft.x + bottomRight.x) / 2;
        const centerY = (topLeft.y + bottomRight.y) / 2;
        const approxWidth = text.length * fontSize * 0.6; // same estimate sceneCanvas.js uses
        annotations.push({
            id: crypto.randomUUID(),
            type: "text",
            text,
            x: round(centerX - approxWidth / 2),
            y: round(centerY - fontSize / 2),
            fontSize,
            fontWeight: "600",
            color: LABEL_COLOR,
            source: { type: "legacy-label", boneId, annotationId: labelId },
        });
        counts.labels += 1;

        for (const line of label.pointer_lines || []) {
            const start = line && line.start_point;
            const end = line && line.end_point;
            if (!start || !end || ![start.x, start.y, end.x, end.y].every(isNumber)) {
                warnings.push({ item: `pointer line for ${text}`, reason: "Pointer line has no start or end point" });
                continue;
            }
            const from = toScene(start.x, start.y);
            const to = toScene(end.x, end.y);
            const arrowHead = line.style && line.style.arrow_head;
            annotations.push({
                id: crypto.randomUUID(),
                type: arrowHead && arrowHead !== "none" ? "arrow" : "line",
                x1: round(from.x),
                y1: round(from.y),
                x2: round(to.x),
                y2: round(to.y),
                stroke: LINE_COLOR,
                strokeWidth: 1.5,
                source: { type: "legacy-pointer-line", boneId, annotationId: labelId, lineId: line.line_id || null },
            });
            counts.lines += 1;
        }
    }
    return { annotations, counts };
}

function cubicPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return [
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
}

/**
 * Converts PowerPoint path commands into a list of [x, y] points.
 * Returns null if the path contains something that can't be converted.
 */
function pathToPoints(commands) {
    const points = [];
    let current = null;
    for (const command of commands || []) {
        switch (command.type) {
            case "moveTo":
            case "lineTo":
                if (!isNumber(command.x) || !isNumber(command.y)) return null;
                current = [command.x, command.y];
                points.push(current);
                break;
            case "cubicBezTo": {
                const values = [command.x1, command.y1, command.x2, command.y2, command.x, command.y];
                if (!current || !values.every(isNumber)) return null;
                const end = [command.x, command.y];
                for (let step = 1; step <= CURVE_STEPS; step += 1) {
                    points.push(cubicPoint(current, [command.x1, command.y1], [command.x2, command.y2], end, step / CURVE_STEPS));
                }
                current = end;
                break;
            }
            case "close":
                break;
            default:
                return null;
        }
    }
    return points;
}

/**
 * Pairs each colored region with the scene image(s) the viewer draws it on.
 */
function regionTargets(data, images, warnings) {
    const targets = [];
    let olderFormat = false;

    if (Array.isArray(data.images)) {
        olderFormat = true;
        data.images.forEach((entry, position) => {
            const index = Number.isInteger(entry.index) ? entry.index : position;
            const image = images.find((candidate) => candidate.source && candidate.source.index === index);
            for (const region of entry.colored_regions || []) {
                if (!image) {
                    warnings.push({ item: `colored region ${region.anatomical_name || ""}`.trim(), reason: "Its image wasn't imported" });
                    continue;
                }
                targets.push({ region, image, dims: { width: entry.width, height: entry.height } });
            }
        });
    } else if (Array.isArray(data.colored_regions)) {
        const dims = data.image_dimensions || {};
        for (const region of data.colored_regions) {
            for (const image of images) targets.push({ region, image, dims });
        }
    }
    return { targets, olderFormat };
}

function convertRegions(data, boneId, images, warnings) {
    const annotations = [];
    const { targets, olderFormat } = regionTargets(data, images, warnings);

    for (const { region, image, dims } of targets) {
        const name = region.anatomical_name || "colored region";
        if (!isNumber(dims.width) || !isNumber(dims.height) || dims.width <= 0 || dims.height <= 0) {
            warnings.push({ item: name, reason: "Colored region has no reference size" });
            continue;
        }
        const offsetX = isNumber(region.offset_x) ? region.offset_x : 0;
        const offsetY = isNumber(region.offset_y) ? region.offset_y : 0;
        const toScene = ([x, y]) => [
            round(image.x + ((x + offsetX) / dims.width) * image.width),
            round(image.y + ((y + offsetY) / dims.height) * image.height),
        ];
        const color = String(region.color || "008000").replace(/^#/, "").toUpperCase();

        const paths = Array.isArray(region.path_data) ? region.path_data : [region.path_data];
        for (const pathData of paths) {
            const raw = pathToPoints(pathData && pathData.commands);
            const minimum = region.stroke ? 2 : 3;
            if (!raw || raw.length < minimum) {
                warnings.push({ item: name, reason: "Colored region outline couldn't be converted" });
                continue;
            }
            const points = raw.map(toScene);
            const source = { type: "legacy-colored-region", boneId, name, imageId: image.id };

            if (region.stroke) {
                annotations.push({
                    id: crypto.randomUUID(),
                    type: "line",
                    points,
                    stroke: `#${color}`,
                    strokeWidth: round(((region.stroke_width || 38100) / dims.width) * image.width),
                    source,
                });
            } else {
                annotations.push({
                    id: crypto.randomUUID(),
                    type: "polygon",
                    points,
                    fill: `#${color}`,
                    stroke: REGION_STROKES[color] || DEFAULT_REGION_STROKE,
                    strokeWidth: 1.5,
                    opacity: REGION_OPACITY,
                    source,
                });
            }
        }
    }

    if (olderFormat && annotations.length > 0) {
        warnings.push({
            item: "colored regions",
            reason: "Older format: the viewer nudges these by hand, so positions may differ slightly",
        });
    }
    return annotations;
}

/**
 * Builds scene annotations for a bone's existing labels, pointer lines, and colored regions.
 *
 * @param {string} boneId a validated boneset, bone, or bone part id
 * @param {object[]} images the scene images just imported for this bone (from buildLegacyImages)
 * @param {object} [options]
 * @param {{ labels?: boolean, regions?: boolean }} [options.include] which kinds to import
 * @param {boolean} [options.allImagesImported] labels are placed over all of a bone's images,
 *   so they are only imported when every image was imported
 * @param {string} [options.annotationsDir]
 * @returns {Promise<{ annotations: object[], warnings: object[], counts: { labels: number, lines: number, regions: number } }>}
 */
async function buildLegacyAnnotations(boneId, images, options = {}) {
    const include = options.include || {};
    const annotationsDir = options.annotationsDir || DEFAULT_ANNOTATIONS_DIR;
    const allImagesImported = options.allImagesImported !== false;

    const annotations = [];
    const warnings = [];
    const counts = { labels: 0, lines: 0, regions: 0 };
    if (!Array.isArray(images) || images.length === 0) return { annotations, warnings, counts };

    if (include.labels) {
        try {
            const data = await readJsonIfPresent(
                path.join(annotationsDir, "text_label_annotations", `${boneId}_text_annotations.json`)
            );
            if (data && !allImagesImported) {
                warnings.push({
                    item: "labels and pointer lines",
                    reason: "Only imported together with all of the bone's images",
                });
            } else if (data) {
                const area = boundingBox(images);
                const toScene = slideToScene(area, await readLabelCrop(annotationsDir));
                const result = convertLabels(data, boneId, toScene, labelFontSize(area), warnings);
                annotations.push(...result.annotations);
                counts.labels = result.counts.labels;
                counts.lines = result.counts.lines;
            }
        } catch (error) {
            warnings.push({ item: "labels and pointer lines", reason: error.message });
        }
    }

    if (include.regions) {
        const regionFile = COLORED_REGION_ALIASES[boneId] || boneId;
        try {
            const data = await readJsonIfPresent(
                path.join(annotationsDir, "ColoredRegions", `${regionFile}_colored_regions.json`)
            );
            if (data) {
                const regions = convertRegions(data, boneId, images, warnings);
                annotations.push(...regions);
                counts.regions = regions.length;
            }
        } catch (error) {
            warnings.push({ item: "colored regions", reason: error.message });
        }
    }

    return { annotations, warnings, counts };
}

module.exports = {
    buildLegacyAnnotations,
    pathToPoints,
    slideToScene,
    boundingBox,
    SLIDE_WIDTH,
    SLIDE_HEIGHT,
};