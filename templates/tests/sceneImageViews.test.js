// The view a scene image is meant to show (Issue #536, R2 in
// docs/rendering-validation): taken only from trusted slide captions, and
// marked as not recorded rather than guessed.
import {
    VIEW_FROM_SLIDE_CAPTION,
    VIEW_NOT_RECORDED,
    describeImageView,
    viewFromCaptions,
    withIntendedViews,
} from "../js/sceneImageViews.js";
import { imageCaptions } from "../js/imageCaptions.js";

const legacyImage = (source) => ({ id: "img", src: "/api/images/a.jpg", x: 0, y: 0, width: 10, height: 10, source: { type: "legacy-image", ...source } });

describe("Issue 536: intended view of scene images", () => {
    it("takes the view of each image from its slide caption", () => {
        expect(viewFromCaptions({ boneId: "ilium", index: 0 }))
            .toEqual({ caption: imageCaptions.ilium.image1, basis: VIEW_FROM_SLIDE_CAPTION });
        expect(viewFromCaptions({ boneId: "ilium", index: 1 }))
            .toEqual({ caption: imageCaptions.ilium.image2, basis: VIEW_FROM_SLIDE_CAPTION });
    });

    it("marks the view as not recorded instead of guessing it", () => {
        const notRecorded = { caption: null, basis: VIEW_NOT_RECORDED };

        expect(viewFromCaptions({ boneId: "ilium", index: 2 })).toEqual(notRecorded);
        expect(viewFromCaptions({ boneId: "hand", index: 0 })).toEqual(notRecorded);
        // "right" in a file name is where the image sat on the slide, not a view.
        expect(viewFromCaptions({ boneId: "hand", filename: "hand_right_image.jpg" })).toEqual(notRecorded);
        expect(viewFromCaptions({ boneId: "ilium" })).toEqual(notRecorded);
        expect(viewFromCaptions({ boneId: "ilium", index: -1 })).toEqual(notRecorded);
        expect(viewFromCaptions(undefined)).toEqual(notRecorded);
    });

    it("records the view on imported bone images only, and keeps a view already recorded", () => {
        const kept = { caption: "Left Pelvis (lateral aspect)", basis: VIEW_FROM_SLIDE_CAPTION };
        const uploaded = { id: "up", src: "data:image/png;base64,AAAA", x: 0, y: 0, width: 10, height: 10 };
        const images = [
            legacyImage({ boneId: "ilium", index: 0 }),
            legacyImage({ boneId: "hand", index: 0 }),
            legacyImage({ boneId: "ilium", index: 1, view: kept }),
            uploaded,
        ];

        expect(withIntendedViews(images)).toBe(images);
        expect(images[0].source.view).toEqual({ caption: imageCaptions.ilium.image1, basis: VIEW_FROM_SLIDE_CAPTION });
        expect(images[1].source.view).toEqual({ caption: null, basis: VIEW_NOT_RECORDED });
        expect(images[2].source.view).toBe(kept);
        expect(uploaded.source).toBeUndefined();
        expect(withIntendedViews(undefined)).toBeUndefined();
    });

    it("describes the view for the Scene Editor, saying clearly when it isn't recorded", () => {
        const [captioned, uncaptioned] = withIntendedViews([
            legacyImage({ boneId: "ilium", index: 0 }),
            legacyImage({ boneId: "hand", index: 0 }),
        ]);

        expect(describeImageView(captioned)).toBe(`View: ${imageCaptions.ilium.image1} (from the slide caption)`);
        expect(describeImageView(uncaptioned)).toBe("View: not recorded for this image. Check the source slides before relying on its side or aspect.");
        expect(describeImageView({ id: "up", src: "data:image/png;base64,AAAA" })).toBe("View: not recorded.");
        expect(describeImageView(undefined)).toBe("View: not recorded.");
    });
});
