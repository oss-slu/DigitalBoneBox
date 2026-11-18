# Scene rendering validation (#470)

This is for issue #470, Validate Scene Rendering. The goal is to check that scenes in the Scene Editor are drawn the way they were saved and the way the source content is meant to look. Each small rock gets its own section below. Small bugs I fixed on this branch have an F number. Problems that need their own fix are listed under [Defects found](#defects-found) with an R number.

How I checked:

1. **Automated checks.** `templates/tests/sceneRendering.test.js` runs the real renderer (`sceneCanvas.js`) and checks what it draws. `boneset-api/renderingValidation.test.js` checks the image files and what the import makes. Some checks were already covered by earlier work, and I point to those tests instead of repeating them.
2. **Manual review.** I used the same 10 items #468 used, which cover all six bonesets and items with 1, 2 and 3 images. I wrote down the intended view of all of their images. I imported 5 of them into scenes (Ilium, Sternum, Atlas, Hand metacarpals and Femur head) and reviewed them in the Scene Editor in the browser.

Zoom and pan (#449) and responsive resizing (#450) were merged before #474-#476, so those sections check alignment at different zoom levels, while panned, and at different window sizes.

## Summary

| #470 acceptance criterion | Result | Section |
|---|---|---|
| Image orientation and ordering are verified | Done. Found R2 and R3. | #471, #472 |
| Image rotation, scaling, and cropping are verified | Done. Fixed F1-F3. | #473 |
| Highlights, lines, and labels remain aligned | Done. Fixed F4; found R1 and R4. | #474, #475 |
| Rendering is checked across supported screen sizes | Done. Found R5. | #476 |
| Rendering defects are recorded as focused issues | R1-R5 are written up below, each with a possible fix, ready to be filed as their own issues | [Defects found](#defects-found) |

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

## #473 Image rotation, scaling, and cropping

### Results

| Check | Result | Evidence |
|---|---|---|
| A rotated image keeps its proportions (0°, 15°, 45°, 90°, 180°, 270°, −30°) | OK | `sceneRendering.test.js` "keeps an image's proportions at every rotation" |
| Resizing keeps the proportions | OK | `scenes.test.js` "resizes from a corner handle, preserving aspect ratio" (#414) |
| Imported images keep the file's proportions | OK, all 334 imported images | `boneset-api/migrationValidation.test.js` "keeps every image's proportions" (#468) |
| A crop is clipped in the image's own pixels and turns with the image | OK | `sceneRendering.test.js` "clips a cropped image to its crop area and rotates the crop with the image" |
| Resizing a cropped image keeps showing the same part of the bone | **Fixed (F1)** | `scenes.test.js` "scales the crop with the image when a cropped image is resized" |
| The outline and handles of a flipped, cropped image are on the part that's shown | **Fixed (F2)** | `sceneRendering.test.js` "outlines the part of a flipped, cropped image that is actually shown" and "outlines the draft crop where it is drawn" |
| Dragging a handle on a flipped image moves that corner | **Fixed (F3)** | `scenes.test.js` "grows a flipped image when its handle is dragged away" and "moves a flipped image's crop edge the way the handle is dragged" |
| Rotation, flip and crop are kept after saving and reopening | OK | `boneset-api/saveReload.test.js` (#482) |
| Overlapping transformed images reviewed by hand | OK, apart from R1 | In Hand metacarpals I flipped the first image, cropped it by dragging its handles, shrank it, saved and reloaded. The outline, handles and visible area matched, and the save went through. Femur head was checked with overlapping images under #472. |
| Zoomed scene sizes | OK | A rotated, flipped, resized image and a rotated, flipped, cropped one, measured at 26%, 100% and 800% zoom (see #474) |

### Fixed on this branch

**F1. Resizing a cropped image cut off a different part of the bone, and the save could fail.** The crop is stored in the image's own pixels, but resizing only changed the image's size. Shrinking a cropped image left the crop the old size, so a different part of the image showed, and the API rejected the save with "The crop area must fit within the image". Making the image bigger showed more of the bone than the crop meant to. Now the crop scales with the image (`startImageDrag` in `scenes.js`).

**F2. The outline of a flipped, cropped image was on the wrong side.** The image and its crop were drawn flipped, but the selection outline, the handles and the canvas size used the unflipped crop. For example, a crop that kept the left of a horizontally flipped image was drawn on the right, but outlined on the left. Now the outline and handles go through the same flip and rotation as the image (`renderImage` in `sceneCanvas.js`).

**F3. Handles on a flipped image moved the wrong way.** Once the handles were in the right place (F2), dragging them still used unflipped directions, so dragging a crop handle inward on a flipped image did nothing or moved the opposite edge. Drags now turn the mouse movement into the image's own axes, undoing the rotation and then the flip (`toImageAxes` in `scenes.js`).

## #474 Highlight alignment

### How I measured it in the browser

A colored region imported with an image stores its points relative to that image's box when it was imported (`sourceImageFrame`). So for every point we know which spot of the image it should be on. In the browser I ran a script that, for every region point:

1. takes where the browser actually drew the point (`getScreenCTM()` of the region), and
2. takes where the browser actually drew that spot of the image (`getScreenCTM()` of the image, which includes its rotation and flip),

and reports the largest distance between the two, in screen pixels. It uses the browser's real layout, so it covers zoom, scrolling and the window size too.

I used imported Ilium, Atlas, Hand metacarpals and Femur head scenes, plus "Ilium transformed": the Ilium images with one rotated 30°, flipped horizontally and made 1.3× bigger, and the other rotated 270°, flipped vertically, cropped and moved.

### Results

| Check | Result | Evidence |
|---|---|---|
| Regions sit on the right spot of their image, for 14 kinds of change (moved, resized, rotated 15°/90°/225°/−30°, flipped each way and both, combinations, cropped) | OK | `sceneRendering.test.js` "keeps a colored region on the same spot of its image". This reads the transform the image is drawn with and checks each region point against it, so it doesn't repeat the renderer's own math. I checked that it catches a real mistake: when I swapped the order of flipping and rotating in the region mapping, 5 of these tests failed. |
| Regions are clipped to exactly the part of a cropped image that is shown | OK | `sceneRendering.test.js` "clips a region to exactly the part of its image that is shown" |
| A region's outline gets thicker and thinner with its image | OK | `sceneRendering.test.js` "gives a region the same stroke width relative to its image at any size" |
| Zooming never changes where anything is stored or drawn in the scene | OK | `sceneAnnotationEditor.test.js` "draws images, highlights, lines and labels together, so they stay aligned and the scene is unchanged" (#449) |
| Default size in the browser (1024×768) | OK, 0 px off | 5,080 region points in the 5 scenes |
| After zooming out (26%) and in (800%) | OK, 0 px off | Ilium transformed and Atlas |
| After panning while zoomed in | OK, 0 px off | Scrolled about a third of the way across and down at 800% |
| Actual size instead of fit to width | OK, 0 px off | Ilium transformed and Atlas |
| After resizing the window with a scene open | OK, 0 px off | Hand metacarpals, resized from 768 px wide to 375 px wide without reopening it |
| After rotation | OK | Covered by the 14 kinds of change above and by Ilium transformed in the browser |

The highlights stay aligned because every image and annotation is drawn in one SVG, in scene coordinates. Zooming and resizing only change how big that SVG is drawn, and a linked region is mapped through the same move, resize, flip and rotation as its image (`imageTransform` in `sceneCanvas.js`).

This only checks that a region stays where it was imported. Whether it was imported onto the right part of the bone is a separate question: #468 found that older-format (pelvis) regions are a little off (D3), and that items with 3 or more images draw newer-format regions on every image (D5).

## #475 Line and label alignment

### Results

| Check | Result | Evidence |
|---|---|---|
| Pointer lines and arrows stay on the same spots of their image, for the same 14 kinds of change as #474 | OK | `sceneRendering.test.js` "keeps a pointer line's points on the same spots of its image" |
| Labels stay centered on the same spot of their image, upright, with their size following the image | OK | `sceneRendering.test.js` "keeps a label centered on the same spot of its image, upright and scaled with it" |
| Arrowheads sit on the line's last point and grow with the line | OK | `sceneRendering.test.js` "puts an arrow's head on the line's last point and scales it with the line" |
| Labels are drawn where they're placed | **Fixed (F4)** | `sceneRendering.test.js` "draws a label centered in its box" and "centers every line of a multi-line label" |
| Lines and labels in the browser, default size (1024×768) | OK. Lines 0 px off; labels at most 0.9 px | Lines: 90 points, labels: 43, in the 5 scenes from #474 |
| After zooming (26% to 800%), panning, and actual size | OK. Lines 0 px off; labels at most 5.1 px at 800% (0.6 scene px) | Ilium transformed and Atlas. The small label difference is the font's own top and bottom spacing, which grows with zoom; it doesn't build up. |
| After resizing the window | OK. Lines 0 px off; labels under 1 px | 768×1024 and 375×812, see #476 |
| Saved scenes reopen with the same alignment | OK | `scenes.test.js` "rotates a linked label with its image and keeps it there after saving and reopening the scene"; `boneset-api/saveReload.test.js` (#482) |
| Dense placement | Reviewed | Atlas: 41 annotations (17 labels, 20 pointer lines) on 2 images |
| Pointer lines touch their label when the image is rotated | **No (R4)** | `sceneRendering.test.js` "documents that a pointer line comes away from an upright label when the image is rotated" |

**Pointer lines vs. labels in imported scenes.** Even with upright images, most imported pointer lines don't quite reach their label's text. In each scene I measured, the typical (median) gap was between 12 and 41 scene px. This is the known label layout difference from #468 (D1): labels and lines were drawn for the viewer's panel layout, and the import maps them over the images instead. F4 didn't change these numbers, so it isn't caused by the renderer.

### Fixed on this branch

**F4. Labels were drawn too far left.** The renderer works out a label's box from an estimated width of 0.6 × the font size per character, and drew the text starting at the box's left edge. Real text is narrower than that estimate (for example, "Anterior Superior Iliac Spine" is 162 px wide, not 209), so every label was left of its box's center by half the difference, about 23 px for longer labels. The import places each label by the center of its original box, the way the viewer shows it, so imported labels were off by that much. In the browser, labels were up to 28 scene px from where they belong (35 on the enlarged image). Now labels are drawn centered in their box (`text-anchor="middle"` in `renderText`) and land within 1 px. The box used for selecting and dragging didn't change.

## #476 Rendering across screen sizes

### How I checked

I opened the same 5 scenes from #474 (Ilium, Ilium transformed, Atlas, Hand metacarpals and Femur head) at each size, at the default view (100%, fit to width), and ran the same alignment measurement. The page was reloaded at each size so it started fresh, and at phone size it ran as a phone: mobile user agent and touch input. I also checked that the page never scrolls sideways and how big the smallest label ends up on screen.

All runs were in the Claude desktop app's built-in browser (Chromium, Chrome 156). I didn't test Safari, Firefox, or a real phone or tablet.

### Results

| Device | Viewport | Input | Canvas width | Regions | Lines | Labels | Page scrolls sideways | Smallest label on screen |
|---|---|---|---|---|---|---|---|---|
| Desktop | 1440×900 | Mouse | 986 px | 0 px off | 0 px off | ≤ 1.4 px off | No | 9 px (Atlas) |
| Small laptop | 1024×768 | Mouse | 554 px | 0 px off | 0 px off | ≤ 0.9 px off | No | 5 px (Atlas) |
| Tablet, portrait | 768×1024 | Mouse | 686 px | 0 px off | 0 px off | ≤ 1.0 px off | No | 6.5 px (Atlas) |
| Phone, portrait | 375×812 | Touch, mobile | 303 px | 0 px off | 0 px off | ≤ 0.5 px off | No | 2.5 px (Atlas) |
| Phone, portrait, zoomed to 305% | 375×812 | Touch, mobile | 303 px, panned | 0 px off | 0 px off | ≤ 0.7 px off | No | 8.5 px (Atlas) |
| Phone, landscape | 812×375 | Mouse | 656 px | 0 px off | 0 px off | ≤ 1.1 px off | No | 6 px (Atlas) |
| Phone turned from portrait to landscape with a scene open | 375×812 to 812×375 | Touch, mobile | 656 px | 0 px off | 0 px off | ≤ 1.5 px off | No | Not measured |

"Labels" is the distance between the center of the real label text and where it belongs. The rest is the font's own spacing (see #475).

| Check | Result |
|---|---|
| Scenes render correctly on desktop layouts | OK |
| Scenes render correctly on tablet layouts | OK. The controls wrap onto more rows and the canvas uses the full width. |
| Scenes render correctly on phone layouts | Alignment is OK, but labels are too small to read until you zoom in (R5) |
| No supported layout causes systematic annotation displacement | OK. Nothing was more than 1.5 screen px off at any size, and the error didn't grow with screen size. |

At 1024×768 the canvas is narrower (554 px) than on the 768 px tablet (686 px), because the scene list sits beside it at that width.

## Defects found

### R1. Annotations aren't stacked with their image

All annotations are drawn above all images. When two images overlap, a colored region, label or line that belongs to the back image is drawn on top of the front image, so it looks like it's on the wrong bone. Clicking there also selects the back image's annotation instead of the front image. This only happens when images overlap. Imported bones are placed side by side, so it doesn't come up unless someone moves images on top of each other.

Possible fix: draw each image's linked annotations right after that image, so they go up and down with it. Unlinked annotations (drawn by hand, not imported) would stay on top. This changes how clicking and selection work, so it should be its own issue.

### R2. The intended view of an image isn't recorded for most bonesets

Only the 18 Bony Pelvis items say which view each image shows (`imageCaptions.js`). For Skull, Thorax, Vertebrae, Upper Limb and Lower Limb, the view is only in some file names, and "Left"/"Right" in a file name usually means the slide position. Imported scene images don't keep the caption either, so someone editing a scene can't see which view an image is meant to be.

Possible fix: add captions (side and aspect) for the other bonesets from the PowerPoint, and copy the caption into `source` when an image is imported so the Scene Editor can show it.

### R3. `hand_right_image.jpg` is turned on its side

The second hand image (used by Hand, metacarpals and the other hand items that list it) has the fingers pointing right, while the first one has them pointing up. The viewer and the scene both show the file as it is, so they match each other, but one of the two images is not in the usual anatomical position. Someone who knows the source slides should say whether that is how the slide showed it. If not, the file should be turned 90° counterclockwise; the scene import doesn't need to change.

### R4. Pointer lines come away from labels when an image is rotated

Labels are kept upright so they stay readable, while their pointer lines turn with the image. A line that touches the end of a long label lands beside the label once the image is turned. Across every imported item, 292 pointer lines touch their label when the image is upright. Rotated 45°, 193 of them come loose; rotated 90°, 241 do (half of those by 17 scene px or more, at most 86).

Possible fix: when drawing an imported label on a rotated image, move the label so the point where its line meets it stays on the line, instead of keeping the label's center in place. That changes how imported labels move, so it should be decided as its own issue.

### R5. Labels are too small to read on a phone until you zoom in

The default view fits the whole scene to the canvas width, and the scene is at least 960 scene px wide. On a 375 px phone the canvas is 303 px, so everything is drawn at about a third of its size or less. Labels end up 2.5 to 6 px tall in the reviewed scenes (Atlas is the worst, because its hidden labels make the scene wider, see #468 D2). They line up correctly, and zooming in to about 300% makes them readable (8.5 px), but nothing tells a phone user to do that. It is also a little tight on a small laptop (5 px at 1024×768).

Possible fixes: start phones at a higher zoom centered on the images, or keep labels at a minimum on-screen size.

