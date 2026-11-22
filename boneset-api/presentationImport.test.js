// Import presentations from the Scene Editor (Issue #540): the /api/scene-imports API.
//
// Most tests use a stand-in extractor that writes the extracted pelvis fixture
// (three slides) as the IR, with small media files, so they run without
// Python. One test at the end runs the real data_extraction/pptx_ir.py on a
// one-slide deck when Python is available.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Buffer } = require("buffer"); // Jest's jsdom environment has no global Buffer
const { spawnSync } = require("child_process");
const express = require("express");
const request = require("supertest");
const {
    createPresentationImportRouter,
    parseGoogleSlidesId,
    deckKeyFromName,
    bearerToken,
    checkPresentationBytes,
    safeFileName,
    fileNameFromDisposition,
    PPTX_CONTENT_TYPE,
} = require("./presentationImport");
const { createFileSceneStore } = require("./scenes");
const fixture = require("./test-fixtures/bony-pelvis-slides-2-3-18.ir.json");

const REPO_ROOT = path.resolve(__dirname, "..");
const LEGACY_IMAGE = path.join(__dirname, "data", "images", "Clavicle_Top_Image.jpg");
const PPTX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....ppt/presentation.xml....")]);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Writes the fixture as an IR for `deckKey`, with one legacy image and two new ones. */
function writeFixtureIr(outDir, deckKey, deckFile) {
    const ir = JSON.parse(JSON.stringify(fixture));
    ir.deck.key = deckKey;
    ir.deck.file = deckFile;
    fs.mkdirSync(path.join(outDir, "media"), { recursive: true });
    const renamed = new Map();
    const media = {};
    Object.keys(ir.media).forEach((sha, i) => {
        const bytes = i === 0 ? fs.readFileSync(LEGACY_IMAGE) : Buffer.from(`presentation import test image ${i}`);
        const next = sha256(bytes);
        const file = `media/${next.slice(0, 16)}${i === 0 ? ".jpg" : ".png"}`;
        fs.writeFileSync(path.join(outDir, file), bytes);
        renamed.set(sha, { sha: next, file });
        media[next] = { ...ir.media[sha], file };
    });
    ir.media = media;
    for (const slide of ir.slides) {
        for (const object of slide.objects) {
            if (!object.picture) continue;
            const r = renamed.get(object.picture.mediaSha256);
            object.picture.mediaSha256 = r.sha;
            object.picture.mediaFile = r.file;
        }
    }
    const irPath = path.join(outDir, `${deckKey}.ir.json`);
    fs.writeFileSync(irPath, JSON.stringify(ir));
    return irPath;
}

function fakeExtractor(importDir, { check = null, fail = null } = {}) {
    const extractor = {
        calls: [],
        active: 0,
        maxActive: 0,
        async check() {
            if (check) return check();
            return { pillow: true, labelFonts: { regular: true, bold: true }, importDir };
        },
        async extract({ deckPath, outDir, deckKey, slides, onProgress }) {
            extractor.active += 1;
            extractor.maxActive = Math.max(extractor.maxActive, extractor.active);
            try {
                extractor.calls.push({ deckPath, deckKey, slides, deckName: path.basename(deckPath), bytes: fs.readFileSync(deckPath) });
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (fail) throw fail;
                const irPath = writeFixtureIr(outDir, deckKey, path.basename(deckPath));
                fixture.slides.forEach((_, i) => onProgress({ done: i + 1, total: fixture.slides.length }));
                return irPath;
            } finally {
                extractor.active -= 1;
            }
        },
    };
    return extractor;
}

const roots = [];
afterEach(() => {
    jest.restoreAllMocks();
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function harness({ env = {}, extractor = null, fetchImpl = null, extractorOptions = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "presentation-import-"));
    roots.push(root);
    const importDir = path.join(root, "imports");
    const imagesDir = path.join(root, "images");
    fs.mkdirSync(importDir);
    fs.mkdirSync(imagesDir);
    fs.copyFileSync(LEGACY_IMAGE, path.join(imagesDir, "Legacy_Bone_Image.jpg"));
    const store = createFileSceneStore(path.join(root, "scenes"));
    const tools = extractor || fakeExtractor(importDir, extractorOptions);
    const router = createPresentationImportRouter({ store, imagesDir, env: { DBB_PPTX_IMPORT_DIR: importDir, ...env }, extractor: tools, fetchImpl });
    const app = express();
    app.use(express.json({ limit: "6mb" }));
    app.use("/api/scene-imports", router);
    return {
        root,
        importDir,
        imagesDir,
        store,
        tools,
        router,
        app,
        async finish(jobId, headers = {}) {
            await router.jobs.get(jobId).done;
            return (await request(app).get(`/api/scene-imports/jobs/${jobId}`).set(headers)).body.job;
        },
        copiedImages() {
            const folder = path.join(imagesDir, "pptx");
            return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
        },
    };
}

function upload(h, { name = "Bony Pelvis.pptx", query = "deckKey=bony-pelvis-deck", bytes = PPTX_BYTES, headers = {} } = {}) {
    return request(h.app)
        .post(`/api/scene-imports/pptx?${query}`)
        .set("Content-Type", PPTX_CONTENT_TYPE)
        .set("X-File-Name", encodeURIComponent(name))
        .set(headers)
        .send(bytes);
}

const outcomes = (job) => job.results.map((r) => r.outcome);
const leaksServerPath = (value, h) => {
    const text = JSON.stringify(value);
    return [h.root, REPO_ROOT, os.homedir()].some((folder) => text.includes(folder));
};

// ---------------------------------------------------------------- availability and access

describe("what the Scene Editor is told before importing", () => {
    test("a local server with its prerequisites reports import as available", async () => {
        const h = harness();
        const res = await request(h.app).get("/api/scene-imports");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            available: true,
            problems: [],
            warnings: [],
            access: { mode: "local", allowed: true, message: null },
            limits: { maxBytes: 50 * 1024 * 1024, extensions: [".pptx"] },
            sources: ["pptx", "google-slides"],
            knownDecks: [],
        });
        expect(leaksServerPath(res.body, h)).toBe(false);
    });

    test("decks imported before are offered, so a re-import can use the same deck key", async () => {
        const h = harness();
        await h.finish((await upload(h)).body.job.id);
        const res = await request(h.app).get("/api/scene-imports");
        expect(res.body.knownDecks).toEqual([{ deckKey: "bony-pelvis-deck", deckFile: "Bony Pelvis.pptx", scenes: 3 }]);
    });

    test("on Vercel import is unavailable and nothing can be started", async () => {
        const h = harness({ env: { VERCEL: "1" } });
        const res = await request(h.app).get("/api/scene-imports");
        expect(res.body.available).toBe(false);
        expect(res.body.problems[0]).toMatch(/local copy of the app/);
        const started = await upload(h);
        expect(started.status).toBe(503);
        expect(h.tools.calls).toEqual([]);
    });

    test("missing Python is reported as a problem, missing Pillow or fonts as warnings", async () => {
        jest.spyOn(console, "error").mockImplementation(() => {}); // the server logs the failed check
        const noPython = harness({ extractorOptions: { check: () => { throw new Error("spawn python3 ENOENT"); } } });
        const res = await request(noPython.app).get("/api/scene-imports");
        expect(res.body.available).toBe(false);
        expect(res.body.problems).toEqual([expect.stringMatching(/needs Python 3\.8 or newer/)]);
        expect(JSON.stringify(res.body)).not.toMatch(/ENOENT|python3/);

        const root = fs.mkdtempSync(path.join(os.tmpdir(), "presentation-import-"));
        roots.push(root);
        const noPillow = harness({ extractorOptions: { check: async () => ({ pillow: false, labelFonts: { regular: false, bold: false }, importDir: root }) } });
        const warned = await request(noPillow.app).get("/api/scene-imports");
        expect(warned.body.available).toBe(true);
        expect(warned.body.warnings).toEqual([expect.stringMatching(/Pillow is not installed/)]);
    });

    test("without a key, only requests from this computer may import", async () => {
        const h = harness();
        const proxied = { "X-Forwarded-For": "203.0.113.9" };
        const caps = await request(h.app).get("/api/scene-imports").set(proxied);
        expect(caps.body.access).toEqual({ mode: "local", allowed: false, message: expect.stringMatching(/SCENE_IMPORT_TOKEN/) });
        expect(caps.body.knownDecks).toEqual([]);
        expect((await upload(h, { headers: proxied })).status).toBe(403);
        expect((await upload(h, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
        expect(h.tools.calls).toEqual([]);

        const local = await upload(h, { headers: { Origin: "http://localhost:8080" } });
        expect(local.status).toBe(202);
        await h.finish(local.body.job.id);
        expect((await request(h.app).get(`/api/scene-imports/jobs/${local.body.job.id}`).set(proxied)).status).toBe(403);
    });

    test("with SCENE_IMPORT_TOKEN set, a request needs the key", async () => {
        const h = harness({ env: { SCENE_IMPORT_TOKEN: "s3cret-import-key" } });
        const caps = await request(h.app).get("/api/scene-imports");
        expect(caps.body.access).toEqual({ mode: "key", allowed: false, message: "Enter this server's import key to import presentations." });
        expect((await upload(h)).status).toBe(401);
        expect((await upload(h, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
        const ok = await upload(h, { headers: { Authorization: "Bearer s3cret-import-key", "X-Forwarded-For": "203.0.113.9" } });
        expect(ok.status).toBe(202);
        const job = await h.finish(ok.body.job.id, { Authorization: "Bearer s3cret-import-key" });
        expect(job.state).toBe("succeeded");
        expect(JSON.stringify(job)).not.toContain("s3cret");
    });
});

// ---------------------------------------------------------------- checks before processing

describe("checks before a presentation is processed", () => {
    test.each([
        ["another file type", { name: "notes.docx" }, 415, /Choose a PowerPoint \.pptx file/],
        ["an old .ppt file", { name: "deck.ppt" }, 415, /Older \.ppt files/],
        ["an empty file", { bytes: Buffer.alloc(0) }, 400, /The file is empty/],
        ["a file that is not a zip", { bytes: Buffer.from("not a presentation") }, 400, /password-protected/],
        ["a zip that is not a presentation", { bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml")]) }, 400, /not a PowerPoint presentation/],
        ["an invalid deck key", { query: "deckKey=../escape" }, 400, /deck key may only use/],
        ["an invalid slide list", { query: "deckKey=ok&slides=2-x" }, 400, /Slides must be numbers and ranges/],
    ])("%s is refused before anything runs", async (_label, options, status, message) => {
        const h = harness();
        const res = await upload(h, options);
        expect(res.status).toBe(status);
        expect(res.body.error).toMatch(message);
        expect(h.tools.calls).toEqual([]);
        expect(h.router.jobs.size).toBe(0);
    });

    test("a file over the size limit is refused with the limit in the message", async () => {
        const h = harness({ env: { PPTX_IMPORT_MAX_BYTES: "1048576" } });
        const res = await upload(h, { bytes: Buffer.concat([PPTX_BYTES, Buffer.alloc(1048576)]) });
        expect(res.status).toBe(413);
        expect(res.body.error).toBe("The presentation is larger than the 1 MB limit.");
        expect(h.tools.calls).toEqual([]);
    });

    test("the deck key defaults to one made from the file name, and the file name is kept for provenance", async () => {
        const h = harness();
        const started = await upload(h, { name: "Bone Project 2.0 (final).pptx", query: "" });
        expect(started.status).toBe(202);
        expect(started.body.job).toEqual(expect.objectContaining({ deckKey: "bone-project-2-0-final", source: { type: "pptx", name: "Bone Project 2.0 (final).pptx" } }));
        await h.finish(started.body.job.id);
        expect(h.tools.calls[0]).toEqual(expect.objectContaining({ deckKey: "bone-project-2-0-final", deckName: "Bone Project 2.0 (final).pptx" }));
        const scenes = await h.store.list();
        expect(scenes.every((s) => s.importLog[0].deck.file === "Bone Project 2.0 (final).pptx")).toBe(true);
    });

    test("file and link helpers", () => {
        expect(deckKeyFromName("Bone Box (Boney Pelvis).pptx")).toBe("bone-box-boney-pelvis");
        expect(deckKeyFromName("---.pptx")).toBe("");
        expect(safeFileName("../../etc/passwd.pptx")).toBe("passwd.pptx");
        expect(safeFileName("C:\\Users\\someone\\Deck <1>.pptx")).toBe("Deck _1_.pptx");
        expect(safeFileName("")).toBe("presentation.pptx");
        expect(fileNameFromDisposition("attachment; filename=\"Pelvis deck.pptx\"; filename*=UTF-8''Pelvis%20deck%20%C3%A9.pptx")).toBe("Pelvis deck é.pptx");
        expect(fileNameFromDisposition("attachment; filename=plain.pptx")).toBe("plain.pptx");
        const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab";
        expect(parseGoogleSlidesId(`https://docs.google.com/presentation/d/${id}/edit#slide=id.p`)).toBe(id);
        expect(parseGoogleSlidesId(`https://docs.google.com/presentation/u/1/d/${id}/edit`)).toBe(id);
        expect(parseGoogleSlidesId(id)).toBe(id);
        expect(parseGoogleSlidesId(`http://docs.google.com/presentation/d/${id}/edit`)).toBeNull();
        expect(parseGoogleSlidesId(`https://evil.example/presentation/d/${id}/edit`)).toBeNull();
        expect(parseGoogleSlidesId(`https://docs.google.com/document/d/${id}/edit`)).toBeNull();
        expect(parseGoogleSlidesId("short")).toBeNull();
    });
});

// ---------------------------------------------------------------- hostile and malformed input

describe("hostile and malformed input", () => {
    // What the earlier regular-expression version returned for each name.
    test.each([
        ["Bone Box (Boney Pelvis).pptx", "bone-box-boney-pelvis"],
        ["Bone Project 2.0 (final).pptx", "bone-project-2-0-final"],
        ["UPPER_case-Name.PPTX", "upper-case-name"],
        ["-lead and trail-.pptx", "lead-and-trail"],
        ["  \u00dcn\u00efc\u00f6d\u00e9 \u2014 Slides!!.pptx", "n-c-d-slides"],
        ["emoji \ud83d\ude00 deck.pptx", "emoji-deck"],
        ["a.b.c.pptx", "a-b-c"],
        ["a/b\\c.pptx", "a-b-c"],
        ["---.pptx", ""],
        [".pptx", ""],
        ["noext", "noext"],
        ["", ""],
        [null, ""],
        [`${"x".repeat(127)} y.pptx`, "x".repeat(127)],
        [`${"x".repeat(127)}y.pptx`, `${"x".repeat(127)}y`],
    ])("deck key from %j is %j, as before", (name, key) => {
        expect(deckKeyFromName(name)).toBe(key);
    });

    test("a deck key is made in one bounded pass, however hostile the name", () => {
        const started = Date.now();
        for (const name of ["-".repeat(200000), `${"-".repeat(200000)}a.pptx`, `a${"-".repeat(200000)}!`, `${".".repeat(200000)}pptx`, "\u00e9".repeat(200000)]) {
            const key = deckKeyFromName(name);
            expect(key.length).toBeLessThanOrEqual(128);
            expect(key).not.toMatch(/^-|-$/);
            expect(key).toMatch(/^[a-z0-9-]*$/);
        }
        expect(deckKeyFromName(`${"ab-".repeat(200)}.pptx`)).toHaveLength(128);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test("only a well-formed Bearer header gives a token", () => {
        expect(bearerToken("Bearer abc")).toBe("abc");
        expect(bearerToken("bearer   abc  ")).toBe("abc");
        expect(bearerToken("BEARER\tabc")).toBe("abc");
        expect(bearerToken("Bearer a b")).toBe("a b");
        for (const header of ["Basic abc", "Bearer", "Bearer    ", "Bearerabc", " ", "", undefined, null, 42, ["Bearer abc"], { toString: () => "Bearer abc" }]) {
            expect(bearerToken(header)).toBeNull();
        }
        const started = Date.now();
        expect(bearerToken(`Bearer ${" ".repeat(200000)}x`)).toBeNull(); // over the length limit
        expect(bearerToken(`bearer ${" ".repeat(1000)}`)).toBeNull();
        expect(bearerToken(`Bearer ${"k".repeat(1000)}`)).toBe("k".repeat(1000));
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test("a malformed Authorization header is refused quickly when a key is required", async () => {
        const h = harness({ env: { SCENE_IMPORT_TOKEN: "s3cret-import-key" } });
        for (const header of [`Bearer ${" ".repeat(5000)}`, `Bearer ${" ".repeat(5000)}s3cret-import-key`, "Basic s3cret-import-key", "Bearers3cret-import-key"]) {
            const res = await upload(h, { headers: { Authorization: header } });
            expect(res.status).toBe(401);
        }
        expect(h.tools.calls).toEqual([]);
    });

    test("anything but a Buffer is refused before its bytes are read", () => {
        const lookalike = { length: 30, 0: 0x50, 1: 0x4b, 2: 0x03, 3: 0x04, includes: () => true };
        for (const body of ["PK\u0003\u0004ppt/presentation.xml", [0x50, 0x4b, 0x03, 0x04], lookalike, {}, null, undefined, 0]) {
            expect(() => checkPresentationBytes(body, 1024)).toThrow("The request did not contain a presentation file.");
        }
        expect(() => checkPresentationBytes(PPTX_BYTES, 1024)).not.toThrow();
        expect(() => checkPresentationBytes(Buffer.alloc(0), 1024)).toThrow("The file is empty.");
    });

    test("a JSON body sent to the .pptx upload is refused", async () => {
        const h = harness();
        const res = await request(h.app).post("/api/scene-imports/pptx?deckKey=k")
            .set("Content-Type", "application/json")
            .set("X-File-Name", "deck.pptx")
            .send({ 0: 80, 1: 75, 2: 3, 3: 4, length: 30, includes: "ppt/presentation.xml" });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("The request did not contain a presentation file.");
        expect(h.tools.calls).toEqual([]);
    });

    test("a hostile file name is reduced to a short, plain .pptx name", async () => {
        const h = harness();
        const name = `${"../".repeat(100)}${"-".repeat(5000)}deck.pptx`;
        const started = await upload(h, { name, query: "" });
        expect(started.status).toBe(202);
        expect(started.body.job.source.name).toMatch(/^[A-Za-z0-9 ._()-]{1,124}\.pptx$/);
        expect(started.body.job.deckKey).toBe("deck");
        await h.finish(started.body.job.id);
        expect(h.tools.calls[0].deckName).not.toMatch(/[\\/]/);
    });
});

// ---------------------------------------------------------------- imports

describe("importing a .pptx from the Scene Editor", () => {
    test("a successful import creates draft scenes, reports progress and every slide, and cleans up", async () => {
        const h = harness();
        const started = await upload(h);
        expect(started.status).toBe(202);
        expect(started.body.job).toEqual(expect.objectContaining({ state: "queued", position: 0, deckKey: "bony-pelvis-deck", dryRun: false }));

        const job = await h.finish(started.body.job.id);
        expect(job.state).toBe("succeeded");
        expect(job.summary).toBe("Import finished: 3 scene(s) saved, 2 image(s) copied.");
        expect(outcomes(job)).toEqual(["created", "created", "created"]);
        expect(job.results[0]).toEqual(expect.objectContaining({
            slide: 2,
            sceneId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-/),
            sceneName: expect.stringContaining("(slide 2)"),
            counts: expect.objectContaining({ images: 2, labels: expect.any(Number), pointerLines: expect.any(Number) }),
            skipped: expect.any(Array),
        }));
        expect(job.progress).toEqual({ done: 3, total: 3 });

        const scenes = await h.store.list();
        expect(scenes).toHaveLength(3);
        expect(scenes.every((s) => s.status === "draft")).toBe(true);
        expect(h.copiedImages()).toHaveLength(2);
        expect(fs.readdirSync(path.join(h.importDir, "scene-editor-jobs"))).toEqual([]); // the uploaded deck is gone
        expect(leaksServerPath(job, h)).toBe(false);
    });

    test("importing the same deck again reports every scene unchanged and duplicates nothing", async () => {
        const h = harness();
        const first = await h.finish((await upload(h)).body.job.id);
        const images = h.copiedImages();
        const second = await h.finish((await upload(h)).body.job.id);
        expect(outcomes(second)).toEqual(["unchanged", "unchanged", "unchanged"]);
        expect(second.results.map((r) => r.sceneId)).toEqual(first.results.map((r) => r.sceneId));
        expect(await h.store.list()).toHaveLength(3);
        expect(h.copiedImages()).toEqual(images);
    });

    test("a renamed scene keeps its id and name when the deck is imported again", async () => {
        const h = harness();
        const first = await h.finish((await upload(h)).body.job.id);
        const scene = await h.store.get(first.results[0].sceneId);
        await h.store.save({ ...scene, name: "Pelvis, anterior view" });
        const second = await h.finish((await upload(h)).body.job.id);
        expect(second.results[0]).toEqual(expect.objectContaining({ outcome: "unchanged", sceneId: scene.id, sceneName: "Pelvis, anterior view" }));
    });

    test("check only reports what would happen and writes nothing", async () => {
        const h = harness();
        const job = await h.finish((await upload(h, { query: "deckKey=bony-pelvis-deck&dryRun=1" })).body.job.id);
        expect(job.state).toBe("checked");
        expect(job.results.map((r) => r.action)).toEqual(["dry run: would create", "dry run: would create", "dry run: would create"]);
        expect(await h.store.list()).toEqual([]);
        expect(h.copiedImages()).toEqual([]);
    });

    test("a slide whose scene name is taken stops the whole import before anything is written", async () => {
        const h = harness();
        const first = await h.finish((await upload(h, { query: "deckKey=first-key" })).body.job.id);
        const taken = await h.store.get(first.results[2].sceneId);
        await h.store.remove(first.results[0].sceneId);
        await h.store.remove(first.results[1].sceneId);
        const imagesBefore = h.copiedImages();

        // the last slide clashes with the scene left from the first deck key
        const job = await h.finish((await upload(h, { query: "deckKey=second-key" })).body.job.id);
        expect(job.state).toBe("stopped");
        expect(job.summary).toBe("Import stopped before writing: 1 slide(s) rejected. No scenes were saved and no images were copied.");
        expect(outcomes(job)).toEqual(["not-saved", "not-saved", "rejected"]);
        expect(job.results[2].action).toBe(`rejected: a scene named "${taken.name}" already exists (${taken.id})`);
        expect((await h.store.list()).map((s) => s.id)).toEqual([taken.id]);
        expect(h.copiedImages()).toEqual(imagesBefore);
    });

    test("the same deck under another deck key is rejected as duplicates and creates nothing", async () => {
        const h = harness();
        await h.finish((await upload(h)).body.job.id);
        const job = await h.finish((await upload(h, { query: "deckKey=bony-pelvis-copy" })).body.job.id);
        expect(job.state).toBe("stopped");
        expect(outcomes(job)).toEqual(["rejected", "rejected", "rejected"]);
        expect(await h.store.list()).toHaveLength(3);
    });

    test("the slide list is passed to the extractor", async () => {
        const h = harness();
        await h.finish((await upload(h, { query: "deckKey=k&slides=2-3, 18" })).body.job.id);
        expect(h.tools.calls[0].slides).toBe("2-3,18");
    });

    test("a presentation the extractor cannot read fails with a message for the user and leaves nothing behind", async () => {
        jest.spyOn(console, "error").mockImplementation(() => {}); // the server logs the details
        const h = harness({ extractorOptions: { fail: Object.assign(new Error("boom"), { status: 422 }) } });
        const job = await h.finish((await upload(h)).body.job.id);
        expect(job.state).toBe("failed");
        expect(job.error).toBe("The import failed on the server. Nothing more was saved after the failure; the server log has the details.");
        expect(job.results).toEqual([]);
        expect(await h.store.list()).toEqual([]);
        expect(fs.readdirSync(path.join(h.importDir, "scene-editor-jobs"))).toEqual([]);
    });

    test("an unexpected error never sends server paths or details to the browser", async () => {
        const secret = path.join(os.homedir(), "private", "deck.pptx");
        const h = harness({ extractorOptions: { fail: new Error(`ENOENT: no such file ${secret}`) } });
        const errors = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            const job = await h.finish((await upload(h)).body.job.id);
            expect(job.state).toBe("failed");
            expect(JSON.stringify(job)).not.toContain(secret);
            expect(JSON.stringify(job)).not.toContain("ENOENT");
        } finally {
            errors.mockRestore();
        }
    });

    test("imports run one at a time, and a waiting one says how many are ahead", async () => {
        const h = harness();
        const a = await upload(h, { query: "deckKey=deck-a", name: "a.pptx" });
        const b = await upload(h, { query: "deckKey=deck-b", name: "b.pptx" });
        expect(b.body.job.position).toBe(1);
        await h.finish(a.body.job.id);
        await h.finish(b.body.job.id);
        expect(h.tools.maxActive).toBe(1);
        expect(h.tools.calls.map((c) => c.deckKey)).toEqual(["deck-a", "deck-b"]);
    });

    test("an unknown import id is a 404", async () => {
        const h = harness();
        const res = await request(h.app).get("/api/scene-imports/jobs/not-a-job");
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------- Google Slides

describe("importing a Google Slides presentation", () => {
    const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab";
    const LINK = `https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`;

    function response(status, { headers = {}, bytes = Buffer.alloc(0) } = {}) {
        const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
        return { status, ok: status >= 200 && status < 300, headers: { get: (name) => lower[name.toLowerCase()] ?? null }, body: null, arrayBuffer: async () => bytes };
    }

    function google(routes) {
        return jest.fn(async (url) => {
            const route = routes.find(([prefix]) => url.startsWith(prefix));
            if (!route) throw new Error(`unexpected fetch ${url}`);
            return route[1]();
        });
    }

    const start = (h, body) => request(h.app).post("/api/scene-imports/google-slides").send(body);

    test("a shared presentation is downloaded as .pptx through Google's redirect and imported", async () => {
        const fetchImpl = google([
            [`https://docs.google.com/presentation/d/${ID}/export/pptx`, () => response(307, { headers: { location: "https://doc-0s-docs.googleusercontent.com/export/abc" } })],
            ["https://doc-0s-docs.googleusercontent.com/export/abc", () => response(200, {
                headers: { "content-type": PPTX_CONTENT_TYPE, "content-disposition": "attachment; filename=\"Pelvis (Google).pptx\"" },
                bytes: PPTX_BYTES,
            })],
        ]);
        const h = harness({ fetchImpl });
        const started = await start(h, { source: LINK });
        expect(started.status).toBe(202);
        expect(started.body.job.deckKey).toBe(`gslides-${ID}`);
        const job = await h.finish(started.body.job.id);
        expect(job.state).toBe("succeeded");
        expect(job.source).toEqual({ type: "google-slides", name: "Pelvis (Google).pptx" });
        expect(outcomes(job)).toEqual(["created", "created", "created"]);
        expect(fetchImpl.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: "manual" }));
        expect(h.tools.calls[0].bytes.equals(PPTX_BYTES)).toBe(true);
    });

    test.each([
        ["a presentation that is not shared", [302, { headers: { location: "https://accounts.google.com/ServiceLogin?continue=x" } }], /Anyone with the link can view/],
        ["a missing presentation", [404], /no presentation with that link/],
        ["a sign-in page instead of a file", [200, { headers: { "content-type": "text/html; charset=utf-8" }, bytes: Buffer.from("<html>") }], /Anyone with the link can view/],
        ["a redirect to another site", [302, { headers: { location: "https://evil.example/file.pptx" } }], /Anyone with the link can view/],
        ["a file over the size limit", [200, { headers: { "content-type": PPTX_CONTENT_TYPE, "content-length": String(60 * 1024 * 1024) } }], /larger than the 50 MB limit/],
        ["a Google error", [500], /HTTP 500/],
    ])("%s fails with a clear message and nothing is imported", async (_label, [status, options], message) => {
        const fetchImpl = google([[`https://docs.google.com/presentation/d/${ID}/export/pptx`, () => response(status, options)]]);
        const h = harness({ fetchImpl });
        const job = await h.finish((await start(h, { source: ID })).body.job.id);
        expect(job.state).toBe("failed");
        expect(job.error).toMatch(message);
        expect(h.tools.calls).toEqual([]);
        expect(fetchImpl.mock.calls.every(([url]) => url.startsWith("https://docs.google.com/"))).toBe(true);
        expect(await h.store.list()).toEqual([]);
    });

    test("a link that is not a Google Slides link is refused without contacting anyone", async () => {
        const fetchImpl = jest.fn();
        const h = harness({ fetchImpl });
        for (const source of ["https://evil.example/presentation/d/abcdefghijklmnopqrstuvwxyz/edit", "http://169.254.169.254/latest", "", "not a link"]) {
            const res = await start(h, { source });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Paste a Google Slides link/);
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------- the real extractor

const python = process.env.PPTX_IMPORT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const hasPython = spawnSync(python, ["--version"]).status === 0;

(hasPython ? test : test.skip)("with the real extractor, a .pptx uploaded from the Scene Editor becomes a draft scene", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "presentation-import-real-"));
    roots.push(root);
    const deck = path.join(root, "one-slide.pptx");
    const made = spawnSync(python, ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from test_pptx_ir import write_minimal_deck; write_minimal_deck(sys.argv[2])",
        path.join(REPO_ROOT, "data_extraction"), deck]);
    expect(made.status).toBe(0);
    const importDir = path.join(root, "imports");
    const imagesDir = path.join(root, "images");
    fs.mkdirSync(imagesDir);
    const store = createFileSceneStore(path.join(root, "scenes"));
    const router = createPresentationImportRouter({ store, imagesDir, env: { ...process.env, DBB_PPTX_IMPORT_DIR: importDir } });
    const app = express();
    app.use("/api/scene-imports", router);

    const caps = await request(app).get("/api/scene-imports");
    expect(caps.body.available).toBe(true);
    const started = await request(app).post("/api/scene-imports/pptx?deckKey=one-slide")
        .set("Content-Type", PPTX_CONTENT_TYPE).set("X-File-Name", "one-slide.pptx").send(fs.readFileSync(deck));
    expect(started.status).toBe(202);
    await router.jobs.get(started.body.job.id).done;
    const job = (await request(app).get(`/api/scene-imports/jobs/${started.body.job.id}`)).body.job;
    expect(job.state).toBe("succeeded");
    expect(outcomes(job)).toEqual(["created"]);
    expect(job.progress).toEqual({ done: 1, total: 1 });
    const scenes = await store.list();
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toEqual(expect.objectContaining({ status: "draft", name: "Slide (slide 1)" }));
    expect(scenes[0].images[0].src).toMatch(/^\/api\/images\/pptx\/[0-9a-f]{16}\.png$/);
    expect(fs.readdirSync(path.join(importDir, "scene-editor-jobs"))).toEqual([]);

    // A damaged file that passes the quick checks: the extractor fails, and
    // the user gets a plain message, never Python's traceback or a server path.
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
        const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("ppt/presentation.xml but not a real zip")]);
        const failed = await request(app).post("/api/scene-imports/pptx?deckKey=broken")
            .set("Content-Type", PPTX_CONTENT_TYPE).set("X-File-Name", "broken.pptx").send(broken);
        await router.jobs.get(failed.body.job.id).done;
        const failedJob = (await request(app).get(`/api/scene-imports/jobs/${failed.body.job.id}`)).body.job;
        expect(failedJob.state).toBe("failed");
        expect(failedJob.error).toBe("The presentation could not be read. It may be damaged, or use features the importer does not support.");
        expect(JSON.stringify(failedJob)).not.toMatch(/Traceback|BadZipFile|pptx_ir\.py/);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("pptx_ir.py exited with"));
    } finally {
        errors.mockRestore();
    }
    expect(await store.list()).toHaveLength(1);
}, 60000);
