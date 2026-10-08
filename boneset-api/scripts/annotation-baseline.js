// Records and checks a fingerprint of every existing annotation file, so editor
// work can't change or delete one without anyone noticing. Issue #465.
//
//
// Fingerprints are taken from the parsed JSON, not the raw bytes, so Windows line
// endings or re-indenting don't count as a change, but any changed value does.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ANNOTATIONS_DIR = path.join(__dirname, "..", "data", "annotations");
const BASELINE_PATH = path.join(__dirname, "..", "data", "annotation-baseline.json");

function listAnnotationFiles(dir = ANNOTATIONS_DIR, prefix = "") {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files.push(...listAnnotationFiles(path.join(dir, entry.name), relative));
        } else if (entry.name.toLowerCase().endsWith(".json")) {
            files.push(relative);
        }
    }
    return files.sort();
}

function fingerprint(relativePath, dir = ANNOTATIONS_DIR) {
    const text = fs.readFileSync(path.join(dir, ...relativePath.split("/")), "utf8");
    const canonical = JSON.stringify(JSON.parse(text.replace(/^﻿/, "")));
    return crypto.createHash("sha256").update(canonical).digest("hex");
}

function buildBaseline(dir = ANNOTATIONS_DIR) {
    const files = {};
    for (const file of listAnnotationFiles(dir)) {
        files[file] = fingerprint(file, dir);
    }
    return { description: "Fingerprints of the existing annotation files. Issue #465.", files };
}

function readBaseline(baselinePath = BASELINE_PATH) {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

/**
 * Compares the annotation files on disk with the baseline.
 * @returns {{ missing: string[], changed: string[], added: string[] }}
 */
function compareWithBaseline(baseline, dir = ANNOTATIONS_DIR) {
    const current = buildBaseline(dir).files;
    const expected = baseline.files;
    return {
        missing: Object.keys(expected).filter((file) => !(file in current)),
        changed: Object.keys(expected).filter((file) => file in current && current[file] !== expected[file]),
        added: Object.keys(current).filter((file) => !(file in expected)),
    };
}

function main() {
    if (process.argv.includes("--write")) {
        const baseline = buildBaseline();
        fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
        console.log(`Recorded ${Object.keys(baseline.files).length} annotation files in ${path.relative(process.cwd(), BASELINE_PATH)}`);
        return;
    }

    const { missing, changed, added } = compareWithBaseline(readBaseline());
    if (missing.length + changed.length + added.length === 0) {
        console.log("All annotation files match the baseline.");
        return;
    }
    for (const file of missing) console.log(`MISSING  ${file}`);
    for (const file of changed) console.log(`CHANGED  ${file}`);
    for (const file of added) console.log(`ADDED    ${file}`);
    console.log("If these changes are intended, record a new baseline with --write and explain why in the PR.");
    process.exitCode = 1;
}

if (require.main === module) {
    main();
}

module.exports = { listAnnotationFiles, fingerprint, buildBaseline, readBaseline, compareWithBaseline, ANNOTATIONS_DIR };