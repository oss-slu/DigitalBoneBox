// The Scene Editor's "Import presentation" panel (Issue #540), against an
// in-memory stand-in for /api/scene-imports and /api/scenes.
const fs = require("fs");
const path = require("path");

const pageHtml = fs.readFileSync(path.join(__dirname, "..", "boneset.html"), "utf8");
const bodyHtml = pageHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, "");
const GOOGLE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab";
const NOW = "2026-11-22T00:00:00.000Z";

const $ = (id) => document.getElementById(id);
const click = (id) => $(id).click();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(check, tries = 200) {
    let last;
    for (let i = 0; i < tries; i += 1) {
        try {
            return check();
        } catch (error) {
            last = error;
            await flush();
        }
    }
    throw last;
}

function result(slide, outcome, extra = {}) {
    const actions = {
        created: "created", updated: "updated", unchanged: "unchanged", "no-figure": "no figure",
        rejected: "rejected: a scene named \"Ilium (slide 3)\" already exists (scene-9)", "not-saved": "not saved: 1 slide(s) rejected",
        "dry-run": "dry run: would create",
    };
    return {
        slide,
        sceneId: outcome === "no-figure" ? null : `scene-${slide}`,
        sceneName: outcome === "no-figure" ? null : `Ilium (slide ${slide})`,
        outcome,
        action: actions[outcome],
        counts: { images: 2, labels: 5, pointerLines: 4, regions: 1, flagged: 1, skipped: 2 },
        flagged: [{ type: "label", name: "TextBox 7", reasons: ["sits over two photos"] }],
        skipped: [{ reason: "title", detail: "Ilium" }],
        notes: [],
        ...extra,
    };
}

/**
 * Stand-in for the server. `jobScript` is the sequence of job states the
 * server reports while polling; the last one is the finished job.
 */
function createFakeBackend({ capabilities = {}, start = null, jobScript = null, scenes = [] } = {}) {
    const calls = [];
    const state = { polls: 0, pollFailures: 0 };
    const caps = {
        available: true,
        problems: [],
        warnings: [],
        access: { mode: "local", allowed: true, message: null },
        limits: { maxBytes: 50 * 1024 * 1024, extensions: [".pptx"] },
        sources: ["pptx", "google-slides"],
        knownDecks: [{ deckKey: "bone-project-2", deckFile: "Bone Project 2.0.pptx", scenes: 232 }],
        ...capabilities,
    };
    const script = jobScript || [
        { state: "queued", phase: "queued", position: 0, progress: null },
        { state: "running", phase: "reading", progress: { done: 2, total: 3 } },
        {
            state: "succeeded", phase: "done", progress: { done: 3, total: 3 },
            summary: "Import finished: 2 scene(s) saved, 3 image(s) copied.",
            results: [result(1, "no-figure"), result(2, "created"), result(3, "unchanged")],
        },
    ];
    const job = (i) => ({ id: "job-1", deckKey: "ilium", dryRun: false, warnings: [], error: null, results: [], summary: null, ...script[Math.min(i, script.length - 1)] });
    const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
    const fetch = jest.fn(async (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        calls.push({ method, url, headers: options.headers || {}, body: options.body });
        if (url === "/api/scene-imports" && method === "GET") return respond(200, caps);
        if (url.startsWith("/api/scene-imports/pptx") || url === "/api/scene-imports/google-slides") {
            if (start) return respond(start.status, start.body);
            return respond(202, { job: job(0) });
        }
        if (url === "/api/scene-imports/jobs/job-1") {
            if (state.pollFailures > 0) {
                state.pollFailures -= 1;
                throw new TypeError("Failed to fetch");
            }
            state.polls += 1;
            return respond(200, { job: job(state.polls) });
        }
        if (url.startsWith("/api/scenes")) {
            const match = url.match(/^\/api\/scenes\/?([^/?]*)/);
            if (!match[1]) return respond(200, { scenes: scenes.map((s) => ({ ...s, status: "draft", imageCount: 0, annotationCount: 0, sources: [] })) });
            const scene = scenes.find((s) => s.id === decodeURIComponent(match[1]));
            return scene ? respond(200, { status: "draft", images: [], annotations: [], ...scene }) : respond(404, { error: "Scene not found" });
        }
        return respond(404, { error: "Not found" });
    });
    return { fetch, calls, state, caps };
}

function chooseFile(name, content = "PK\u0003\u0004 ppt/presentation.xml") {
    const file = new File([content], name, { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    Object.defineProperty($("presentation-import-file"), "files", { value: [file], configurable: true });
    $("presentation-import-file").dispatchEvent(new Event("change"));
    return file;
}

function useSource(value) {
    const input = document.querySelector(`input[name='presentation-import-source'][value='${value}']`);
    input.checked = true;
    input.dispatchEvent(new Event("change"));
}

const submit = () => $("presentation-import-form").dispatchEvent(new Event("submit", { cancelable: true }));
const rows = () => [...document.querySelectorAll("#presentation-import-rows > tr")];
const importCalls = (backend) => backend.calls.filter((c) => c.method === "POST");

let backend;
let panel;

function setUp(options) {
    document.body.innerHTML = bodyHtml;
    backend = createFakeBackend(options);
    global.fetch = backend.fetch;
    jest.resetModules();
    const { initializePresentationImport } = require("../js/presentationImport.js");
    panel = initializePresentationImport(document, { fetchImpl: backend.fetch, pollMs: 0 });
}

async function openPanel() {
    click("presentation-import-open");
    await waitFor(() => expect($("presentation-import-checking").hidden).toBe(true));
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe("opening the panel", () => {
    test("shows the form, the size limit and decks imported before when import is available", async () => {
        setUp();
        expect($("presentation-import").hidden).toBe(true);
        await openPanel();
        expect($("presentation-import").hidden).toBe(false);
        expect($("presentation-import-open").getAttribute("aria-expanded")).toBe("true");
        expect($("presentation-import-form").hidden).toBe(false);
        expect($("presentation-import-unavailable").hidden).toBe(true);
        expect($("presentation-import-file-help").textContent).toBe("A .pptx file up to 50 MB.");
        expect($("presentation-import-key-field").hidden).toBe(true);
        const option = document.querySelector("#presentation-import-deck-keys option");
        expect(option.value).toBe("bone-project-2");
        expect(option.label).toBe("Bone Project 2.0.pptx (232 scenes)");
    });

    test("explains why import is unavailable and can check again", async () => {
        setUp({ capabilities: { available: false, problems: ["The server needs Python 3.8 or newer to read presentations."] } });
        await openPanel();
        expect($("presentation-import-unavailable").hidden).toBe(false);
        expect($("presentation-import-problems").textContent).toContain("Python 3.8");
        expect($("presentation-import-form").hidden).toBe(true);
        backend.caps.available = true;
        backend.caps.problems = [];
        click("presentation-import-recheck");
        await waitFor(() => expect($("presentation-import-form").hidden).toBe(false));
    });

    test("says when this computer is not allowed to import", async () => {
        setUp({ capabilities: { access: { mode: "local", allowed: false, message: "Presentation import only works on the computer that runs the app's API." } } });
        await openPanel();
        expect($("presentation-import-problems").textContent).toContain("only works on the computer");
        expect($("presentation-import-form").hidden).toBe(true);
    });

    test("shows server warnings, such as label fonts that are missing", async () => {
        setUp({ capabilities: { warnings: ["Pillow is not installed for the server's Python."] } });
        await openPanel();
        expect($("presentation-import-warnings").hidden).toBe(false);
        expect($("presentation-import-warning-list").textContent).toContain("Pillow");
    });

    test("closing hides the panel and returns focus to the button", async () => {
        setUp();
        await openPanel();
        click("presentation-import-close");
        expect($("presentation-import").hidden).toBe(true);
        expect(document.activeElement).toBe($("presentation-import-open"));
    });
});

describe("checks in the browser before anything is sent", () => {
    test.each([
        ["no file", null, /Choose a \.pptx file/],
        ["a .ppt file", "old.ppt", /Older \.ppt files/],
        ["a .docx file", "notes.docx", /Choose a PowerPoint \.pptx file/],
        ["an empty file", ["empty.pptx", ""], /This file is empty/],
    ])("%s is refused", async (_label, file, message) => {
        setUp();
        await openPanel();
        if (Array.isArray(file)) chooseFile(file[0], file[1]);
        else if (file) chooseFile(file);
        $("presentation-import-deck-key").value = "deck";
        submit();
        await flush();
        expect($("presentation-import-file-error").hidden).toBe(false);
        expect($("presentation-import-file-error").textContent).toMatch(message);
        expect(importCalls(backend)).toEqual([]);
    });

    test("a file over the server's limit is refused with both sizes", async () => {
        setUp({ capabilities: { limits: { maxBytes: 10, extensions: [".pptx"] } } });
        await openPanel();
        chooseFile("big.pptx", "x".repeat(2 * 1024 * 1024));
        expect($("presentation-import-file-error").textContent).toBe("This file is 2 MB; the limit is 10 bytes.");
    });

    test("the deck key is suggested from the file name until it is edited, and checked", async () => {
        setUp();
        await openPanel();
        chooseFile("Bone Box (Boney Pelvis).pptx");
        expect($("presentation-import-deck-key").value).toBe("bone-box-boney-pelvis");
        $("presentation-import-deck-key").value = "my key!";
        $("presentation-import-deck-key").dispatchEvent(new Event("input"));
        chooseFile("Other.pptx");
        expect($("presentation-import-deck-key").value).toBe("my key!");
        $("presentation-import-slides").value = "2-x";
        submit();
        await flush();
        expect($("presentation-import-deck-key-error").textContent).toMatch(/Use letters, digits/);
        expect($("presentation-import-slides-error").textContent).toMatch(/such as 2-7, 9/);
        expect(document.activeElement).toBe($("presentation-import-deck-key"));
        expect(importCalls(backend)).toEqual([]);
    });

    test("a Google Slides link is checked and gives a deck key from the presentation id", async () => {
        setUp();
        await openPanel();
        useSource("google-slides");
        expect($("presentation-import-link-field").hidden).toBe(false);
        expect($("presentation-import-file-field").hidden).toBe(true);
        $("presentation-import-link").value = "https://example.com/presentation/d/abc";
        $("presentation-import-link").dispatchEvent(new Event("input"));
        submit();
        await flush();
        expect($("presentation-import-link-error").textContent).toMatch(/Paste a Google Slides link/);
        $("presentation-import-link").value = `https://docs.google.com/presentation/d/${GOOGLE_ID}/edit`;
        $("presentation-import-link").dispatchEvent(new Event("input"));
        expect($("presentation-import-deck-key").value).toBe(`gslides-${GOOGLE_ID}`);
        expect(importCalls(backend)).toEqual([]);
    });
});

describe("running an import", () => {
    test("uploads the file, shows progress, then every slide's result with Open buttons", async () => {
        setUp();
        const opened = [];
        const changed = [];
        document.addEventListener("bonebox:open-scene", (e) => opened.push(e.detail.sceneId));
        document.addEventListener("bonebox:scenes-changed", () => changed.push(true));
        await openPanel();
        const file = chooseFile("Ilium.pptx");
        $("presentation-import-slides").value = "2-3";
        submit();
        await waitFor(() => expect($("presentation-import-progress-label").textContent).toBe("Reading slides: 2 of 3"));
        expect($("presentation-import-form").hidden).toBe(true);

        const [call] = importCalls(backend);
        expect(call.url).toBe("/api/scene-imports/pptx?deckKey=ilium&slides=2-3");
        expect(call.headers["X-File-Name"]).toBe("Ilium.pptx");
        expect(call.headers["Content-Type"]).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
        expect(call.headers.Authorization).toBeUndefined();
        expect(call.body).toBe(file);

        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        expect($("presentation-import-progress").hidden).toBe(true);
        expect($("presentation-import-result-heading").textContent).toBe("Import finished");
        expect($("presentation-import-summary").textContent).toBe("2 scene(s) saved, 3 image(s) copied.");
        expect(document.activeElement).toBe($("presentation-import-result-heading"));
        expect(rows().map((r) => r.dataset.outcome)).toEqual(["no-figure", "created", "unchanged"]);
        expect(rows()[1].textContent).toContain("Created");
        expect(rows()[1].querySelector("details").textContent).toContain("sits over two photos");
        expect(rows()[0].querySelector("button")).toBeNull();
        rows()[1].querySelector("button").click();
        expect(opened).toEqual(["scene-2"]);
        expect(changed).toEqual([true]);
    });

    test("rejected slides are shown with their reason and nothing is announced as saved", async () => {
        setUp({
            jobScript: [{
                state: "stopped", phase: "done",
                summary: "Import stopped before writing: 1 slide(s) rejected. No scenes were saved and no images were copied.",
                results: [result(2, "not-saved"), result(3, "rejected")],
            }],
        });
        const changed = [];
        document.addEventListener("bonebox:scenes-changed", () => changed.push(true));
        await openPanel();
        chooseFile("Ilium.pptx");
        submit();
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        expect($("presentation-import-result-heading").textContent).toBe("Import stopped");
        expect($("presentation-import-summary").textContent).toBe("1 slide(s) rejected. No scenes were saved and no images were copied.");
        expect(rows()[1].textContent).toContain("Rejected");
        expect(rows()[1].querySelector(".presentation-import-reason").textContent).toBe("a scene named \"Ilium (slide 3)\" already exists (scene-9)");
        expect(rows()[0].querySelector(".presentation-import-reason").textContent).toBe("1 slide(s) rejected");
        expect(document.querySelectorAll(".presentation-import-open-scene")).toHaveLength(0);
        expect(changed).toEqual([]);
    });

    test("a failed import shows the server's message", async () => {
        setUp({ jobScript: [{ state: "failed", phase: "done", error: "The presentation could not be read. It may be damaged." }] });
        await openPanel();
        chooseFile("Broken.pptx");
        submit();
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        expect($("presentation-import-result-heading").textContent).toBe("Import failed");
        expect($("presentation-import-summary").textContent).toBe("The presentation could not be read. It may be damaged.");
        expect($("presentation-import-table").hidden).toBe(true);
    });

    test("an import the server refuses to start shows why and keeps the form", async () => {
        setUp({ start: { status: 400, body: { error: "This file is not a PowerPoint presentation. Choose a .pptx file." } } });
        await openPanel();
        chooseFile("fake.pptx");
        submit();
        await waitFor(() => expect($("presentation-import-form-error").hidden).toBe(false));
        expect($("presentation-import-form-error").textContent).toBe("This file is not a PowerPoint presentation. Choose a .pptx file.");
        expect($("presentation-import-form").hidden).toBe(false);
        expect($("presentation-import-progress").hidden).toBe(true);
        expect($("presentation-import-submit").disabled).toBe(false);
    });

    test("check only asks the server for a dry run and says nothing was saved", async () => {
        setUp({ jobScript: [{ state: "checked", phase: "done", summary: "Dry run: every slide passed the checks. Nothing was written.", results: [result(2, "dry-run")] }] });
        await openPanel();
        chooseFile("Ilium.pptx");
        $("presentation-import-dry-run").checked = true;
        submit();
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        expect(importCalls(backend)[0].url).toBe("/api/scene-imports/pptx?deckKey=ilium&dryRun=1");
        expect($("presentation-import-result-heading").textContent).toBe("Check finished: nothing was saved");
        expect(document.querySelectorAll(".presentation-import-open-scene")).toHaveLength(0);
    });

    test("a Google Slides import sends the link and options as JSON", async () => {
        setUp();
        await openPanel();
        useSource("google-slides");
        $("presentation-import-link").value = `https://docs.google.com/presentation/d/${GOOGLE_ID}/edit`;
        $("presentation-import-link").dispatchEvent(new Event("input"));
        submit();
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        const [call] = importCalls(backend);
        expect(call.url).toBe("/api/scene-imports/google-slides");
        expect(JSON.parse(call.body)).toEqual({ source: `https://docs.google.com/presentation/d/${GOOGLE_ID}/edit`, deckKey: `gslides-${GOOGLE_ID}`, slides: "", dryRun: false });
    });

    test("a server that asks for a key gets it in the Authorization header, and a wrong key is reported", async () => {
        setUp({ capabilities: { access: { mode: "key", allowed: false, message: "Enter this server's import key to import presentations." } } });
        await openPanel();
        expect($("presentation-import-key-field").hidden).toBe(false);
        chooseFile("Ilium.pptx");
        submit();
        await flush();
        expect($("presentation-import-key-error").textContent).toBe("Enter the import key.");
        expect(importCalls(backend)).toEqual([]);

        $("presentation-import-key").value = "the-key";
        submit();
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        expect(importCalls(backend)[0].headers.Authorization).toBe("Bearer the-key");
        expect(backend.calls.filter((c) => c.url.includes("/jobs/")).every((c) => c.headers.Authorization === "Bearer the-key")).toBe(true);

        setUp({ capabilities: { access: { mode: "key", allowed: false, message: "" } }, start: { status: 401, body: { error: "Enter this server's import key to import presentations." } } });
        await openPanel();
        chooseFile("Ilium.pptx");
        $("presentation-import-key").value = "wrong";
        submit();
        await waitFor(() => expect($("presentation-import-key-error").hidden).toBe(false));
        expect($("presentation-import-key-error").textContent).toBe("Enter this server's import key to import presentations.");
    });

    test("if the server stops answering while an import runs, it says so and can check again", async () => {
        setUp();
        await openPanel();
        chooseFile("Ilium.pptx");
        backend.state.pollFailures = 3;
        submit();
        await waitFor(() => expect($("presentation-import-poll-retry").hidden).toBe(false));
        expect($("presentation-import-progress-label").textContent).toMatch(/Lost contact with the import.*It may still be running on the server/);
        click("presentation-import-poll-retry");
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        expect($("presentation-import-result-heading").textContent).toBe("Import finished");
    });

    test("waiting behind another import says so", () => {
        jest.resetModules();
        const { describeProgress } = require("../js/presentationImport.js");
        expect(describeProgress({ state: "queued", phase: "queued", position: 2 }).label).toBe("Waiting for 2 other imports to finish…");
        expect(describeProgress({ state: "queued", phase: "queued", position: 0 }).label).toBe("Starting the import…");
        expect(describeProgress({ state: "running", phase: "saving", progress: { done: 5, total: 10 } })).toEqual({ label: "Saving scenes: 5 of 10", percent: 93 });
    });

    test("import another presentation starts over with an empty form", async () => {
        setUp();
        await openPanel();
        chooseFile("Ilium.pptx");
        submit();
        await waitFor(() => expect($("presentation-import-result").hidden).toBe(false));
        click("presentation-import-again");
        await waitFor(() => expect($("presentation-import-form").hidden).toBe(false));
        expect($("presentation-import-result").hidden).toBe(true);
        expect($("presentation-import-deck-key").value).toBe("");
        expect(panel.state.job).toBeNull();
    });
});

describe("with the Scene Editor", () => {
    test("after an import the scene list refreshes and Open shows the imported draft scene", async () => {
        const scenes = [];
        setUp({ scenes });
        const { initializeSceneEditor } = require("../js/scenes.js");
        initializeSceneEditor();
        click("text-button-SceneEditor");
        await waitFor(() => expect($("scene-library-message").hidden).toBe(true));
        expect(document.querySelectorAll("#scene-list li")).toHaveLength(0);

        await openPanel();
        chooseFile("Ilium.pptx");
        scenes.push({ id: "scene-2", name: "Ilium (slide 2)", createdAt: NOW, updatedAt: NOW }, { id: "scene-3", name: "Ilium (slide 3)", createdAt: NOW, updatedAt: NOW });
        submit();
        await waitFor(() => expect(document.querySelectorAll("#scene-list li")).toHaveLength(2));
        rows()[1].querySelector("button").click();
        await waitFor(() => expect($("scene-title").textContent).toBe("Ilium (slide 2)"));
        expect($("scene-status-badge").textContent).toBe("Draft");
    });
});
