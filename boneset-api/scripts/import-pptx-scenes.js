#!/usr/bin/env node
// Developer-run migration: PowerPoint IR (data_extraction/pptx_ir.py) -> Scene
// Editor scenes, written through the same validation and store the API uses.
//
//   node boneset-api/scripts/import-pptx-scenes.js --ir out/deck.ir.json [--slides 2-7] [--dry-run] [--force]
//
// Scenes go to the store resolveSceneStore() picks (Redis when configured,
// otherwise SCENES_DIR or boneset-api/data/scenes). Set SCENES_DIR to a scratch
// folder to try an import without touching real scenes.
//
// Safe to re-run: scene and object ids are derived from the deck key, slide id
// and shape id. A scene is replaced only if nobody edited it since the last
// import (its content still matches the importLog's contentHash); edited
// scenes are left alone unless --force is given. Legacy annotation JSON is
// never read or written.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { convertSlide, contentHash } = require("../pptxSceneImport");
const { resolveSceneStore, validateSceneContent } = require("../scenes");

const DEFAULT_IMAGES_DIR = path.join(__dirname, "..", "data", "images");

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

/** Existing images by content hash, so media already in the app is reused, not copied. */
function indexImages(imagesDir) {
    const index = new Map();
    if (!fs.existsSync(imagesDir)) return index;
    for (const name of fs.readdirSync(imagesDir)) {
        if (!/\.(jpe?g|png)$/i.test(name)) continue;
        index.set(sha256(fs.readFileSync(path.join(imagesDir, name))), name);
    }
    return index;
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

async function run(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);
    const irPath = path.resolve(args.ir);
    const ir = JSON.parse(fs.readFileSync(irPath, "utf8"));
    if (ir.irVersion !== 1) throw new Error(`Unsupported IR version ${ir.irVersion}`);
    const irDir = path.dirname(irPath);
    const existing = indexImages(args.imagesDir);
    const store = resolveSceneStore(env);
    const results = [];

    const mediaSrc = (sha, mediaFile) => {
        let name = existing.get(sha);
        if (!name) {
            name = `pptx_${path.basename(mediaFile)}`;
            if (!args.dryRun) {
                fs.mkdirSync(args.imagesDir, { recursive: true });
                fs.copyFileSync(path.join(irDir, mediaFile), path.join(args.imagesDir, name));
            }
            existing.set(sha, name);
        }
        return `/api/images/${encodeURIComponent(name)}`;
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
        let action = "dry run";
        if (!args.dryRun) {
            action = await store.withLock(scene.id, async () => {
                const current = await store.get(scene.id);
                if (!current) {
                    await store.save(scene);
                    return "created";
                }
                const lastImport = [...(current.importLog || [])].reverse().find((entry) => entry.kind === "pptx-import");
                const currentHash = contentHash({ images: current.images, annotations: current.annotations });
                const untouched = lastImport && lastImport.contentHash === currentHash;
                if (!untouched && !args.force) return "kept (edited since import; use --force)";
                if (untouched && lastImport.contentHash === scene.importLog[0].contentHash) return "unchanged";
                await store.save({
                    ...current,
                    images: scene.images,
                    annotations: scene.annotations,
                    importLog: [...(current.importLog || []), ...scene.importLog].slice(-50),
                    updatedAt: scene.updatedAt,
                });
                return untouched ? "updated" : "replaced (--force)";
            });
        }
        results.push({ report, name: scene.name, action, sceneId: scene.id });
    }

    const reportText = markdownReport(results, ir);
    const reportPath = args.report || path.join(irDir, `${ir.deck.key}.import-report.md`);
    fs.writeFileSync(reportPath, reportText);
    for (const r of results) console.log(`slide ${r.report.slide}: ${r.action}${r.sceneId ? ` ${r.sceneId}` : ""}`);
    console.log(`report: ${reportPath}`);
    return results;
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { run, parseArgs, indexImages };
