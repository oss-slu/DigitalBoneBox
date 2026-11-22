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
// Identity. A scene's id is its permanent record id; its name is only a label
// and can be changed in the editor. An imported scene is found again by its id
// or, failing that, by its source identity (deck key + PowerPoint slide id in
// its importLog), so a re-import updates or reports the existing scene and
// never creates a second one, and a renamed scene keeps both its id and name.
// A new scene whose name is already used by another scene (compared without
// case, as the API does) is rejected, not saved.
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
// image catalog (it lists only the top level), and which git ignores. Media is
// read only from inside the IR's folder and must match the hash in the IR;
// existing image files are never overwritten.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { convertSlide, contentHash } = require("../pptxSceneImport");
const { resolveSceneStore, validateSceneContent, normalizeSceneName } = require("../scenes");

const DEFAULT_IMAGES_DIR = path.join(__dirname, "..", "data", "images");
const IMPORTED_IMAGES_SUBDIR = "pptx";
const LEGACY_IMAGE_FILE = /\.(jpe?g|png)$/i; // what the image catalog lists (boneset-api/images.js)
const MEDIA_EXTENSION = /^\.[a-z0-9]{1,10}$/;

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

/** Writes an imported image into images/pptx/ once; an existing file is never overwritten. */
function writeImportedImage(imagesDir, fileName, bytes) {
    const folder = path.join(imagesDir, IMPORTED_IMAGES_SUBDIR);
    fs.mkdirSync(folder, { recursive: true });
    const base = fs.realpathSync(imagesDir);
    const realFolder = fs.realpathSync(folder);
    const target = path.join(realFolder, fileName);
    if (!isInside(base, realFolder) || !isInside(realFolder, target)) {
        throw new Error(`Refusing to write ${fileName} outside ${base}`);
    }
    try {
        fs.writeFileSync(target, bytes, { flag: "wx" });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (sha256(fs.readFileSync(target)) !== sha256(bytes)) {
            throw new Error(`${target} already exists with different content; not overwriting it`);
        }
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

function markdownReport(results, ir) {
    const lines = [`# PowerPoint import report: ${ir.deck.file}`, "",
        `Deck sha256 \`${ir.deck.sha256}\`, slide size ${ir.deck.slideSize.cx} x ${ir.deck.slideSize.cy} EMU.`, "",
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

/** Saves an imported scene over `current` (same id, name, status and creation time), or reports why not. */
async function updateExisting(store, current, scene, force) {
    const lastImport = lastPptxImport(current);
    const currentHash = contentHash({ images: current.images, annotations: current.annotations });
    const untouched = lastImport && lastImport.contentHash === currentHash;
    if (!untouched && !force) return { action: "kept (edited since import; use --force)", saved: current };
    if (untouched && lastImport.contentHash === scene.importLog[0].contentHash) return { action: "unchanged", saved: current };
    const saved = {
        ...current,
        images: scene.images,
        annotations: scene.annotations,
        importLog: [...(current.importLog || []), ...scene.importLog].slice(-50),
        updatedAt: scene.updatedAt,
    };
    await store.save(saved);
    return { action: untouched ? "updated" : "replaced (--force)", saved };
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
    const results = [];

    const mediaSrc = (sha, mediaFile) => {
        let name = existing.get(sha);
        if (!name) {
            const bytes = readMedia(irDir, mediaFile, sha);
            const extension = path.extname(String(mediaFile)).toLowerCase();
            const fileName = `${sha.slice(0, 16)}${MEDIA_EXTENSION.test(extension) ? extension : ".bin"}`;
            if (!args.dryRun) writeImportedImage(args.imagesDir, fileName, bytes);
            name = `${IMPORTED_IMAGES_SUBDIR}/${fileName}`;
            existing.set(sha, name);
        }
        return `/api/images/${name.split("/").map(encodeURIComponent).join("/")}`;
    };

    for (const slide of ir.slides) {
        if (args.slides && !args.slides.has(slide.index)) continue;
        const { scene, report } = convertSlide(ir, slide.index, { mediaSrc });
        if (!scene) {
            results.push({ report, action: "no figure" });
            continue;
        }
        const content = validateSceneContent({ images: scene.images, annotations: scene.annotations, importLog: scene.importLog });
        if (content.error) {
            results.push({ report, name: scene.name, action: `rejected: ${content.error}` });
            continue;
        }
        const named = normalizeSceneName(scene.name);
        if (named.error) {
            results.push({ report, name: scene.name, action: `rejected: ${named.error}` });
            continue;
        }
        scene.name = named.name;

        const source = sourceIdentity(ir.deck.key, slide.slideId);
        const match = known.find((s) => s.id === scene.id) || known.find((s) => sceneSource(s) === source) || null;
        if (!match) {
            const clash = sceneWithName(known, scene.name);
            if (clash) {
                results.push({ report, name: scene.name, action: `rejected: a scene named "${clash.name}" already exists (${clash.id})` });
                continue;
            }
        }
        if (args.dryRun) {
            results.push({ report, name: match ? match.name : scene.name, action: match ? "dry run (exists)" : "dry run (new)", sceneId: match ? match.id : scene.id });
            continue;
        }
        const targetId = match ? match.id : scene.id;
        const outcome = await store.withLock(targetId, async () => {
            const current = await store.get(targetId);
            if (current) return updateExisting(store, current, scene, args.force);
            await store.save(scene);
            return { action: "created", saved: scene };
        });
        const position = known.findIndex((s) => s.id === outcome.saved.id);
        if (position >= 0) known[position] = outcome.saved;
        else known.push(outcome.saved);
        results.push({ report, name: outcome.saved.name, action: outcome.action, sceneId: outcome.saved.id });
    }

    const reportText = markdownReport(results, ir);
    const reportPath = args.report || path.join(irDir, `${ir.deck.key}.import-report.md`);
    fs.writeFileSync(reportPath, reportText);
    for (const r of results) console.log(`slide ${r.report.slide}: ${r.action}${r.sceneId ? ` ${r.sceneId}` : ""}`);
    console.log(`report: ${reportPath}`);
    return results;
}

if (require.main === module) {
    run()
        .then((results) => {
            if (results.some((r) => r.action.startsWith("rejected"))) process.exitCode = 1;
        })
        .catch((error) => {
            console.error(error.message);
            process.exit(1);
        });
}

module.exports = { run, parseArgs, indexImages, readMedia, sourceIdentity, IMPORTED_IMAGES_SUBDIR };
