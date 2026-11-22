# Importing PowerPoint slides into the Scene Editor

The client's anatomy slides can be imported straight from the PowerPoint file into Scene Editor scenes. Every photo, label, pointer line and highlight lands where the author placed it on the slide, and each one is an ordinary scene object that can be moved, edited or deleted. The legacy annotation JSON is not read or changed.

## How it works

```
deck.pptx
  -> data_extraction/pptx_ir.py              reads the deck; writes an intermediate record (IR):
                                              every object in slide EMU after its own and its groups'
                                              transforms, crop, flips, rotation, z-order, text with
                                              measured line breaks, connector glue, hyperlinks, media
  -> boneset-api/pptxSceneImport.js          converts one IR slide into a scene:
                                              scene px = EMU / 9525 - origin
  -> boneset-api/scripts/import-pptx-scenes.js
                                              validates each scene with validateSceneContent and saves
                                              it through the normal scene store, as a draft
```

The extractor records facts and makes no Digital Bone Box decisions, so the converter can change and rerun from the IR without reopening the deck.

What the converter does with a slide:

- **Figure area.** The opaque panel behind the photos decides what goes into the scene. Titles, navigation lists and buttons stay in the IR and are listed in the report.
- **Photos** keep their rotation, flips and crop. PowerPoint rotates a cropped photo about its visible frame and the Scene Editor about the whole image box, so the box is shifted to make the two agree.
- **Highlights** (freeforms and filled preset shapes) become polygons, curves flattened to within 0.1 px.
- **Labels** keep their text, line breaks, size, colour and alignment (`align`, `fontFamily`).
- **Pointer lines** are attached to their label (`labelId`) using the connector glue stored in PowerPoint, with geometry as the fallback. A line glued to a highlight records it in `source.gluedTo`.
- **Linking.** Labels, lines and highlights are stored in the coordinates of the photo under them (`sourceImageId`, `sourceImageFrame`), so they follow that photo when it is moved, resized, rotated or flipped.
- **Hidden shapes.** The Scene Editor draws annotations above photos. A shape fully covered by a photo on the slide is left out and reported; a partly covered one is flagged.
- **Traceability.** Scene and object ids are name-based UUIDs (version 8, SHA-256, RFC 9562) derived from the deck key and the PowerPoint slide and shape ids, so a re-import produces the same ids. Every object has a `source` (deck, slide, slide id, shape id). Uncertain objects carry `importReview: { status: "needs-review", reasons: [...] }`. The scene's `importLog` records deck and slide hashes, tool versions, counts and a content hash.

## Running an import

Requirements: Python 3.8+ with Pillow (`pip install pillow`) and Calibri or the metric-compatible Carlito installed, used to measure label line breaks; Node and the repository's npm dependencies.

Both tools use one local import folder for the IR, the extracted media and the import report. It belongs to the user and is outside the repository:

| Platform | Default import folder |
|---|---|
| Windows | `%LOCALAPPDATA%\DigitalBoneBox\imports\pptx` |
| macOS | `~/Library/Application Support/DigitalBoneBox/imports/pptx` |
| Linux | `$XDG_DATA_HOME/DigitalBoneBox/imports/pptx`, or `~/.local/share/DigitalBoneBox/imports/pptx` |

Set `DBB_PPTX_IMPORT_DIR` to use another folder (the tests do this), or pass an output folder to `pptx_ir.py` as its second argument.

PowerShell:

```powershell
python data_extraction/pptx_ir.py "$HOME\Downloads\deck.pptx" --deck-key bone-project-2
node boneset-api/scripts/import-pptx-scenes.js --ir "$env:LOCALAPPDATA\DigitalBoneBox\imports\pptx\bone-project-2.ir.json"
```

bash:

```bash
export DBB_PPTX_IMPORT_DIR="$HOME/.local/share/DigitalBoneBox/imports/pptx"   # optional; this is the Linux default
python3 data_extraction/pptx_ir.py "deck.pptx" --deck-key bone-project-2
node boneset-api/scripts/import-pptx-scenes.js --ir "$DBB_PPTX_IMPORT_DIR/bone-project-2.ir.json"
```

Scenes are saved to the scene store (see below). To try an import without touching your scenes, set `SCENES_DIR` to a scratch folder, such as `scenes` inside the import folder, for both the import and the server.

The .pptx is read only by the first command. It is never copied into the repository or uploaded.

An output folder given on the command line can be relative (`out/`) or absolute, but it must not contain `..` and must be inside the current folder, your home folder, the system temporary folder or the import folder. The extractor checks that every file it writes lands inside that folder.

| Option | Command | Effect |
|---|---|---|
| `--deck-key` | `pptx_ir.py` | The deck's permanent name. Scene ids and source identities are derived from it and each slide's PowerPoint id, so use the same key every time: a re-import then updates the same scenes, even after slides are reordered. It is also the IR file name, so it may only use letters, digits, `.`, `_` and `-`, starting with a letter or digit. |
| `--slides 2-7,9` | both | Only these slides. |
| `--dry-run` | import | Run the full preflight and report what would happen to each slide; write no scenes or images. |
| `--force` | import | Replace scenes edited since their last import (otherwise they are kept). |
| `--images-dir <folder>` | import | The images folder the API serves (default: `boneset-api/data/images`). |
| `--report <file>` | import | Where the review report goes (default: next to the IR). |

Each slide is reported as created, unchanged, updated, kept (edited since import), replaced (`--force`), rejected, or not saved because another slide was rejected. The command exits with status 1 if any slide was rejected or not saved. The report lists every flagged object and everything left out of the scene.

### Preflight, then write

The import runs in two phases.

1. **Preflight.** Every selected slide is converted and checked before anything is written: scene content (`validateSceneContent`), the scene name (`normalizeSceneName`, and no other scene or other slide in the import may use it, compared without case), the scene and source identity, each media path (inside the IR's folder, including through symlinks), each media file's SHA-256 against the IR, and that no different file already sits where a new image would be copied.
2. **Write.** Only if every slide passes are the new images copied, and then the scenes saved. Images are copied only for scenes that are being created, updated or replaced, so a scene kept because it was edited, or one that is unchanged, never adds images.

If any slide is rejected, the import makes no change to scenes or images: no scene is created or updated and no image is copied, whichever slide was rejected. The command lists every rejected slide at once, so all conflicts can be fixed before running it again. The review report is still written to the import folder (or to `--report`), so the reasons can be read.

The write phase is not a transaction. Failures that cannot be predicted, such as a full disk or a store outage, can still stop it part way:

- If copying an image fails, the images this run had copied are removed and no scene is saved.
- If saving a scene fails, the import stops. Scenes saved before it stay saved, and the remaining slides are reported as not saved. Running the same import again finishes the job, because a re-import reports saved scenes as unchanged and copies no image twice.
- Each scene is re-read under its lock just before it is saved. If it changed since the preflight, it is skipped and reported, never overwritten.

### Scene identity and re-imports

- `scene.id` is the scene's permanent record id: a UUID (version 8, SHA-256) derived from the deck key and the PowerPoint slide id. The scene name is not part of it.
- The name starts as "&lt;slide title&gt; (slide N)" and can be changed in the editor. Renaming changes neither the id nor the source identity, and a re-import keeps the new name.
- A re-import finds each scene by its id or by its source identity (the deck key and slide id in its `importLog`), which also matches scenes imported by an earlier converter version. The scene is then updated, reported unchanged, or kept if it was edited since the import. A second scene for the same slide is never created.
- A new scene whose name is already used by another scene, compared without case as the API does, is rejected, and so the whole import is stopped before writing. This happens, for example, when the same deck is imported again under a different deck key. Existing scenes found by id or source identity keep their current name, so they never clash with themselves.
- Every object keeps its `source` (deck, slide, slide id, shape id) and every scene its `importLog`, so later migration work can trace each object to the slide shape it came from.

### Where scenes are saved

The tool picks the store the same way the server does:

| Environment | Store |
|---|---|
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set | Redis (production) |
| `SCENES_DIR` set | that folder |
| neither | `boneset-api/data/scenes` in the repository, which git ignores |

### Images (transitional)

Scenes reference images by `/api/images/...`, served from `boneset-api/data/images`. This is a transitional local implementation until images move to an image-storage service:

- An image whose bytes are already in that folder, such as a legacy bone image or one imported earlier, is reused by its SHA-256 hash and not copied.
- Any other image is copied once into `boneset-api/data/images/pptx/` as `<sha256 prefix>.<ext>` and referenced as `/api/images/pptx/<file>`, even when several slides or several media file names hold the same bytes. The legacy images and the image catalog, which lists only the top level of the folder, are not changed, and git ignores the `pptx/` folder.
- Media is read only from inside the IR's folder and must match the SHA-256 recorded in the IR. An existing image file is never overwritten.

The full Bone Project 2.0 deck uses 180 images: 34 are reused from the repository and 146 (9.4 MB) are copied into `pptx/`.

### Out of scope

Publishing imported scenes into the live bone viewer, and moving images to R2 or another image-storage service, are future work. Until then, imported scenes and their images are local to the machine that ran the import. Do not run the import against the production Redis store yet: the deployed app does not have the `pptx/` images.

## Validation

| Check | Result |
|---|---|
| Pelvis deck (20 slides) | 19 scenes; 34 photos, 65 labels, 36 pointer lines, 32 highlights and outlines; 0 flagged |
| Photo corners and annotation points through `sceneCanvas.js` vs. geometry from the PowerPoint matrices | within 0.03 px (`boneset-api/pptxSceneImport.test.js`) |
| Edge alignment of each pelvis scene vs. a reference render of its slide | mean 0.08 to 0.21 px; 95th percentile at most 1.0 px |
| Label text position, 31 labels | mean 0.67 px, max 2.1 px |
| Pointer label vs. the author's connector glue | 36 of 36 agree |
| Re-import of the same deck | every scene unchanged, with the same scene and object ids; no image copied again |
| A duplicate scene name on any slide, including the last one | the import stops before writing: no scene saved, no image copied, legacy images unchanged |
| Pelvis scenes saved by the previous converter version (different ids) | found by source identity and updated in place; ids kept, no duplicates |
| Full Bone Project 2.0 deck, dry run (232 slides) | no errors; 449 photos, 1,005 labels, 612 pointer lines, 536 highlights and outlines; 75 of 2,833 objects flagged |
| Full Bone Project 2.0 deck imported twice into a scratch store | 232 scenes created, then 232 unchanged; 34 legacy images reused and 146 copied once; legacy images unchanged |

Reference renders should be exported from PowerPoint or Google Slides. LibreOffice re-routes connectors that are glued to shapes, so its renders are not a valid reference for pointer lines.

Tests:

```bash
npx jest pptxSceneImport
PPTX_IR_TEST_DECK="Bone Box (Boney Pelvis).pptx" python3 -m unittest data_extraction/test_pptx_ir.py
```

## Known gaps

- Dashed outlines are drawn solid; picture borders and text-box fills are not imported.
- A label whose lines point into two photos moves with one of them if only one photo is moved later.
- Annotations always draw above photos, while slides can interleave them.
- Highlights are polygons, so editing a curve means editing its points.
