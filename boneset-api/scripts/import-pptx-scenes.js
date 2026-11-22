#!/usr/bin/env node
// Developer-run migration: PowerPoint IR (data_extraction/pptx_ir.py) -> Scene
// Editor scenes, written through the same validation and store the API uses.
//
//   node boneset-api/scripts/import-pptx-scenes.js --ir <import folder>/<deck-key>.ir.json [--slides 2-7] [--dry-run] [--force]
//
// Scenes go to the store resolveSceneStore() picks (Redis when configured,
// otherwise SCENES_DIR or boneset-api/data/scenes). Set SCENES_DIR to a scratch
// folder to try an import without touching real scenes.
//
// Preflight, then write. Every selected slide is converted and checked before
// anything is written: scene content, scene name, scene and source identity,
// media paths, media hashes and image file names. If any slide is rejected,
// no scene is saved and no image is copied; the command reports every rejected
// slide and exits with status 1. Only when every slide passes are the new
// images written and then the scenes saved. The write phase is not a
// transaction: if the disk or the store fails part way through, the images
// written by this run are removed when the failure is in the image step, but
// scenes saved before a failing scene save stay saved. Running the same
// import again finishes it, because imports are idempotent.
//
// Identity. A scene's id is its permanent record id; its name is only a label
// and can be changed in the editor. An imported scene is found again by its id
// or, failing that, by its source identity (deck key + PowerPoint slide id in
// its importLog), so a re-import updates or reports the existing scene and
// never creates a second one, and a renamed scene keeps both its id and name.
// A new scene whose name is already used by another scene (compared without
// case, as the API does) is rejected.
//
// Re-import safety. A scene is replaced only if nobody edited it since the last
// import (its content still matches the importLog's contentHash); edited scenes
// are left alone unless --force is given. Legacy annotation JSON is never read
// or written.
//
// Images. This is a transitional local implementation until images move to an
// image-storage service. An image whose bytes already exist in the images
// folder (a legacy bone image, or one imported before) is reused by its content
// hash. Other images are copied once into the images folder's pptx/ subfolder,
// which the API serves at /api/images/pptx/..., which stays out of the legacy
// image catalog (it lists only the top level), and which git ignores. Only
// images used by a scene that is being saved are copied. Media is read only
// from inside the IR's folder and must match the hash in the IR; existing image
// files are never overwritten.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { convertSlide, contentHash } = require("../pptxSceneImport");
const { resolveSceneStore, validateSceneContent, normalizeSceneName } = require("../scenes");

const DEFAULT_IMAGES_DIR = path.join(__dirname, "..", "data", "images");
const IMPORTED_IMAGES_SUBDIR = "pptx";
const LEGACY_IMAGE_FILE = /\.(jpe?g|png)$/i; // what the image catalog lists (boneset-api/images.js)
const MEDIA_EXTENSION = /^\.[a-z0-9]{1,10}$/;

// What happens to a slide's scene. Only the first, third and fifth write.
const DECISIONS = {
    create: { saves: true, done: "created", planned: "would create" },
    unchanged: { saves: false, done: "unchanged", planned: "unchanged" },
    update: { saves: true, done: "updated", planned: "would update" },
    keep: { saves: false, done: "kept (edited since import; use --force)", planned: "would keep (edited since import; use --force)" },
    replace: { saves: true, done: "replaced (--force)", planned: "would replace (--force)" },
};
const FAILED_ACTION = /^(rejected|failed|not saved|skipped)/;

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

function parseSlides(spec) {
    const out = new Set();
    for (const part of String(spec).split(",")) {
        const [a, b] = part.split("-").map(Number);
        for (let n = a; n <= (b || a); n += 1) out.add(n);
    }
    return out;
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** True when `target` is strictly inside `base` (both absolute and resolved). */
function isInside(base, target) {
    const relative = path.relative(base, target);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Existing images by content hash, so media already in the app is reused, not
 * copied: the legacy images at the top level and earlier imports in pptx/.
 * Values are paths relative to the images folder.
 */
function indexImages(imagesDir) {
    const index = new Map();
    if (!fs.existsSync(imagesDir)) return index;
    for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
        if (entry.isFile() && LEGACY_IMAGE_FILE.test(entry.name)) {
            index.set(sha256(fs.readFileSync(path.join(imagesDir, entry.name))), entry.name);
        }
    }
    const importedDir = path.join(imagesDir, IMPORTED_IMAGES_SUBDIR);
    if (fs.existsSync(importedDir)) {
        for (const entry of fs.readdirSync(importedDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const hash = sha256(fs.readFileSync(path.join(importedDir, entry.name)));
            if (!index.has(hash)) index.set(hash, `${IMPORTED_IMAGES_SUBDIR}/${entry.name}`);
        }
    }
    return index;
}

/** Reads a media file named in the IR, refusing paths outside the IR's folder and bytes that do not match the IR. */
function readMedia(irDir, mediaFile, expectedSha) {
    const base = fs.realpathSync(irDir);
    const target = path.resolve(base, String(mediaFile));
    if (!isInside(base, target) || !isInside(base, fs.realpathSync(target))) {
        throw new Error(`Media file ${JSON.stringify(mediaFile)} is outside the IR folder ${base}`);
    }
    const bytes = fs.readFileSync(target);
    if (sha256(bytes) !== expectedSha) {
        throw new Error(`Media file ${mediaFile} does not match its sha256 in the IR; re-run pptx_ir.py`);
    }
    return bytes;
}

/** The file name an imported image gets in images/pptx/: its hash prefix and a plain extension. */
function importedImageName(sha, mediaFile) {
    const extension = path.extname(String(mediaFile)).toLowerCase();
    return `${sha.slice(0, 16)}${MEDIA_EXTENSION.test(extension) ? extension : ".bin"}`;
}

/** Where an imported image would be written, refusing anything that is not a plain file name inside images/pptx/. */
function importedImagePath(imagesDir, fileName) {
    const folder = path.resolve(imagesDir, IMPORTED_IMAGES_SUBDIR);
    const target = path.resolve(folder, fileName);
    if (path.dirname(target) !== folder) throw new Error(`Refusing to write ${fileName} outside ${folder}`);
    return target;
}

/** Preflight: an image may be written only if nothing is at its path yet. Nothing is written here. */
function checkImportedImageTarget(imagesDir, fileName) {
    const target = importedImagePath(imagesDir, fileName);
    if (fs.existsSync(target)) {
        throw new Error(`${target} already exists with different content; not overwriting it`);
    }
}

/**
 * Writes an imported image into images/pptx/ unless an identical file is
 * already there; an existing file is never overwritten. Returns the path when
 * this call created the file, otherwise null.
 */
function writeImportedImage(imagesDir, fileName, bytes) {
    const target = importedImagePath(imagesDir, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const base = fs.realpathSync(imagesDir);
    const realFolder = fs.realpathSync(path.dirname(target));
    if (!isInside(base, realFolder)) throw new Error(`Refusing to write ${fileName} outside ${base}`);
    const realTarget = path.join(realFolder, fileName);
    try {
        fs.writeFileSync(realTarget, bytes, { flag: "wx" });
        return realTarget;
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (sha256(fs.readFileSync(realTarget)) !== sha256(bytes)) {
            throw new Error(`${realTarget} already exists with different content; not overwriting it`);
        }
        return null;
    }
}

function lastPptxImport(scene) {
    return [...(scene.importLog || [])].reverse().find((entry) => entry && entry.kind === "pptx-import") || null;
}

/** Deck key + PowerPoint slide id: what an imported scene came from, independent of its id and name. */
function sourceIdentity(deckKey, slideId) {
    return JSON.stringify([String(deckKey), String(slideId)]);
}

function sceneSource(scene) {
    const entry = lastPptxImport(scene);
    return entry && entry.deck && entry.slide ? sourceIdentity(entry.deck.key, entry.slide.slideId) : null;
}

/** The scene, other than `exceptId`, that already uses `name`, compared without case like the API's isNameTaken. */
function sceneWithName(scenes, name, exceptId = null) {
    const lowered = name.toLowerCase();
    return scenes.find((s) => s.id !== exceptId && typeof s.name === "string" && s.name.toLowerCase() === lowered) || null;
}

/** What a re-import does to an existing scene, without writing anything. */
function decideUpdate(current, scene, force) {
    const lastImport = lastPptxImport(current);
    const currentHash = contentHash({ images: current.images, annotations: current.annotations });
    const untouched = Boolean(lastImport) && lastImport.contentHash === currentHash;
    if (!untouched && !force) return "keep";
    if (untouched && lastImport.contentHash === scene.importLog[0].contentHash) return "unchanged";
    return untouched ? "update" : "replace";
}

function markdownReport(results, ir, summary) {
    const lines = [`# PowerPoint import report: ${ir.deck.file}`, "",
        `Deck sha256 \`${ir.deck.sha256}\`, slide size ${ir.deck.slideSize.cx} x ${ir.deck.slideSize.cy} EMU.`, "",
        summary, "",
        "| Slide | Scene | Result | Photos | Labels | Lines | Regions | Needs review | Skipped |",
        "|---|---|---|---|---|---|---|---|---|"];
    for (const r of results) {
        const c = r.report.counts || {};
        lines.push(`| ${r.report.slide} | ${r.name || "-"} | ${r.action} | ${c.images ?? "-"} | ${c.labels ?? "-"} | ${c.pointerLines ?? "-"} | ${(c.regions ?? 0) + (c.outlines ?? 0)} | ${c.flagged ?? 0} | ${c.skipped ?? 0} |`);
    }
    lines.push("", "## Objects that need review", "");
    const flagged = results.flatMap((r) => (r.report.flagged || []).map((f) => ({ slide: r.report.slide, ...f })));
    if (!flagged.length) lines.push("None.");
    for (const f of flagged) lines.push(`- Slide ${f.slide}, ${f.type} \`${f.name}\`: ${f.reasons.join("; ")}`);
    lines.push("", "## Notes (imported exactly; worth knowing)", "");
    const notes = results.flatMap((r) => (r.report.notes || []).map((n) => ({ slide: r.report.slide, ...n })));
    if (!notes.length) lines.push("None.");
    for (const n of notes) lines.push(`- Slide ${n.slide}, \`${n.name}\`: ${n.note}`);
    lines.push("", "## Left out of the scene (kept in the IR)", "");
    for (const r of results) {
        for (const s of r.report.skipped || []) {
            lines.push(`- Slide ${r.report.slide}: ${s.reason}${s.text ? ` ("${s.text.replace(/\s+/g, " ").slice(0, 50)}")` : s.name ? ` (${s.name})` : ""}`);
        }
    }
    return lines.join("\n") + "\n";
}

/**
 * Converts and checks one slide without writing anything. Returns a plan:
 * `{ rejected }`, `{ noFigure }`, or `{ scene, targetId, current, decision, shas }`.
 */
function preflightSlide(context, slide) {
    const { ir, args, known, claimedNames } = context;
    const shas = new Set();
    context.slideShas = shas;
    let converted;
    try {
        converted = convertSlide(ir, slide.index, { mediaSrc: context.mediaSrc });
    } catch (error) {
        return { report: { slide: slide.index }, rejected: error.message };
    }
    const { scene, report } = converted;
    if (!scene) return { report, noFigure: true };
    const content = validateSceneContent({ images: scene.images, annotations: scene.annotations, importLog: scene.importLog });
    if (content.error) return { report, name: scene.name, rejected: content.error };
    const named = normalizeSceneName(scene.name);
    if (named.error) return { report, name: scene.name, rejected: named.error };
    scene.name = named.name;

    const source = sourceIdentity(ir.deck.key, slide.slideId);
    const current = known.find((s) => s.id === scene.id) || known.find((s) => sceneSource(s) === source) || null;
    if (current) {
        return { report, name: current.name, scene, targetId: current.id, current, decision: decideUpdate(current, scene, args.force), shas };
    }
    const clash = sceneWithName(known, scene.name);
    if (clash) return { report, name: scene.name, rejected: `a scene named "${clash.name}" already exists (${clash.id})` };
    const lowered = scene.name.toLowerCase();
    if (claimedNames.has(lowered)) {
        return { report, name: scene.name, rejected: `slide ${claimedNames.get(lowered)} of this import already uses the name "${scene.name}"` };
    }
    claimedNames.set(lowered, slide.index);
    return { report, name: scene.name, scene, targetId: scene.id, current: null, decision: "create", shas };
}

/** Saves one planned scene, re-reading it under its lock so a concurrent change is never overwritten. */
async function savePlanned(store, plan, force) {
    return store.withLock(plan.targetId, async () => {
        const current = await store.get(plan.targetId);
        const decision = current ? decideUpdate(current, plan.scene, force) : "create";
        if (decision !== plan.decision) {
            return { action: "skipped: the scene changed during the import; run it again", saved: current };
        }
        if (decision === "create") {
            await store.save(plan.scene);
            return { action: DECISIONS.create.done, saved: plan.scene };
        }
        const saved = {
            ...current,
            images: plan.scene.images,
            annotations: plan.scene.annotations,
            importLog: [...(current.importLog || []), ...plan.scene.importLog].slice(-50),
            updatedAt: plan.scene.updatedAt,
        };
        await store.save(saved);
        return { action: DECISIONS[decision].done, saved };
    });
}

async function run(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    const irPath = path.resolve(args.ir);
    const ir = JSON.parse(fs.readFileSync(irPath, "utf8"));
    if (ir.irVersion !== 1) throw new Error(`Unsupported IR version ${ir.irVersion}`);
    const irDir = path.dirname(irPath);
    const existing = indexImages(args.imagesDir);
    const store = resolveSceneStore(env);
    const known = await store.list();
    const pending = new Map(); // sha256 -> { fileName, bytes }: images to copy if their scene is saved

    // 1. Preflight: convert and check every selected slide. Nothing is written.
    const context = { ir, args, known, claimedNames: new Map(), slideShas: new Set() };
    context.mediaSrc = (sha, mediaFile) => {
        let name = existing.get(sha);
        if (!name) {
            const bytes = readMedia(irDir, mediaFile, sha);
            const fileName = importedImageName(sha, mediaFile);
            checkImportedImageTarget(args.imagesDir, fileName);
            name = `${IMPORTED_IMAGES_SUBDIR}/${fileName}`;
            existing.set(sha, name);
            pending.set(sha, { fileName, bytes });
        }
        if (pending.has(sha)) context.slideShas.add(sha);
        return `/api/images/${name.split("/").map(encodeURIComponent).join("/")}`;
    };
    const plans = ir.slides
        .filter((slide) => !args.slides || args.slides.has(slide.index))
        .map((slide) => preflightSlide(context, slide));

    const rejected = plans.filter((plan) => plan.rejected);
    const results = [];
    const finish = (summary) => {
        const reportPath = args.report || path.join(irDir, `${ir.deck.key}.import-report.md`);
        fs.writeFileSync(reportPath, markdownReport(results, ir, summary));
        for (const r of results) console.log(`slide ${r.report.slide}: ${r.action}${r.sceneId ? ` ${r.sceneId}` : ""}`);
        console.log(summary);
        console.log(`report: ${reportPath}`);
        return results;
    };

    if (rejected.length) {
        for (const plan of plans) {
            let action = `not saved: ${rejected.length} slide(s) rejected`;
            if (plan.rejected) action = `rejected: ${plan.rejected}`;
            else if (plan.noFigure) action = "no figure";
            results.push({ report: plan.report, name: plan.name, action, sceneId: plan.targetId });
        }
        return finish(`Import stopped before writing: ${rejected.length} slide(s) rejected. No scenes were saved and no images were copied.`);
    }
    if (args.dryRun) {
        for (const plan of plans) {
            const action = plan.noFigure ? "no figure" : `dry run: ${DECISIONS[plan.decision].planned}`;
            results.push({ report: plan.report, name: plan.name, action, sceneId: plan.targetId });
        }
        return finish("Dry run: every slide passed the checks. Nothing was written.");
    }

    // 2. Write the images used by the scenes that will be saved. If one fails,
    //    remove the images this run wrote, so a failed image step leaves none.
    const saving = plans.filter((plan) => plan.decision && DECISIONS[plan.decision].saves);
    const needed = new Set(saving.flatMap((plan) => [...plan.shas]));
    const written = [];
    try {
        for (const sha of needed) {
            const { fileName, bytes } = pending.get(sha);
            const created = writeImportedImage(args.imagesDir, fileName, bytes);
            if (created) written.push(created);
        }
    } catch (error) {
        for (const file of written) fs.rmSync(file, { force: true });
        throw new Error(`${error.message}. No scenes were saved, and the ${written.length} image(s) this run had written were removed.`);
    }

    // 3. Save the scenes. A store failure stops here; scenes saved before it stay saved.
    let failure = null;
    for (const plan of plans) {
        if (plan.noFigure) {
            results.push({ report: plan.report, action: "no figure" });
            continue;
        }
        if (failure) {
            results.push({ report: plan.report, name: plan.name, action: "not saved: stopped after a storage error", sceneId: plan.targetId });
            continue;
        }
        if (!DECISIONS[plan.decision].saves) {
            results.push({ report: plan.report, name: plan.name, action: DECISIONS[plan.decision].done, sceneId: plan.targetId });
            continue;
        }
        try {
            const outcome = await savePlanned(store, plan, args.force);
            results.push({ report: plan.report, name: outcome.saved ? outcome.saved.name : plan.name, action: outcome.action, sceneId: plan.targetId });
        } catch (error) {
            failure = error;
            results.push({ report: plan.report, name: plan.name, action: `failed: ${error.message}`, sceneId: plan.targetId });
        }
    }
    const saved = results.filter((r) => ["created", "updated", "replaced (--force)"].includes(r.action)).length;
    return finish(failure
        ? `Import stopped by a storage error after saving ${saved} scene(s). Run the same import again to finish it.`
        : `Import finished: ${saved} scene(s) saved, ${written.length} image(s) copied.`);
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
