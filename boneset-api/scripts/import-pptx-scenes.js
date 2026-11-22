#!/usr/bin/env node
// Developer-run migration: PowerPoint IR (data_extraction/pptx_ir.py) -> Scene
// Editor scenes. The import itself lives in ../pptxImportPipeline.js, which the
// Scene Editor's Import presentation action uses too; see that file and
// docs/pptx-import/README.md for the rules.
//
//   node boneset-api/scripts/import-pptx-scenes.js --ir <import folder>/<deck-key>.ir.json [--slides 2-7] [--dry-run] [--force]
//
// Scenes go to the store resolveSceneStore() picks (Redis when configured,
// otherwise SCENES_DIR or boneset-api/data/scenes). Set SCENES_DIR to a scratch
// folder to try an import without touching real scenes. The command exits with
// status 1 if any slide was rejected or not saved.
const path = require("path");
const { resolveSceneStore } = require("../scenes");
const {
    importIr,
    parseSlides,
    indexImages,
    readMedia,
    sourceIdentity,
    DEFAULT_IMAGES_DIR,
    IMPORTED_IMAGES_SUBDIR,
    FAILED_ACTION,
} = require("../pptxImportPipeline");

function parseArgs(argv) {
    const args = { slides: null, dryRun: false, force: false, imagesDir: DEFAULT_IMAGES_DIR, report: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--ir") args.ir = argv[++i];
        else if (arg === "--slides") args.slides = parseSlides(argv[++i]);
        else if (arg === "--images-dir") args.imagesDir = path.resolve(argv[++i]);
        else if (arg === "--report") args.report = path.resolve(argv[++i]);
        else if (arg === "--dry-run") args.dryRun = true;
        else if (arg === "--force") args.force = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.ir) throw new Error("--ir <deck.ir.json> is required");
    return args;
}

/** Runs the import for command-line arguments and prints one line per slide. Returns the results. */
async function run(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    const outcome = await importIr({
        irPath: args.ir,
        store: resolveSceneStore(env),
        imagesDir: args.imagesDir,
        slides: args.slides,
        dryRun: args.dryRun,
        force: args.force,
        report: args.report,
    });
    for (const r of outcome.results) console.log(`slide ${r.report.slide}: ${r.action}${r.sceneId ? ` ${r.sceneId}` : ""}`);
    console.log(outcome.summary);
    console.log(`report: ${outcome.reportPath}`);
    return outcome.results;
}

if (require.main === module) {
    run()
        .then((results) => {
            if (results.some((r) => FAILED_ACTION.test(r.action))) process.exitCode = 1;
        })
        .catch((error) => {
            console.error(error.message);
            process.exit(1);
        });
}

module.exports = { run, parseArgs, indexImages, readMedia, sourceIdentity, IMPORTED_IMAGES_SUBDIR, FAILED_ACTION };
