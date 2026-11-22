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

```bash
python3 data_extraction/pptx_ir.py "deck.pptx" out/ --deck-key bone-project-2
SCENES_DIR=/tmp/scenes node boneset-api/scripts/import-pptx-scenes.js --ir out/bone-project-2.ir.json
```

PowerShell:

```powershell
python data_extraction/pptx_ir.py "$HOME\Downloads\deck.pptx" "$HOME\dbb-import\ir" --deck-key bone-project-2
$env:SCENES_DIR = "$HOME\dbb-import\scenes"
node boneset-api/scripts/import-pptx-scenes.js --ir "$HOME\dbb-import\ir\bone-project-2.ir.json"
```

The .pptx is read only by the first command. It is never copied into the repository or uploaded.

The output folder can be relative (`out/`) or absolute, but it must not contain `..` and must be inside the current folder, your home folder or the system temporary folder. The extractor checks that every file it writes lands inside that folder.

| Option | Command | Effect |
|---|---|---|
| `--deck-key` | `pptx_ir.py` | The deck's permanent name. Scene ids are derived from it and each slide's PowerPoint id, so use the same key every time: a re-import then updates the same scenes, even after slides are reordered. A new key creates new scenes. It is also the IR file name, so it may only use letters, digits, `.`, `_` and `-`, starting with a letter or digit. |
| `--slides 2-7,9` | both | Only these slides. |
| `--dry-run` | import | Convert and validate; save nothing. |
| `--force` | import | Replace scenes edited since their last import (otherwise they are kept). |
| `--report <file>` | import | Where the review report goes (default: next to the IR). |

Each slide is reported as created, unchanged, updated, or kept (edited since import). The report lists every flagged object and everything left out of the scene.

### Where scenes are saved

The tool picks the store the same way the server does:

| Environment | Store |
|---|---|
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set | Redis (production) |
| `SCENES_DIR` set | that folder |
| neither | `boneset-api/data/scenes` in the repository, which git tracks |

### Images and production

Scenes load images from `/api/images/<file>`, served from `boneset-api/data/images`. The tool reuses byte-identical images already there and copies new ones in as `pptx_<sha256 prefix>.<ext>`. On Vercel the images come from the repository, so new images must be committed and deployed before production scenes can show them:

1. Import locally with `SCENES_DIR`, review the scenes, commit the new images.
2. Deploy.
3. Run the same import with the Redis variables set. Scene ids and image names are the same, so nothing is duplicated.

The full Bone Project 2.0 deck uses 180 images: 34 are already in the repository and 146 (9.4 MB) are new.

## Validation

| Check | Result |
|---|---|
| Pelvis deck (20 slides) | 19 scenes; 34 photos, 65 labels, 36 pointer lines, 32 highlights and outlines; 0 flagged |
| Photo corners and annotation points through `sceneCanvas.js` vs. geometry from the PowerPoint matrices | within 0.03 px (`boneset-api/pptxSceneImport.test.js`) |
| Edge alignment of each pelvis scene vs. a reference render of its slide | mean 0.08 to 0.21 px; 95th percentile at most 1.0 px |
| Label text position, 31 labels | mean 0.67 px, max 2.1 px |
| Pointer label vs. the author's connector glue | 36 of 36 agree |
| Re-import of the same deck | every scene unchanged |
| Full Bone Project 2.0 deck, dry run (232 slides) | no errors; 449 photos, 1,005 labels, 612 pointer lines, 536 highlights and outlines; 75 of 2,833 objects flagged |

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
