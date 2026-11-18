# Scene rendering validation (#470)

This is for issue #470, Validate Scene Rendering. The goal is to check that scenes in the Scene Editor are drawn the way they were saved and the way the source content is meant to look. Each small rock gets its own section below. Problems that need their own fix are listed under [Defects found](#defects-found) with an R number.

How I checked:

1. **Automated checks.** `templates/tests/sceneRendering.test.js` runs the real renderer (`sceneCanvas.js`) and checks what it draws. Some checks were already covered by earlier work, and I point to those tests instead of repeating them.
2. **Manual review.** I opened representative scenes in the Scene Editor in the browser and compared them with the bone viewer. I used the same 10 items #468 used, which cover all six bonesets and items with 1, 2 and 3 images.

Zoom, pan and resizing checks wait until zoom/pan (#449, PR #519) and resizing (#450, PR #520) are merged.

## #472 Image ordering

### How order works

These rules were in the code but not written down anywhere:

| What | Order | Where it comes from |
|---|---|---|
| Images | Drawn in the order of the scene's `images` list. The first image is at the back, the last is at the front. | `renderScene` in `sceneCanvas.js` |
| Annotations | All annotations are drawn above all images, in the order of the `annotations` list. | `renderScene`: the annotation layer comes after the image layer |
| Clicking | Picks the topmost object first: annotations, then images from front to back. | `objectsAt` in `sceneCanvas.js` |
| Bring forward / Send backward | Swaps the image with its neighbor in the `images` list. | `moveSelectedImage` in `scenes.js` (#419) |
| Importing bone images | The viewer's order (the bone's description file), placed left to right. A later import is added after, so it's in front. | `buildLegacyImages` in `legacyImport.js` (#466) |
| Saving and reopening | The `images` list is saved as it is, so the order doesn't change. | `scenes.js` API (#451) |

So the position in the list does have a meaning: it is the stacking order, from back to front.

### Results

| Check | Result | Evidence |
|---|---|---|
| Images are drawn in list order, first at the back | OK | `sceneRendering.test.js` "draws images in the order of scene.images" |
| Reordering changes the drawing order | OK | `sceneRendering.test.js` "draws the new order after images are reordered"; `scenes.test.js` "brings an image forward and sends it backward" |
| Clicking picks the same image that is drawn on top | OK | `sceneRendering.test.js` "picks overlapping images in the same order they are drawn" |
| Order stays the same after saving and reopening | OK | `boneset-api/saveReload.test.js` "keeps every image's position, size, orientation, crop, and order" and "keeps a new layer order and edits after a second save and reload" (#482) |
| Imported images keep the viewer's order | OK, all 179 importable items | `boneset-api/migrationValidation.test.js` "keeps the viewer's image order" (#468) |
| Multi-image scenes reviewed by hand | OK | Imported Ilium (2), Sternum (2), Atlas (2), Hand metacarpals (2) and Femur head (3). In every one the images were drawn left to right in the viewer's order. In Femur head I dragged the middle image over the third one, used Bring forward, saved, and reloaded the page; it reopened in the new order with the same image in front. |
| A colored region stays with its image when images overlap | **No (R1)** | `sceneRendering.test.js` "documents that a back image's colored region is drawn over a front image" |

## Defects found

### R1. Annotations aren't stacked with their image

All annotations are drawn above all images. When two images overlap, a colored region, label or line that belongs to the back image is drawn on top of the front image, so it looks like it's on the wrong bone. Clicking there also selects the back image's annotation instead of the front image. This only happens when images overlap. Imported bones are placed side by side, so it doesn't come up unless someone moves images on top of each other.

Possible fix: draw each image's linked annotations right after that image, so they go up and down with it. Unlinked annotations (drawn by hand, not imported) would stay on top. This changes how clicking and selection work, so it should be its own issue.
