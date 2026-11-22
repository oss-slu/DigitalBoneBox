# Importing PowerPoint slides into the Scene Editor

The client's anatomy slides can be imported straight from the PowerPoint file into Scene Editor scenes. Every photo, label, pointer line and highlight lands where the author placed it on the slide, and each one is an ordinary scene object that can be moved, edited or deleted. The legacy annotation JSON is not read or changed.

There are two ways to run an import, and both use the same pipeline and rules:

- **From the Scene Editor**: the **Import presentation** button takes a .pptx file or a shared Google Slides link. See [Importing from the Scene Editor](#importing-from-the-scene-editor).
- **From the command line**: see [Running an import](#running-an-import).

## How it works

```
deck.pptx
  -> data_extraction/pptx_ir.py              reads the deck; writes an intermediate record (IR):
                                              every object in slide EMU after its own and its groups'
                                              transforms, crop, flips, rotation, z-order, text with
                                              measured line breaks, connector glue, hyperlinks, media
  -> boneset-api/pptxSceneImport.js          converts one IR slide into a scene:
                                              scene px = EMU / 9525 - origin
  -> boneset-api/pptxImportPipeline.js       preflights every slide (content, name, identity, media),
                                              then copies new images and saves each scene through the
                                              normal scene store, as a draft
       used by boneset-api/scripts/import-pptx-scenes.js   (command line)
       and by  boneset-api/presentationImport.js           (Scene Editor: /api/scene-imports)
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

## Importing from the Scene Editor

The Scene Editor's **Import presentation** button (next to **Back to Bone Viewer**) opens a panel that runs the same extractor and pipeline on the server, as a background job:

1. Choose **PowerPoint file (.pptx)** and pick the file, or choose **Google Slides link** and paste the link.
2. Check the **deck key**. It is suggested from the file name (or `gslides-<presentation id>` for a link). Decks imported before are offered in the list. Use the same key every time you import the same deck, so its scenes are updated instead of duplicated.
3. Optionally limit the **slides** (for example `2-7, 9`), or tick **Check only** to see what would happen without saving anything.
4. **Import**. The panel shows progress (reading, checking, copying images, saving), then a row for every slide: created, updated, unchanged, kept (edited since its last import), rejected with the reason, not saved, or no figure, with counts, what needs review and what was left out. **Open** goes to the scene.

The browser checks the file type (.pptx only, not .ppt), the size, the link, the deck key and the slide list before anything is sent. The server checks them again, then checks the presentation itself before the job starts.

Imported scenes are always drafts until someone publishes them. The panel never offers `--force`, so a scene edited since its last import is always kept. Use the command line to replace one on purpose.

### Google Slides

The server downloads Google's own .pptx export of the presentation, so the result is the same as **File > Download > Microsoft PowerPoint (.pptx)**:

- The presentation must be shared as **Anyone with the link can view**. For a private presentation, download it as .pptx in Google Slides and import the file instead.
- The download URL is built from the presentation id, never taken from the request, and redirects are only followed to Google's download hosts (`docs.google.com`, `*.googleusercontent.com`). The server needs outbound HTTPS to Google.
- A Google Slides export may number slides afresh each time it is downloaded, and slide ids are part of a scene's identity. If slides were added or reordered in Google Slides, check the results of a re-import; scenes edited since their import are kept either way.

### Who can import

The app has no user accounts, so the server decides:

| Server setting | Who can import |
|---|---|
| `SCENE_IMPORT_TOKEN` not set (default) | Only the computer the API runs on: a loopback connection, no proxy header, and a page served from `localhost` or the API's own host. |
| `SCENE_IMPORT_TOKEN=<a long random value>` | Anyone who enters that key in the panel. The browser keeps it in memory for the page only and sends it as `Authorization: Bearer <key>`. |
| Vercel | Nobody: import reports itself unavailable, because the deployment has no Python and cannot store imported images. |

Nothing the server sends to the browser contains server paths, credentials, command lines or Python output. Errors are written for the person importing, and the details go to the server log.

### Running it locally

Start the API as usual (`npm run dev`, or `npm start --prefix boneset-api`). The panel checks these prerequisites when it opens and explains anything missing:

- **Python 3.8 or newer**, run as `python3` (`python` on Windows). Set `PPTX_IMPORT_PYTHON` to use another executable.
- **Pillow and Calibri or Carlito** for measured label line breaks. Without them the import still works, but every label is flagged for review, and the panel warns about it.
- **A writable import folder and images folder.** The upload and the extracted IR go to a job folder inside the import folder (above), which is deleted when the job ends. New images go to `boneset-api/data/images/pptx/`.

Other settings, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `SCENE_IMPORT_TOKEN` | not set | Allow imports from other computers with this key (see above). |
| `PPTX_IMPORT_MAX_BYTES` | 52428800 (50 MB) | Largest presentation accepted, uploaded or downloaded. The full Bone Project 2.0 deck is 17.7 MB. |
| `PPTX_IMPORT_TIMEOUT_MS` | 600000 (10 minutes) | How long the extractor may run before it is stopped. The full deck takes about 5 seconds. |
| `PPTX_IMPORT_PYTHON` | `python3` (`python` on Windows) | The Python that runs `data_extraction/pptx_ir.py`. |
| `DBB_PPTX_IMPORT_DIR`, `PPTX_IR_FONT_DIR` | see above | The extractor's import folder and an extra font folder. |

One import runs at a time; up to five more wait in a queue, and the panel says how many are ahead. A finished import's results are kept for an hour. The API's Docker image (`boneset-api/Dockerfile`) contains neither Python nor `data_extraction/`, so in Docker the panel reports import as unavailable until the image adds them.

The API, under `/api/scene-imports`:

| Request | Purpose |
|---|---|
| `GET /api/scene-imports` | Whether import is available here, problems and warnings, access mode, size limit, decks imported before |
| `POST /api/scene-imports/pptx?deckKey=&slides=&dryRun=1` | Body: the .pptx bytes. Header `X-File-Name`: the URL-encoded file name. Responds 202 with the job |
| `POST /api/scene-imports/google-slides` | JSON `{ "source": "<link or id>", "deckKey", "slides", "dryRun" }`. Responds 202 with the job |
| `GET /api/scene-imports/jobs/<id>` | The job: `state` (queued, running, succeeded, checked, stopped, failed), `phase`, `progress`, `summary`, `warnings`, `error`, and one result per slide |

### Toward object storage

Two things in this workflow are local today, and both have a single seam to replace:

- **Imported images** are written by the image step of `boneset-api/pptxImportPipeline.js` (`indexImages`, `readMedia`, `writeImportedImage`) into `boneset-api/data/images/pptx/` and referenced as `/api/images/pptx/<file>`. An image-storage adapter (for example R2) would implement those three operations and return its own URL. Reuse by content hash already depends only on SHA-256.
- **The job folder** holds the uploaded deck and the IR while one job runs. A hosted deployment needs a writable temporary location for it, and Python for the extractor, or an extraction service that returns the same IR.

Until then, run imports on a local copy of the app. Publishing and R2 storage are out of scope here (see below).

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

Importing from the Scene Editor, through `/api/scene-imports` with the real extractor:

| Check | Result |
|---|---|
| Pelvis deck uploaded twice | 19 draft scenes created in about 0.5 s, then 19 unchanged; job folder removed; no server path in any response |
| Full Bone Project 2.0 deck (17.7 MB) uploaded twice | 232 created and 146 images copied in about 4.4 s, then 232 unchanged and none copied |
| Same deck under a different deck key, in the browser | import stopped before writing; every slide rejected with its name clash; nothing saved |

Tests:

```bash
npx jest pptxSceneImport presentationImport
PPTX_IR_TEST_DECK="Bone Box (Boney Pelvis).pptx" python3 -m unittest data_extraction/test_pptx_ir.py
```

## Known gaps

- Dashed outlines are drawn solid; picture borders and text-box fills are not imported.
- A label whose lines point into two photos moves with one of them if only one photo is moved later.
- Annotations always draw above photos, while slides can interleave them.
- Highlights are polygons, so editing a curve means editing its points.
