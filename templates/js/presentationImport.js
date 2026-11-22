// Import presentation (Issue #540): turns a PowerPoint (.pptx) file or a
// shared Google Slides presentation into draft scenes from the Scene Editor.
//
// The browser only checks what it can (file type and size, the link, the deck
// key and the slide list) and then hands the presentation to the server
// (/api/scene-imports), which runs the same import pipeline as the command
// line. The import runs as a job on the server; this panel polls it, shows
// progress, then shows what happened to every slide. An import key, when the
// server asks for one, is kept in memory for this page only.
import { OPEN_SCENE_EVENT, SCENES_CHANGED_EVENT } from "./sceneLinks.js";

const IMPORTS_URL = "/api/scene-imports";
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DECK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLIDES = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;
const GOOGLE_SLIDES_ID = /^[A-Za-z0-9_-]{20,128}$/;
const FINISHED = new Set(["succeeded", "checked", "stopped", "failed"]);
const SAVED_OUTCOMES = new Set(["created", "updated", "replaced"]);
const OPENABLE_OUTCOMES = new Set(["created", "updated", "unchanged", "kept", "replaced"]);
const POLL_FAILURES_BEFORE_GIVING_UP = 3;

const megabytes = (bytes) => {
    if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} bytes`;
};
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// What each phase of a job means, and the part of the bar it fills.
const PHASES = {
    uploading: { label: () => "Uploading the presentation…", from: 0, to: 0 },
    queued: { label: (p, job) => (job && job.position > 0 ? `Waiting for ${plural(job.position, "other import")} to finish…` : "Starting the import…"), from: 0, to: 0 },
    running: { label: () => "Starting…", from: 0, to: 0 },
    downloading: { label: () => "Downloading the presentation from Google Slides…", from: 0, to: 5 },
    reading: { label: (p) => (p ? `Reading slides: ${p.done} of ${p.total}` : "Reading the presentation…"), from: 5, to: 60 },
    checking: { label: (p) => (p ? `Checking slides: ${p.done} of ${p.total}` : "Checking slides…"), from: 60, to: 75 },
    "copying-images": { label: (p) => `Copying images: ${p.done} of ${p.total}`, from: 75, to: 85 },
    saving: { label: (p) => `Saving scenes: ${p.done} of ${p.total}`, from: 85, to: 100 },
    done: { label: () => "Finishing…", from: 100, to: 100 },
};

const OUTCOME_TEXT = {
    created: "Created",
    updated: "Updated",
    unchanged: "Unchanged",
    kept: "Kept (edited since its last import)",
    replaced: "Replaced",
    rejected: "Rejected",
    "not-saved": "Not saved",
    "no-figure": "No figure on this slide",
    skipped: "Skipped",
    failed: "Failed",
    "dry-run": "Check only",
};

const MAX_FILE_NAME_CHARS = 255;
const MAX_DECK_KEY_CHARS = 128;
const isKeyCharacter = (ch) => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");

/**
 * A deck key from a file name, the way the server and pptx_ir.py derive one:
 * the name without its extension, lower-cased, each run of other characters
 * turned into one "-", no "-" at either end, at most 128 characters. One pass
 * over the last 255 characters at most.
 */
export function deckKeyFromFileName(name) {
    const text = String(name || "").slice(-MAX_FILE_NAME_CHARS); // the end holds the name and extension
    const dot = text.lastIndexOf(".");
    const stem = (dot >= 0 ? text.slice(0, dot) : text).toLowerCase();
    let key = "";
    let gap = false;
    for (const ch of stem) {
        if (!isKeyCharacter(ch)) {
            gap = true;
            continue;
        }
        const piece = gap && key ? `-${ch}` : ch;
        if (key.length + piece.length > MAX_DECK_KEY_CHARS) break;
        key += piece;
        gap = false;
    }
    return key;
}

/** The presentation id in a Google Slides link (or the id itself), or null. */
export function googleSlidesIdFrom(text) {
    const value = String(text || "").trim();
    if (GOOGLE_SLIDES_ID.test(value)) return value;
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
    const match = /^\/presentation(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname);
    return match && GOOGLE_SLIDES_ID.test(match[1]) ? match[1] : null;
}

/** Progress text and percentage for a job. */
export function describeProgress(job) {
    const phase = PHASES[job.phase] || PHASES[job.state] || PHASES.running;
    const progress = job.progress && job.progress.total ? job.progress : null;
    const share = progress ? progress.done / progress.total : 0;
    return { label: phase.label(progress, job), percent: Math.round(phase.from + (phase.to - phase.from) * share) };
}

/**
 * @param {Document} [root]
 * @param {{ fetchImpl?: typeof fetch, pollMs?: number }} [options]
 */
export function initializePresentationImport(root = document, { fetchImpl = (...args) => fetch(...args), pollMs = 1000 } = {}) {
    const $ = (id) => root.getElementById(id);
    const dom = {
        open: $("presentation-import-open"),
        panel: $("presentation-import"),
        heading: $("presentation-import-heading"),
        close: $("presentation-import-close"),
        checking: $("presentation-import-checking"),
        unavailable: $("presentation-import-unavailable"),
        problems: $("presentation-import-problems"),
        recheck: $("presentation-import-recheck"),
        warnings: $("presentation-import-warnings"),
        warningList: $("presentation-import-warning-list"),
        form: $("presentation-import-form"),
        fileField: $("presentation-import-file-field"),
        file: $("presentation-import-file"),
        fileHelp: $("presentation-import-file-help"),
        fileError: $("presentation-import-file-error"),
        linkField: $("presentation-import-link-field"),
        link: $("presentation-import-link"),
        linkError: $("presentation-import-link-error"),
        deckKey: $("presentation-import-deck-key"),
        deckKeys: $("presentation-import-deck-keys"),
        deckKeyError: $("presentation-import-deck-key-error"),
        slides: $("presentation-import-slides"),
        slidesError: $("presentation-import-slides-error"),
        keyField: $("presentation-import-key-field"),
        key: $("presentation-import-key"),
        keyError: $("presentation-import-key-error"),
        dryRun: $("presentation-import-dry-run"),
        formError: $("presentation-import-form-error"),
        submit: $("presentation-import-submit"),
        progress: $("presentation-import-progress"),
        progressLabel: $("presentation-import-progress-label"),
        progressBar: $("presentation-import-progress-bar"),
        pollRetry: $("presentation-import-poll-retry"),
        result: $("presentation-import-result"),
        resultHeading: $("presentation-import-result-heading"),
        summary: $("presentation-import-summary"),
        resultWarnings: $("presentation-import-result-warnings"),
        table: $("presentation-import-table"),
        rows: $("presentation-import-rows"),
        again: $("presentation-import-again"),
    };
    if (!dom.open || !dom.panel) return null;

    const state = { capabilities: null, deckKeyEdited: false, job: null, polling: false, busy: false };
    const sourceInputs = [...dom.form.querySelectorAll("input[name='presentation-import-source']")];
    const source = () => (sourceInputs.find((input) => input.checked) || sourceInputs[0]).value;
    const keyRequired = () => Boolean(state.capabilities && state.capabilities.access.mode === "key");

    function headers(extra = {}) {
        const out = { ...extra };
        if (keyRequired() && dom.key.value.trim()) out.Authorization = `Bearer ${dom.key.value.trim()}`;
        return out;
    }

    async function call(path, options = {}) {
        let response;
        try {
            response = await fetchImpl(`${IMPORTS_URL}${path}`, { ...options, headers: headers(options.headers) });
        } catch {
            return { ok: false, status: 0, body: { error: "The app's API could not be reached. Check that it is running, then try again." } };
        }
        let body = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        return { ok: response.ok, status: response.status, body: body || {} };
    }

    function setError(element, input, message) {
        element.textContent = message || "";
        element.hidden = !message;
        if (input) {
            if (message) input.setAttribute("aria-invalid", "true");
            else input.removeAttribute("aria-invalid");
        }
    }

    function fillList(list, items) {
        list.replaceChildren(...items.map((text) => {
            const li = root.createElement("li");
            li.textContent = text;
            return li;
        }));
    }

    // ---------------------------------------------------------- opening and prerequisites

    async function loadCapabilities() {
        dom.checking.hidden = false;
        dom.unavailable.hidden = true;
        dom.warnings.hidden = true;
        dom.form.hidden = true;
        const { ok, body } = await call("");
        dom.checking.hidden = true;
        if (!ok) {
            state.capabilities = null;
            fillList(dom.problems, [body.error || "The server could not say whether it can import presentations."]);
            dom.unavailable.hidden = false;
            return;
        }
        state.capabilities = body;
        const problems = [...body.problems];
        if (body.access.mode === "local" && !body.access.allowed) problems.push(body.access.message);
        if (problems.length) {
            fillList(dom.problems, problems);
            dom.unavailable.hidden = false;
            return;
        }
        if (body.warnings.length) {
            fillList(dom.warningList, body.warnings);
            dom.warnings.hidden = false;
        }
        dom.fileHelp.textContent = `A .pptx file up to ${megabytes(body.limits.maxBytes)}.`;
        dom.keyField.hidden = body.access.mode !== "key";
        dom.deckKeys.replaceChildren(...body.knownDecks.map((deck) => {
            const option = root.createElement("option");
            option.value = deck.deckKey;
            option.label = `${deck.deckFile || deck.deckKey} (${plural(deck.scenes, "scene")})`;
            return option;
        }));
        dom.form.hidden = Boolean(state.busy);
    }

    function openPanel() {
        dom.panel.hidden = false;
        dom.open.setAttribute("aria-expanded", "true");
        dom.heading.focus();
        if (!state.busy) void loadCapabilities();
    }

    function closePanel() {
        dom.panel.hidden = true;
        dom.open.setAttribute("aria-expanded", "false");
        dom.open.focus();
    }

    // ---------------------------------------------------------- the form

    function showSource() {
        const google = source() === "google-slides";
        dom.fileField.hidden = google;
        dom.linkField.hidden = !google;
        setError(dom.formError, null, "");
        suggestDeckKey();
    }

    function suggestDeckKey() {
        if (state.deckKeyEdited) return;
        if (source() === "pptx") {
            const file = dom.file.files && dom.file.files[0];
            dom.deckKey.value = file ? deckKeyFromFileName(file.name) : "";
        } else {
            const id = googleSlidesIdFrom(dom.link.value);
            dom.deckKey.value = id ? `gslides-${id}`.slice(0, 128) : "";
        }
    }

    function checkFile() {
        const file = dom.file.files && dom.file.files[0];
        const maxBytes = state.capabilities ? state.capabilities.limits.maxBytes : Infinity;
        let message = "";
        if (!file) message = "Choose a .pptx file to import.";
        else if (!/\.pptx$/i.test(file.name)) message = "Choose a PowerPoint .pptx file. Older .ppt files and other formats can't be imported.";
        else if (file.size === 0) message = "This file is empty.";
        else if (file.size > maxBytes) message = `This file is ${megabytes(file.size)}; the limit is ${megabytes(maxBytes)}.`;
        setError(dom.fileError, dom.file, message);
        return !message;
    }

    function checkLink() {
        const message = googleSlidesIdFrom(dom.link.value) ? "" : "Paste a Google Slides link (https://docs.google.com/presentation/d/...) or the presentation's id.";
        setError(dom.linkError, dom.link, message);
        return !message;
    }

    function checkForm() {
        const sourceOk = source() === "pptx" ? checkFile() : checkLink();
        const key = dom.deckKey.value.trim();
        const keyMessage = !key ? "Enter a deck key." : DECK_KEY.test(key) ? ""
            : "Use letters, digits, \".\", \"_\" and \"-\", starting with a letter or digit (up to 128 characters).";
        setError(dom.deckKeyError, dom.deckKey, keyMessage);
        const slides = dom.slides.value.trim();
        const slidesMessage = !slides || SLIDES.test(slides) ? "" : "Use slide numbers and ranges, such as 2-7, 9.";
        setError(dom.slidesError, dom.slides, slidesMessage);
        const accessMessage = keyRequired() && !dom.key.value.trim() ? "Enter the import key." : "";
        setError(dom.keyError, dom.key, accessMessage);
        const firstInvalid = dom.form.querySelector("[aria-invalid='true']");
        if (firstInvalid) firstInvalid.focus();
        return sourceOk && !keyMessage && !slidesMessage && !accessMessage;
    }

    async function startImport() {
        const options = { deckKey: dom.deckKey.value.trim(), slides: dom.slides.value.trim(), dryRun: dom.dryRun.checked };
        if (source() === "pptx") {
            const file = dom.file.files[0];
            const query = new URLSearchParams({ deckKey: options.deckKey });
            if (options.slides) query.set("slides", options.slides);
            if (options.dryRun) query.set("dryRun", "1");
            return call(`/pptx?${query}`, {
                method: "POST",
                headers: { "Content-Type": PPTX_TYPE, "X-File-Name": encodeURIComponent(file.name) },
                body: file,
            });
        }
        return call("/google-slides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: dom.link.value.trim(), ...options }),
        });
    }

    async function handleSubmit(event) {
        event.preventDefault();
        setError(dom.formError, null, "");
        if (state.busy || !checkForm()) return;
        setBusy(true);
        dom.form.hidden = true;
        showProgress({ phase: "uploading", state: "queued" });
        const { ok, status, body } = await startImport();
        if (!ok) {
            setBusy(false);
            dom.progress.hidden = true;
            dom.form.hidden = false;
            if (status === 401) {
                setError(dom.keyError, dom.key, body.error || "The import key was not accepted.");
                dom.key.focus();
            } else {
                setError(dom.formError, null, body.error || `The import could not be started (HTTP ${status}).`);
            }
            return;
        }
        state.job = body.job;
        await poll();
    }

    // ---------------------------------------------------------- progress

    function setBusy(busy) {
        state.busy = busy;
        dom.submit.disabled = busy;
    }

    function showProgress(job) {
        const { label, percent } = describeProgress(job);
        dom.result.hidden = true;
        dom.progress.hidden = false;
        dom.pollRetry.hidden = true;
        dom.progressLabel.textContent = label;
        dom.progressBar.value = percent;
    }

    async function poll() {
        state.polling = true;
        let failures = 0;
        let first = true;
        while (state.job && !FINISHED.has(state.job.state)) {
            showProgress(state.job);
            await new Promise((resolve) => setTimeout(resolve, first ? Math.min(pollMs, 250) : pollMs));
            first = false;
            const { ok, status, body } = await call(`/jobs/${encodeURIComponent(state.job.id)}`);
            if (ok) {
                failures = 0;
                state.job = body.job;
                continue;
            }
            failures += 1;
            if (status === 404 || status === 401 || status === 403 || failures >= POLL_FAILURES_BEFORE_GIVING_UP) {
                state.polling = false;
                dom.progressLabel.textContent = status === 404
                    ? "The server no longer knows this import; it may have restarted. Check the scene list to see what was saved."
                    : `Lost contact with the import: ${body.error || "the server did not answer"}. It may still be running on the server.`;
                dom.pollRetry.hidden = status === 404;
                if (status === 404) {
                    setBusy(false);
                    dom.form.hidden = false;
                }
                return;
            }
        }
        state.polling = false;
        setBusy(false);
        showResult(state.job);
    }

    // ---------------------------------------------------------- results

    function resultHeading(job) {
        if (job.state === "succeeded") return "Import finished";
        if (job.state === "checked") return "Check finished: nothing was saved";
        if (job.state === "stopped") return "Import stopped";
        return "Import failed";
    }

    function detailsFor(result) {
        const items = [
            ...result.flagged.map((f) => `Needs review: ${f.type} "${f.name}": ${f.reasons.join("; ")}`),
            ...result.skipped.map((s) => `Left out: ${s.reason}${s.detail ? ` ("${s.detail}")` : ""}`),
            ...result.notes.map((n) => `Note: "${n.name}": ${n.note}`),
        ];
        if (!items.length) return null;
        const details = root.createElement("details");
        const summary = root.createElement("summary");
        summary.textContent = "Details";
        const list = root.createElement("ul");
        list.replaceChildren(...items.map((text) => {
            const li = root.createElement("li");
            li.textContent = text;
            return li;
        }));
        details.append(summary, list);
        return details;
    }

    function rowFor(result) {
        const row = root.createElement("tr");
        row.dataset.outcome = result.outcome;
        const cell = (content) => {
            const td = root.createElement("td");
            if (content instanceof Node) td.append(content);
            else td.textContent = content;
            row.append(td);
            return td;
        };
        cell(String(result.slide));
        const sceneCell = cell(result.sceneName || "-");
        if (result.sceneId && OPENABLE_OUTCOMES.has(result.outcome)) {
            const button = root.createElement("button");
            button.type = "button";
            button.className = "scene-btn scene-btn-secondary presentation-import-open-scene";
            button.textContent = "Open";
            button.setAttribute("aria-label", `Open "${result.sceneName}"`);
            button.addEventListener("click", () => {
                root.dispatchEvent(new CustomEvent(OPEN_SCENE_EVENT, { detail: { sceneId: result.sceneId } }));
            });
            sceneCell.append(" ", button);
        }
        const actionCell = cell(OUTCOME_TEXT[result.outcome] || result.outcome);
        if (["rejected", "failed", "skipped", "not-saved", "dry-run"].includes(result.outcome)) {
            const reason = result.action.replace(/^[^:]*:\s*/, "");
            if (reason && reason !== result.action) {
                const why = root.createElement("span");
                why.className = "presentation-import-reason";
                why.textContent = reason;
                actionCell.append(root.createElement("br"), why);
            }
        }
        const details = detailsFor(result);
        if (details) actionCell.append(details);
        const counts = result.counts || {};
        for (const value of [counts.images, counts.labels, counts.pointerLines, counts.regions, counts.flagged, counts.skipped]) {
            cell(value === undefined ? "-" : String(value));
        }
        return row;
    }

    function showResult(job) {
        dom.progress.hidden = true;
        dom.result.hidden = false;
        dom.result.dataset.state = job.state;
        dom.resultHeading.textContent = resultHeading(job);
        // The heading already says how it ended, so drop the summary's own "Import finished:" style lead.
        dom.summary.textContent = job.state === "failed" ? job.error : String(job.summary || "").replace(/^[^:]{1,40}:\s*/, "");
        fillList(dom.resultWarnings, job.warnings || []);
        dom.resultWarnings.hidden = !(job.warnings && job.warnings.length);
        dom.rows.replaceChildren(...job.results.map((result) => rowFor(result)));
        dom.table.hidden = job.results.length === 0;
        dom.resultHeading.focus();
        if (job.results.some((r) => SAVED_OUTCOMES.has(r.outcome))) {
            root.dispatchEvent(new CustomEvent(SCENES_CHANGED_EVENT, { detail: { reason: "presentation-import" } }));
        }
    }

    function resetForAnother() {
        dom.result.hidden = true;
        state.job = null;
        state.deckKeyEdited = false;
        dom.file.value = "";
        dom.link.value = "";
        dom.deckKey.value = "";
        dom.slides.value = "";
        dom.dryRun.checked = false;
        void loadCapabilities();
        dom.heading.focus();
    }

    // ---------------------------------------------------------- wiring

    dom.open.addEventListener("click", () => (dom.panel.hidden ? openPanel() : closePanel()));
    dom.close.addEventListener("click", closePanel);
    dom.recheck.addEventListener("click", () => void loadCapabilities());
    sourceInputs.forEach((input) => input.addEventListener("change", showSource));
    dom.file.addEventListener("change", () => {
        checkFile();
        suggestDeckKey();
    });
    dom.link.addEventListener("input", () => {
        setError(dom.linkError, dom.link, "");
        suggestDeckKey();
    });
    dom.deckKey.addEventListener("input", () => {
        state.deckKeyEdited = dom.deckKey.value.trim() !== "";
    });
    dom.form.addEventListener("submit", handleSubmit);
    dom.pollRetry.addEventListener("click", () => {
        if (!state.polling) void poll();
    });
    dom.again.addEventListener("click", resetForAnother);

    return { open: openPanel, close: closePanel, state };
}

if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => initializePresentationImport());
}
