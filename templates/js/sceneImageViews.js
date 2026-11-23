// Issue #536 (R2 in docs/rendering-validation): which anatomical view a scene
// image is meant to show (for example "Right Pelvis (lateral aspect)").
//
// The view is stored on the image as `source.view`:
//   { caption: "Right Pelvis (lateral aspect)", basis: "slide-caption" }
//   { caption: null, basis: "not-recorded" }
// Only trusted metadata is used: the captions taken from the PowerPoint slides
// in imageCaptions.js. The view is never guessed from a file name, since
// "left" and "right" in a file name usually mean where the image sat on the
// slide, not which side of the body it shows.
import { imageCaptions } from "./imageCaptions.js";

export const VIEW_FROM_SLIDE_CAPTION = "slide-caption";
export const VIEW_NOT_RECORDED = "not-recorded";

/**
 * The view recorded for an imported bone image, from its slide caption, or a
 * view marked as not recorded when there is no caption for it.
 * @param {{ boneId?: string, index?: number }} source the image's `source`
 * @returns {{ caption: string|null, basis: string }}
 */
export function viewFromCaptions(source) {
    const captions = source && imageCaptions[source.boneId];
    const index = source ? source.index : undefined;
    const caption = captions && Number.isInteger(index) && index >= 0 ? captions[`image${index + 1}`] : null;
    if (typeof caption === "string" && caption.trim() !== "") {
        return { caption: caption.trim(), basis: VIEW_FROM_SLIDE_CAPTION };
    }
    return { caption: null, basis: VIEW_NOT_RECORDED };
}

/**
 * Records the view on images just imported from a bone. An image that already
 * has a view (for example one copied from another scene) keeps it.
 * @param {object[]} images
 * @returns {object[]} the same images
 */
export function withIntendedViews(images) {
    for (const image of images || []) {
        const source = image && image.source;
        if (!source || source.type !== "legacy-image" || source.view) continue;
        source.view = viewFromCaptions(source);
    }
    return images;
}

/**
 * What the Scene Editor shows about an image's view.
 * @param {object} image
 * @returns {string}
 */
export function describeImageView(image) {
    const view = image && image.source && image.source.view;
    if (view && typeof view.caption === "string" && view.caption !== "") {
        return `View: ${view.caption} (from the slide caption)`;
    }
    if (image && image.source && image.source.type === "legacy-image") {
        return "View: not recorded for this image. Check the source slides before relying on its side or aspect.";
    }
    return "View: not recorded.";
}
