// Import presentations from the Scene Editor (Issue #540).
//
//   GET  /api/scene-imports                 what is possible here: prerequisites, access, limits, known decks
//   POST /api/scene-imports/pptx            body: the .pptx bytes; query: deckKey, slides, dryRun; header X-File-Name
//   POST /api/scene-imports/google-slides   JSON { source, deckKey, slides, dryRun }
//   GET  /api/scene-imports/jobs/:id        progress and results of one import
//
// An import runs as a background job: the server saves the presentation in a
// job folder inside the local import folder, runs the existing extractor
// (data_extraction/pptx_ir.py) on it, then the existing import pipeline
// (pptxImportPipeline.js) that the command line uses. So duplicate prevention,
// scene ids and names, re-import behavior, the preflight and the image rules
// are the same code, not a copy. Imported scenes are always drafts, and the
// --force option is not offered: a scene edited since its last import is kept.
// One import runs at a time; others wait in a queue. The job folder, including
// the uploaded presentation, is deleted when the job ends.
//
// Access. The app has no user accounts, so import is off unless the server
// allows it. Without SCENE_IMPORT_TOKEN it only accepts requests from the
// computer the API runs on (a loopback address, no proxy header, and a local or
// same-host Origin). With SCENE_IMPORT_TOKEN set, a request must carry
// "Authorization: Bearer <token>". On Vercel import is unavailable, because the
// deployment has no Python and cannot store imported images.
//
// Nothing sent to the browser contains server paths, credentials, command
// lines or Python output: errors are mapped to messages written for the user,
// and the details go to the server log.
//
// Configuration (all optional): SCENE_IMPORT_TOKEN, PPTX_IMPORT_PYTHON (python
// executable, default python3, or python on Windows), PPTX_IMPORT_MAX_BYTES
// (default 50 MB), PPTX_IMPORT_TIMEOUT_MS (default 10 minutes), and the
// extractor's DBB_PPTX_IMPORT_DIR and PPTX_IR_FONT_DIR.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Buffer } = require("buffer");
const { spawn } = require("child_process");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { importIr, parseSlides, lastPptxImport, DEFAULT_IMAGES_DIR } = require("./pptxImportPipeline");

const EXTRACTOR_SCRIPT = path.join(__dirname, "..", "data_extraction", "pptx_ir.py");
const PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_CACHE_MS = 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS_KEPT = 50;
const MAX_QUEUED = 5;
const JOB_FOLDER = "scene-editor-jobs";
const DECK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // the extractor's own rule (validate_deck_key)
const GOOGLE_SLIDES_ID = /^[A-Za-z0-9_-]{20,128}$/;
const FINISHED = new Set(["succeeded", "checked", "stopped", "failed"]);

/** An error whose message is written for the person importing, and safe to show in the browser. */
class ImportError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ------------------------------------------------------------------ helpers

const megabytes = (bytes) => {
    if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} bytes`;
};

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A deck key from a file name, the way pptx_ir.py derives one. */
function deckKeyFromName(name) {
    const stem = String(name || "").replace(/\.[^.]*$/, "");
    return stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128).replace(/-+$/, "");
}

/** The presentation's name for provenance (importLog deck.file), reduced to a plain .pptx file name. */
function safeFileName(name, fallback = "presentation.pptx") {
    const base = String(name || "").split(/[\\/]/).pop().replace(/[^A-Za-z0-9 ._()-]/g, "_").replace(/^[.\s]+/, "").trim();
    const stem = base.replace(/\.pptx$/i, "").slice(0, 120).trim();
    return stem ? `${stem}.pptx` : fallback;
}

/** The presentation id in a Google Slides link, or the id itself; null if it is neither. */
function parseGoogleSlidesId(source) {
    const text = String(source || "").trim();
    if (GOOGLE_SLIDES_ID.test(text)) return text;
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
    const match = /^\/presentation(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    return match && GOOGLE_SLIDES_ID.test(match[1]) ? match[1] : null;
}

/** The file name in a Content-Disposition header (filename* or filename), if any. */
function fileNameFromDisposition(header) {
    if (!header) return null;
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (star) {
        try {
            return decodeURIComponent(star[1].trim());
        } catch {
            /* fall through to the plain filename */
        }
    }
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
    return plain ? (plain[1] || plain[2] || "").trim() || null : null;
}

/** Quick checks that bytes are a .pptx before the extractor sees them. */
function checkPresentationBytes(bytes, maxBytes) {
    if (!bytes || !bytes.length) throw new ImportError(400, "The file is empty.");
    if (bytes.length > maxBytes) throw new ImportError(413, `The presentation is larger than the ${megabytes(maxBytes)} limit.`);
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!zip) throw new ImportError(400, "This isn't a .pptx presentation. If it is password-protected, remove the password and try again.");
    if (!bytes.includes("ppt/presentation.xml")) {
        throw new ImportError(400, "This file is not a PowerPoint presentation. Choose a .pptx file.");
    }
}

function isLoopback(address) {
    if (!address) return false;
    const plain = address.replace(/^::ffff:/, "");
    return plain === "::1" || plain === "localhost" || /^127\./.test(plain);
}

function isLoopbackHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || isLoopback(host);
}

function sameSecret(given, expected) {
    const a = crypto.createHash("sha256").update(String(given)).digest();
    const b = crypto.createHash("sha256").update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

async function readLimited(response, maxBytes) {
    if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytes) {
                await reader.cancel();
                throw new ImportError(413, `The presentation is larger than the ${megabytes(maxBytes)} limit.`);
            }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new ImportError(413, `The presentation is larger than the ${megabytes(maxBytes)} limit.`);
    return bytes;
}

const GOOGLE_NOT_SHARED = "Google Slides did not allow the download. Share the presentation as \"Anyone with the link can view\", "
    + "or download it in Google Slides (File > Download > Microsoft PowerPoint) and import the .pptx file.";

function isGoogleDownloadHost(hostname) {
    return hostname === "docs.google.com" || hostname.endsWith(".googleusercontent.com");
}

/**
 * Downloads Google's own .pptx export of a presentation. The URL is built from
 * the validated id, and redirects are only followed to Google's download hosts.
 */
async function downloadGoogleSlides(id, { fetchImpl, maxBytes }) {
    let url = `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/export/pptx`;
    for (let hop = 0; hop < 6; hop += 1) {
        let response;
        try {
            response = await fetchImpl(url, { redirect: "manual", headers: { Accept: PPTX_CONTENT_TYPE } });
        } catch (error) {
            console.error("Google Slides download failed:", error);
            throw new ImportError(502, "The server could not reach Google Slides. Check its internet connection, or import a downloaded .pptx file.");
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            let next;
            try {
                next = new URL(response.headers.get("location"), url);
            } catch {
                throw new ImportError(502, "Google Slides sent an unexpected response. Import a downloaded .pptx file instead.");
            }
            if (next.protocol !== "https:" || !isGoogleDownloadHost(next.hostname)) throw new ImportError(403, GOOGLE_NOT_SHARED);
            url = next.href;
            continue;
        }
        if (response.status === 401 || response.status === 403) throw new ImportError(403, GOOGLE_NOT_SHARED);
        if (response.status === 404) throw new ImportError(404, "Google Slides has no presentation with that link. Check the link and try again.");
        if (!response.ok) {
            throw new ImportError(502, `Google Slides returned an error (HTTP ${response.status}). Try again later, or import a downloaded .pptx file.`);
        }
        const length = Number(response.headers.get("content-length"));
        if (length > maxBytes) throw new ImportError(413, `The presentation is larger than the ${megabytes(maxBytes)} limit.`);
        const type = response.headers.get("content-type") || "";
        if (/text\/html/i.test(type)) throw new ImportError(403, GOOGLE_NOT_SHARED); // a sign-in or warning page
        const bytes = await readLimited(response, maxBytes);
        const fileName = safeFileName(fileNameFromDisposition(response.headers.get("content-disposition")), `google-slides-${id}.pptx`);
        return { bytes, fileName };
    }
    throw new ImportError(502, "Google Slides redirected too many times. Import a downloaded .pptx file instead.");
}

// ------------------------------------------------------------------ the extractor

/** Runs Python with arguments (never through a shell); resolves with its exit code and output. */
function runPython(python, args, { timeoutMs, env, onStderrLine }) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(python, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        } catch (error) {
            reject(error);
            return;
        }
        let stdout = "";
        let stderr = "";
        let partial = "";
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout = (stdout + chunk).slice(-65536);
        });
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-65536);
            partial += chunk;
            const lines = partial.split(/\r?\n/);
            partial = lines.pop();
            if (onStderrLine) lines.forEach(onStderrLine);
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (partial && onStderrLine) onStderrLine(partial);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

/** The default extractor: data_extraction/pptx_ir.py run with the server's Python. */
function createPythonExtractor({ python, timeoutMs, env }) {
    return {
        async check() {
            const result = await runPython(python, [EXTRACTOR_SCRIPT, "--check"], { timeoutMs: 20000, env });
            if (result.code !== 0) throw new Error(`pptx_ir.py --check exited with ${result.code}: ${result.stderr}`);
            return JSON.parse(result.stdout);
        },
        async extract({ deckPath, outDir, deckKey, slides, onProgress, onWarning }) {
            const args = [EXTRACTOR_SCRIPT, deckPath, outDir, "--deck-key", deckKey, "--progress"];
            if (slides) args.push("--slides", slides);
            const result = await runPython(python, args, {
                timeoutMs,
                env,
                onStderrLine(line) {
                    if (line.startsWith("{\"progress\"")) {
                        try {
                            onProgress(JSON.parse(line).progress);
                        } catch {
                            /* not a progress line after all */
                        }
                    } else if (line.startsWith("WARNING: label line breaks were estimated")) {
                        onWarning("Label line breaks were estimated because Pillow or Calibri/Carlito is missing on the server, so every label is flagged for review.");
                    }
                },
            });
            if (result.signal) {
                throw new ImportError(504, "Reading the presentation took too long and was stopped. Try importing fewer slides at a time.");
            }
            if (result.code !== 0) {
                console.error(`pptx_ir.py exited with ${result.code}:\n${result.stderr}`);
                throw new ImportError(422, "The presentation could not be read. It may be damaged, or use features the importer does not support.");
            }
            const irPath = path.join(outDir, `${deckKey}.ir.json`);
            if (!fs.existsSync(irPath)) throw new Error(`pptx_ir.py did not write ${irPath}`);
            return irPath;
        },
    };
}

// ------------------------------------------------------------------ results for the browser

function publicResult(result) {
    const report = result.report || {};
    const counts = report.counts || null;
    return {
        slide: report.slide,
        sceneId: result.sceneId || null,
        sceneName: result.name || null,
        outcome: result.outcome,
        action: result.action,
        counts: counts && {
            images: counts.images ?? 0,
            labels: counts.labels ?? 0,
            pointerLines: counts.pointerLines ?? 0,
            regions: (counts.regions ?? 0) + (counts.outlines ?? 0),
            flagged: counts.flagged ?? 0,
            skipped: counts.skipped ?? 0,
        },
        flagged: (report.flagged || []).map((f) => ({ type: f.type, name: f.name, reasons: f.reasons || [] })),
        skipped: (report.skipped || []).map((s) => ({ reason: s.reason, detail: s.text ? s.text.replace(/\s+/g, " ").slice(0, 80) : s.name || null })),
        notes: (report.notes || []).map((n) => ({ name: n.name, note: n.note })),
    };
}

function publicJob(job, position = 0) {
    return {
        id: job.id,
        state: job.state,
        position,
        phase: job.phase,
        progress: job.progress,
        source: job.source,
        deckKey: job.deckKey,
        slides: job.slides,
        dryRun: job.dryRun,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        summary: job.summary,
        warnings: job.warnings,
        error: job.error,
        results: job.results,
    };
}

// ------------------------------------------------------------------ the router

/**
 * @param {object} options
 * @param {object} options.store the scene store the scenes API uses (shared, so their locks agree)
 * @param {string} [options.imagesDir] the images folder /api/images serves
 * @param {object} [options.env] environment for configuration (default process.env)
 * @param {object} [options.extractor] { check(), extract() }; default runs pptx_ir.py
 * @param {Function} [options.fetchImpl] fetch for Google Slides downloads
 */
function createPresentationImportRouter({ store, imagesDir = DEFAULT_IMAGES_DIR, env = process.env, extractor = null, fetchImpl = globalThis.fetch } = {}) {
    const config = {
        token: env.SCENE_IMPORT_TOKEN || null,
        maxBytes: positiveInt(env.PPTX_IMPORT_MAX_BYTES, DEFAULT_MAX_BYTES),
        timeoutMs: positiveInt(env.PPTX_IMPORT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        python: env.PPTX_IMPORT_PYTHON || (process.platform === "win32" ? "python" : "python3"),
        hosted: Boolean(env.VERCEL),
    };
    const tools = extractor || createPythonExtractor({ python: config.python, timeoutMs: config.timeoutMs, env });
    const jobs = new Map();
    let queue = Promise.resolve();
    let checked = null;

    // Server folders that must never reach the browser, longest first.
    const privateFolders = () => [imagesDir, checked && checked.report && checked.report.importDir, path.join(__dirname, ".."), os.tmpdir(), os.homedir()]
        .filter(Boolean)
        .map((folder) => path.resolve(folder))
        .sort((a, b) => b.length - a.length);
    const scrub = (text) => privateFolders().reduce((out, folder) => out.split(folder).join("[server]"), String(text));

    async function prerequisites() {
        if (checked && Date.now() - checked.at < CHECK_CACHE_MS) return checked;
        const problems = [];
        const warnings = [];
        let report = null;
        if (config.hosted) {
            problems.push("Presentation import runs on a local copy of the app for now. This deployment has no Python and cannot store imported images; that arrives with the object-storage work.");
        } else {
            try {
                report = await tools.check();
            } catch (error) {
                console.error("Presentation import prerequisite check failed:", error);
                problems.push("The server needs Python 3.8 or newer to read presentations. Install it, or set PPTX_IMPORT_PYTHON to its path, and restart the API.");
            }
            if (report) {
                if (!report.pillow) {
                    warnings.push("Pillow is not installed for the server's Python (pip install pillow), so label line breaks are estimated and every label is flagged for review.");
                } else if (!report.labelFonts || !report.labelFonts.regular) {
                    warnings.push("Calibri or Carlito is not installed on the server, so label line breaks are estimated and every label is flagged for review.");
                }
                try {
                    fs.mkdirSync(report.importDir, { recursive: true });
                    fs.accessSync(report.importDir, fs.constants.W_OK);
                } catch (error) {
                    console.error("Presentation import folder is not writable:", error);
                    problems.push("The server cannot write to its import folder. Check DBB_PPTX_IMPORT_DIR and its permissions.");
                }
            }
            try {
                fs.accessSync(imagesDir, fs.constants.W_OK);
            } catch (error) {
                console.error("Images folder is not writable:", error);
                problems.push("The server cannot write to its images folder, where imported images are stored.");
            }
        }
        checked = { at: Date.now(), problems, warnings, report };
        return checked;
    }

    function accessFor(req) {
        if (config.token) {
            const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
            const allowed = Boolean(match) && sameSecret(match[1].trim(), config.token);
            return { mode: "key", allowed, message: allowed ? null : "Enter this server's import key to import presentations." };
        }
        const origin = req.get("origin");
        let originOk = true;
        if (origin) {
            try {
                const url = new URL(origin);
                originOk = isLoopbackHost(url.hostname) || url.host === req.get("host");
            } catch {
                originOk = false;
            }
        }
        const allowed = isLoopback(req.socket && req.socket.remoteAddress) && !req.get("x-forwarded-for") && originOk;
        return {
            mode: "local",
            allowed,
            message: allowed ? null : "Presentation import only works on the computer that runs the app's API. To allow it from other computers, the server admin sets SCENE_IMPORT_TOKEN.",
        };
    }

    function requireAccess(req, res, next) {
        const access = accessFor(req);
        if (access.allowed) return next();
        return res.status(access.mode === "key" ? 401 : 403).json({ error: access.message });
    }

    async function knownDecks() {
        const decks = new Map();
        let scenes = [];
        try {
            scenes = await store.list();
        } catch {
            return [];
        }
        for (const scene of scenes) {
            const entry = lastPptxImport(scene);
            if (!entry || !entry.deck || !entry.deck.key) continue;
            const deck = decks.get(entry.deck.key) || { deckKey: entry.deck.key, deckFile: entry.deck.file || null, scenes: 0 };
            deck.scenes += 1;
            decks.set(entry.deck.key, deck);
        }
        return [...decks.values()].sort((a, b) => a.deckKey.localeCompare(b.deckKey));
    }

    /** How many imports must finish before a queued one starts. */
    function positionOf(job) {
        if (job.state !== "queued") return 0;
        let ahead = 0;
        for (const other of jobs.values()) {
            if (other === job) break;
            if (other.state === "queued" || other.state === "running") ahead += 1;
        }
        return ahead;
    }

    function pruneJobs() {
        const cutoff = Date.now() - JOB_TTL_MS;
        for (const [id, job] of jobs) {
            if (FINISHED.has(job.state) && Date.parse(job.finishedAt) < cutoff) jobs.delete(id);
        }
        const finished = [...jobs.values()].filter((job) => FINISHED.has(job.state));
        for (const job of finished.slice(0, Math.max(0, jobs.size - MAX_JOBS_KEPT))) jobs.delete(job.id);
    }

    async function runJob(job, obtainDeck) {
        job.state = "running";
        job.startedAt = new Date().toISOString();
        let jobDir = null;
        try {
            const { report, problems } = await prerequisites();
            if (problems.length || !report) throw new ImportError(503, problems[0] || "Presentation import is not available on this server right now.");
            jobDir = path.join(report.importDir, JOB_FOLDER, job.id);
            const { bytes, fileName } = await obtainDeck(job);
            if (fileName) job.source.name = fileName;
            checkPresentationBytes(bytes, config.maxBytes);
            const deckPath = path.join(jobDir, "deck", job.source.name);
            fs.mkdirSync(path.dirname(deckPath), { recursive: true });
            fs.writeFileSync(deckPath, bytes, { flag: "wx" });

            job.phase = "reading";
            job.progress = null;
            const irPath = await tools.extract({
                deckPath,
                outDir: path.join(jobDir, "ir"),
                deckKey: job.deckKey,
                slides: job.slides,
                onProgress: ({ done, total }) => {
                    job.progress = { done, total };
                },
                onWarning: (warning) => {
                    if (!job.warnings.includes(warning)) job.warnings.push(warning);
                },
            });

            job.phase = "checking";
            job.progress = null;
            const outcome = await importIr({
                irPath,
                store,
                imagesDir,
                dryRun: job.dryRun,
                force: false,
                report: false,
                onProgress: ({ phase, done, total }) => {
                    job.phase = phase;
                    job.progress = { done, total };
                },
            });
            job.results = outcome.results.map(publicResult).map((r) => ({ ...r, action: scrub(r.action) }));
            job.summary = outcome.summary;
            job.state = { finished: "succeeded", "dry-run": "checked", stopped: "stopped" }[outcome.status];
        } catch (error) {
            if (!(error instanceof ImportError)) console.error(`Presentation import ${job.id} failed:`, error);
            job.state = "failed";
            job.error = scrub(error instanceof ImportError
                ? error.message
                : "The import failed on the server. Nothing more was saved after the failure; the server log has the details.");
        } finally {
            job.phase = "done";
            job.finishedAt = new Date().toISOString();
            if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true });
        }
    }

    function startJob({ source, deckKey, slides, dryRun }, obtainDeck) {
        pruneJobs();
        const waiting = [...jobs.values()].filter((job) => job.state === "queued" || job.state === "running").length;
        if (waiting >= MAX_QUEUED) throw new ImportError(429, "Several imports are already waiting. Try again when they finish.");
        const job = {
            id: crypto.randomUUID(),
            state: "queued",
            phase: "queued",
            progress: null,
            source,
            deckKey,
            slides,
            dryRun,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            summary: null,
            warnings: [],
            error: null,
            results: [],
        };
        jobs.set(job.id, job);
        queue = queue.then(() => runJob(job, obtainDeck)).catch((error) => console.error("Presentation import queue:", error));
        job.done = queue;
        return job;
    }

    async function commonOptions(input, fallbackKey) {
        const { problems } = await prerequisites();
        if (problems.length) throw new ImportError(503, problems[0]);
        const deckKey = String(input.deckKey || "").trim() || fallbackKey;
        if (!DECK_KEY.test(deckKey)) {
            throw new ImportError(400, "The deck key may only use letters, digits, \".\", \"_\" and \"-\", must start with a letter or digit, and can be up to 128 characters.");
        }
        let slides = null;
        const spec = String(input.slides || "").trim();
        if (spec) {
            try {
                parseSlides(spec);
            } catch {
                throw new ImportError(400, "Slides must be numbers and ranges, such as 2-7, 9.");
            }
            slides = spec.replace(/\s+/g, "");
        }
        const dryRun = ["1", "true", "yes", true].includes(input.dryRun);
        return { deckKey, slides, dryRun };
    }

    const router = express.Router();
    // At most 30 imports started per 10 minutes from one connection address.
    const startLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => (req.socket && req.socket.remoteAddress) || "unknown",
    });

    router.get("/", async (req, res) => {
        const { problems, warnings } = await prerequisites();
        const access = accessFor(req);
        res.json({
            available: problems.length === 0,
            problems,
            warnings,
            access: { mode: access.mode, allowed: access.allowed, message: access.message },
            limits: { maxBytes: config.maxBytes, extensions: [".pptx"] },
            sources: ["pptx", "google-slides"],
            knownDecks: access.allowed ? await knownDecks() : [],
        });
    });

    router.post("/pptx", requireAccess, startLimiter, express.raw({ type: () => true, limit: config.maxBytes }), async (req, res, next) => {
        try {
            let given = "";
            try {
                given = decodeURIComponent(req.get("x-file-name") || "");
            } catch {
                given = "";
            }
            if (given && !/\.pptx$/i.test(given)) throw new ImportError(415, "Choose a PowerPoint .pptx file. Older .ppt files and other formats can't be imported.");
            const options = await commonOptions(req.query, deckKeyFromName(given) || "presentation");
            const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            checkPresentationBytes(bytes, config.maxBytes);
            const job = startJob({ ...options, source: { type: "pptx", name: safeFileName(given) } }, async () => ({ bytes }));
            res.status(202).json({ job: publicJob(job, positionOf(job)) });
        } catch (error) {
            next(error);
        }
    });

    router.post("/google-slides", requireAccess, startLimiter, express.json({ limit: "16kb" }), async (req, res, next) => {
        try {
            const body = req.body || {};
            const id = parseGoogleSlidesId(body.source);
            if (!id) throw new ImportError(400, "Paste a Google Slides link (https://docs.google.com/presentation/d/...) or the presentation's id.");
            const options = await commonOptions(body, `gslides-${id}`.slice(0, 128));
            const job = startJob({ ...options, source: { type: "google-slides", name: `Google Slides ${id.slice(0, 8)}...` } }, async (current) => {
                current.phase = "downloading";
                return downloadGoogleSlides(id, { fetchImpl, maxBytes: config.maxBytes });
            });
            res.status(202).json({ job: publicJob(job, positionOf(job)) });
        } catch (error) {
            next(error);
        }
    });

    router.get("/jobs/:id", requireAccess, (req, res) => {
        const job = jobs.get(req.params.id);
        if (!job) return res.status(404).json({ error: "That import is not known here. Imports are kept for an hour after they finish." });
        return res.json({ job: publicJob(job, positionOf(job)) });
    });

    // Express treats a four-argument handler as the error handler, so `next` stays in the list.
    router.use((error, req, res, next) => {
        if (error instanceof ImportError) return res.status(error.status).json({ error: error.message });
        if (error && error.type === "entity.too.large") {
            return res.status(413).json({ error: `The presentation is larger than the ${megabytes(config.maxBytes)} limit.` });
        }
        if (error && error.type === "entity.parse.failed") return res.status(400).json({ error: "The request was not valid JSON." });
        console.error("Presentation import request failed:", error);
        return res.status(500).json({ error: "The import could not be started. The server log has the details." });
    });

    router.jobs = jobs; // for tests: lets them await a job's completion
    return router;
}

module.exports = {
    createPresentationImportRouter,
    createPythonExtractor,
    parseGoogleSlidesId,
    deckKeyFromName,
    safeFileName,
    fileNameFromDisposition,
    checkPresentationBytes,
    PPTX_CONTENT_TYPE,
};
