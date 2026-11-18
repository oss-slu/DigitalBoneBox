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

## #471 Image orientation

### Intended orientation

The data only records which view an image shows for the 18 Bony Pelvis items, in `imageCaptions.js` (for example "Right Pelvis (lateral aspect)"). For the other bonesets the only clue is the file name, and "Left" or "Right" in a file name usually means where the image sat on the slide, not which side of the body it is. So I wrote down the intended view for the 20 images in the 10 sample items by looking at each one:

| Item | Image | Intended view | Where it says so | Drawn in the scene |
|---|---|---|---|---|
| Ilium | `ilium_image1.jpg` | Right pelvis, lateral aspect, iliac crest up | Caption | As the file, upright |
| Ilium | `ilium_image2.jpg` | Right pelvis, medial aspect, iliac crest up | Caption | As the file, upright |
| Iliac crest | `iliac_crest_image1.jpg` | Right pelvis, lateral aspect | Caption | As the file, upright |
| Iliac crest | `iliac_crest_image2.jpg` | Right pelvis, medial aspect | Caption | As the file, upright |
| Anterior mandible | `anterior_mandible_image.jpg` | Skull from the front, teeth up | File name and picture | As the file, upright |
| Sternum | `Sternum_Left_Image.jpg`, `Sternum_Right_Image.jpg` | Two flat views of the sternum, manubrium up. "Left"/"Right" is the slide position. | Picture | As the file, upright |
| First rib, head and neck | `First_Rib_Top_Image.jpg` | First rib, superior surface | File name | As the file |
| First rib, head and neck | `First_Rib_Bottom_Image.jpg` | First rib, inferior surface | File name | As the file |
| Atlas | `atlas_(superior_aspect)_image.png` | Atlas from above | File name | As the file |
| Atlas | `atlas_(inferior_aspect)_image.png` | Atlas from below | File name | As the file |
| Humerus | `humerus_left_image.jpg`, `humerus_right_image.jpg` | Whole humerus, head up. "Left"/"Right" is the slide position. | Picture | As the file, upright |
| Hand, metacarpals | `hand_left_image.jpg` | Hand, fingers up | Picture | As the file, upright |
| Hand, metacarpals | `hand_right_image.jpg` | Hand, fingers up | Picture | **As the file, which is turned 90° (fingers point right). See R3.** |
| Femur | `femur_image.png`, `femur_image2.png` | Whole femur, head up | Picture | As the file, upright |
| Femur, head | `femur_top_image2.png`, `femur_top_image3.png` | Upper femur, head up | File name and picture | As the file, upright |
| Femur, head | `femur_medial_aspect_image.png` | Close-up of the femoral head, medial aspect | File name | As the file |

### Results

| Check | Result | Evidence |
|---|---|---|
| Each reviewed image has a written intended orientation | OK for the 20 sample images (table above). Only Bony Pelvis has it in the data (R2). | This section |
| No image file has a hidden EXIF rotation that browsers would apply | OK, all 157 files | `boneset-api/renderingValidation.test.js` "has no image file that browsers would turn on their own" |
| Imported images are upright and not flipped | OK, all 334 imported images | `boneset-api/renderingValidation.test.js` "imports every image upright and unflipped" |
| An image with no rotation or flip is drawn exactly as the file | OK | `sceneRendering.test.js` "draws an image with no rotation or flip exactly as the file is" |
| A saved rotation or flip is drawn about the image's center, flip first | OK | `sceneRendering.test.js` "draws a saved rotation and flip about the image's center" and "flips first and then rotates" |
| Rotation and flip are kept after saving and reopening | OK | `boneset-api/saveReload.test.js` (#482) |
| The scene matches the viewer | OK, except the viewer's tilt (D4 in #468) | Both use the same image files. I compared Hand, metacarpals in the browser: the viewer draws both images with no transform, so `hand_right_image.jpg` is on its side there too. I reviewed Ilium, Sternum, Atlas and Femur head in the Scene Editor against the table above. |
| Incorrect orientations recorded | 1 found (R3) | Defects below |

**The viewer's tilt (D4 from #468).** For two-image items without colored regions (Sternum, Humerus, Femur) the viewer tilts the images −18° and 3.5°. That's a layout style, not the bone's orientation, so I think scenes should keep the images upright. If the team wants the tilt in scenes too, the import can set `rotation` on those images.

## Defects found

### R1. Annotations aren't stacked with their image

All annotations are drawn above all images. When two images overlap, a colored region, label or line that belongs to the back image is drawn on top of the front image, so it looks like it's on the wrong bone. Clicking there also selects the back image's annotation instead of the front image. This only happens when images overlap. Imported bones are placed side by side, so it doesn't come up unless someone moves images on top of each other.

Possible fix: draw each image's linked annotations right after that image, so they go up and down with it. Unlinked annotations (drawn by hand, not imported) would stay on top. This changes how clicking and selection work, so it should be its own issue.

### R2. The intended view of an image isn't recorded for most bonesets

Only the 18 Bony Pelvis items say which view each image shows (`imageCaptions.js`). For Skull, Thorax, Vertebrae, Upper Limb and Lower Limb, the view is only in some file names, and "Left"/"Right" in a file name usually means the slide position. Imported scene images don't keep the caption either, so someone editing a scene can't see which view an image is meant to be.

Possible fix: add captions (side and aspect) for the other bonesets from the PowerPoint, and copy the caption into `source` when an image is imported so the Scene Editor can show it.

### R3. `hand_right_image.jpg` is turned on its side

The second hand image (used by Hand, metacarpals and the other hand items that list it) has the fingers pointing right, while the first one has them pointing up. The viewer and the scene both show the file as it is, so they match each other, but one of the two images is not in the usual anatomical position. Someone who knows the source slides should say whether that is how the slide showed it. If not, the file should be turned 90° counterclockwise; the scene import doesn't need to change.
