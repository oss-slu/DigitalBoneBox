# Scene Editor release testing

Results for the test small rocks of #477: #478 (image importing), #479 (image manipulation), #481 (overlapping objects) and #483 (touch and responsive editing). #480 (annotation tools) is tracked separately.

Each issue has an automated test file, and each was also checked by hand in a real browser. The automated tests share a harness that loads the real page and `scenes.js` against an in-memory scene store (`templates/tests/helpers/sceneEditorHarness.js`).

| Issue | Automated tests | Result |
|---|---|---|
| #478 Test image importing | `templates/tests/sceneImageImporting.test.js` (20 tests) | Passes. Found and fixed B1. |
| #479 Test image manipulation | `templates/tests/sceneImageManipulation.test.js` (21 tests) | Passes. Found B2 (#547). |
| #481 Test overlapping objects | `templates/tests/sceneOverlappingObjects.test.js` (24 tests) | Passes. Noted O1. |
| #483 Test touch and responsive editing | `templates/tests/sceneTouchResponsive.test.js` (16 tests) | Passes. Noted O2; stylus limits below. |

## Browser and devices

| | |
|---|---|
| Browser | Chromium 156 (the Claude desktop app's browser pane), macOS (Darwin 25.6) |
| Desktop | 1024 × 768 viewport, device pixel ratio 2, mouse. Canvas 850 px wide at 100%. |
| Tablet | 768 × 1024 viewport (size only, no touch emulation). Canvas 686 px wide. |
| Phone | 375 × 812 viewport with phone emulation: Android user agent, 5 touch points, `pointer: coarse`. Canvas 303 px wide. |
| Server | Local `npm start --prefix boneset-api`, file scene store. Test scenes were deleted afterwards. |

Mouse input was real clicks and drags. Touch and pen input was sent as `PointerEvent`s with `pointerType` "touch" or "pen" through the page's real layout, because the browser pane's own clicks arrive as mouse events. No physical touch screen or stylus was used; see [Not covered](#not-covered).

## #478 Image importing

| Check | Result | Evidence |
|---|---|---|
| PNG, JPEG, GIF, WebP and SVG files import into the open scene | OK | By hand: real files of each type made in the page. `sceneImageImporting.test.js` "imports %s into the open scene…" |
| Several files chosen at once all import | **Fixed (B1)** | By hand before and after the fix. "imports every file chosen at once" |
| Unsupported types (PDF, BMP, TIFF, HEIC, no type) are refused with a clear message, nothing added | OK | By hand: "1 file skipped: notes.pdf (unsupported type)." "explains that %s is not supported…" |
| A file that can't be read, or is not really an image, is refused | OK | By hand: a text file named `fake.png`. "explains a file that can't be read…" |
| Large files: exactly 2 MB is accepted, 2 MB + 1 byte is refused before reading | OK | By hand with padded real PNGs; the 2 MB image saved. "accepts a file of exactly 2 MB…" |
| A file that would take the scene over its total image size is refused; smaller ones still import | OK | By hand: a second 2 MB file was refused with "scene is near its image size limit". "skips a file that would take the scene over…" |
| Large images are scaled down to fit 320 units with their proportions; small ones are not scaled up | OK | By hand: 400×200 → 320×160, 300×500 → 192×320. "scales a large image down…" |
| Duplicate files become separate images with their own ids, offset so they don't hide each other | OK | By hand: same PNG imported twice. "adds the same file again…", "edits one copy…" |
| Imported images land in the scene that is open, are kept after saving and reloading, and other scenes are unchanged | OK | By hand: 7 images saved, page reloaded, all 7 back; other scenes' counts unchanged. "adds images only to the scene that is open…" |
| Importing a bone's images (Import bone images) lands them in the open scene, below what is there | OK | By hand: Metacarpals added 2 images and 31 annotations on a new row. |

## #479 Image manipulation

| Check | Result | Evidence |
|---|---|---|
| Move (drag and arrow keys), resize, rotate, flip, crop, reorder and remove each change only the selected image | OK | By hand on a three-image scene, comparing every image before and after. `sceneImageManipulation.test.js` "each operation changes only the selected image" |
| Every operation is kept after saving and reopening, on single- and multi-image scenes | OK | By hand: all edits saved, page reloaded, every image identical. "complete workflows" |
| Resizing keeps proportions and stops at 10 units on the short side | OK | By hand: 200×140 → 14.3×10. "stops shrinking an image at 10…" |
| An image moved past the scene's edge stays on the canvas, which grows to show it | OK | By hand: moved to x = −79; the canvas started at −119. "lets an image go past the top-left edge…" |
| Crop stops at 10 units, stays inside the image, and can be reset to the whole image | OK | By hand on a rotated, flipped image. "stops a crop at 10…", "keeps the whole image for later…" |
| Rotation wraps (four 90° turns back to 0, −15° from 0 is 345°) | OK | "turns a full circle back to 0…" |
| Bring forward / Send backward are disabled at the ends of the stack | OK | By hand. "can't move the back image further back…" |
| The current flip state is visible | **No (B2, #547)** | By hand: see B2. |

## #481 Overlapping objects

| Check | Result | Evidence |
|---|---|---|
| Every object in a stack of five (label, line, highlight, two images) can be selected on purpose | OK | By hand: clicking the same spot selected label, highlight, image, image, then wrapped. `sceneOverlappingObjects.test.js`: clicking again, Alt+click, Tab and Shift+Tab |
| The selected object is clearly marked | OK | By hand: one outline, on the selected object's own bounds; the matching toolbar; a hint saying how many objects overlap. "the selected object is clearly marked" |
| Editing one overlapping object leaves the others unchanged | OK | By hand: nudged the label, the highlight and an image in turn; only that object changed. "editing one overlapping object leaves the others alone" (move, drag through the stack, rotate, flip, retype, delete) |
| Object list | No list | The editor has no layer or object list. Tab and Shift+Tab step through every object from the top of the stack down, which is the keyboard way to reach each one. |

## #483 Touch and responsive editing

| Check | Result | Evidence |
|---|---|---|
| The core workflow succeeds with a mouse | OK | By hand on desktop. `sceneTouchResponsive.test.js` workflow at three sizes |
| The core workflow succeeds with touch | OK | In the browser at tablet and phone size: a finger drag of 20 px moved the image 63.37 units, exactly 20 × the 3.168 units per pixel. Workflow test at three sizes |
| Pen | OK as emulated | Same workflow with `pointerType: "pen"`. The pen-only behavior (eraser, barrel button, palm rejection) is covered by the #448 tests. See [Not covered](#not-covered). |
| Touch handles stay big enough to hit | OK | Phone: 32 px handles. "keeps handles at least 32 px across…" |
| Zooming, panning and resizing don't move objects out of line or change the scene | OK | By hand: zoomed to 195%, panned by touch, zoomed out, resized phone → tablet → desktop. The 31 imported Metacarpals labels stayed within 0.1% of the image size of where they were, and the scene stayed "Saved". "draws exactly the same scene at every zoom…", "moves linked annotations with their image the same way…" |
| No sideways scrolling and no buttons cut off on the phone | OK | By hand at 375 px. |

## Defects found

### B1. Choosing several images at once imported only the first one

**Fixed in #478.** Choosing several files in Import image… added only the first file, with no message about the rest. The change handler resets the file input so the same file can be chosen again, and in Chromium that empties the same `FileList` the import was still reading. The import now copies the list before reading it (`handleImportFiles` in `scenes.js`). The tests' file picker empties its list the same way, so the test fails without the fix.

### B2. The flip state isn't shown (#547)

**Open: #547.** #416 asks that the current flip state be apparent. The Flip horizontal and Flip vertical buttons look the same whether the image is flipped or not, they have no `aria-pressed`, and flipping isn't announced. For a nearly symmetric bone, the picture alone doesn't show it. Possible fix: set `aria-pressed` and a pressed style on each flip button from the selected image's `flipX` and `flipY`, and announce the change. The rotation angle isn't shown either.

### Notes

- **O1.** The status says, for example, "Selected highlight, 3 of 5 objects. 4 objects overlap here." "3 of 5" is the position in Tab order across the whole scene, and "4" is the stack under the pointer, so the two numbers can read as a contradiction.
- **O2.** On a phone at 100%, a 300 × 200 image is about 95 × 63 px, and each 32 px touch handle covers the outer 16 px of a corner, so a drag that starts near a corner resizes instead of moving. That is the handles working as designed; zooming in, or pressing nearer the middle, moves the image.
- **O3.** A 1 × 1 image imports at 1 × 1 scene units, which is very hard to click. Resizing has a 10-unit minimum, but importing doesn't.

## Not covered

- A physical touch screen, tablet and stylus. Touch and pen were emulated in Chromium, so pressure, hover, palm rejection by the operating system, and Safari on iPad and iPhone are not verified. Before release, someone with an iPad and Apple Pencil, or an Android tablet with a stylus, should run the core workflow once.
- Firefox and Safari.
- The tablet size was tested without touch emulation; touch was emulated at phone size and in the automated tests.
