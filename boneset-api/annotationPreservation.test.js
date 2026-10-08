// Existing annotation preservation - Issue #465 (parent #463).
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

// Keep scene files written during tests out of the real data folder.
const scenesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-annotations-test-"));
process.env.SCENES_DIR = scenesDir;

const { app, serverReady } = require("./server");
const { createFileSceneStore } = require("./scenes");
const {
    ANNOTATIONS_DIR,
    buildBaseline,
    readBaseline,
    compareWithBaseline,
} = require("./scripts/annotation-baseline");

const COLORED_REGIONS_DIR = path.join(ANNOTATIONS_DIR, "ColoredRegions");
const TEXT_LABELS_DIR = path.join(ANNOTATIONS_DIR, "text_label_annotations");
const COLORED_REGIONS_SUFFIX = "_colored_regions.json";

// One item from each boneset. Kept short because /api/annotations is rate limited.
const TEXT_ANNOTATION_BONE_IDS = ["bony_pelvis", "ilium", "anterior_mandible", "sternum", "atlas", "humerus", "femur"];

// The API only accepts ids made of letters, numbers and underscores, so files
// whose names contain a hyphen or a space can't be displayed yet.
function servableColoredRegionIds() {
    return fs.readdirSync(COLORED_REGIONS_DIR)
        .filter((file) => file.endsWith(COLORED_REGIONS_SUFFIX))
        .map((file) => file.slice(0, -COLORED_REGIONS_SUFFIX.length))
        .filter((id) => /^[a-z0-9_]+$/i.test(id));
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

beforeAll(() => serverReady);

afterAll(() => {
    fs.rmSync(scenesDir, { recursive: true, force: true });
});

describe("Existing annotation files", () => {
    it("are all still present and unchanged since the baseline", () => {
        expect(compareWithBaseline(readBaseline())).toEqual({ missing: [], changed: [], added: [] });
    });
});

describe("Existing annotations can still be displayed", () => {
    it.each(servableColoredRegionIds())("serves the colored regions for %s", async (boneId) => {
        const response = await request(app).get("/api/colored-regions").query({ boneId });
        expect(response.statusCode).toBe(200);

        const onDisk = readJson(path.join(COLORED_REGIONS_DIR, `${boneId}${COLORED_REGIONS_SUFFIX}`));
        expect(response.body).toEqual(onDisk);
    });

    it.each(TEXT_ANNOTATION_BONE_IDS)("serves every text label for %s", async (boneId) => {
        const response = await request(app).get(`/api/annotations/${boneId}`);
        expect(response.statusCode).toBe(200);

        const onDisk = readJson(path.join(TEXT_LABELS_DIR, `${boneId}_text_annotations.json`));
        const served = response.body.annotations.map((annotation) => annotation.text_content);
        expect(served).toEqual(onDisk.text_annotations.map((annotation) => annotation.text_content));
    });
});

describe("Editor and viewer activity does not overwrite annotation files", () => {
    it("leaves every annotation file unchanged after scenes are saved and annotations are served", async () => {
        const before = buildBaseline().files;

        const created = await request(app).post("/api/scenes").send({ name: "Annotation Safety Scene" });
        expect(created.statusCode).toBe(201);
        await createFileSceneStore(scenesDir).save({
            ...created.body,
            annotations: [{ type: "text", text: "Iliac crest", x: 10, y: 10 }],
        });
        await request(app).get("/api/annotations/bony_pelvis");
        await request(app).get("/api/colored-regions").query({ boneId: "iliac_crest" });

        expect(buildBaseline().files).toEqual(before);
    });
});

describe("Baseline check", () => {
    let copyDir;

    beforeEach(() => {
        copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-annotation-copy-"));
        fs.mkdirSync(path.join(copyDir, "group"));
        fs.writeFileSync(path.join(copyDir, "group", "a.json"), "{\n  \"label\": \"Iliac crest\",\n  \"x\": 1\n}\n");
        fs.writeFileSync(path.join(copyDir, "b.json"), "[1, 2, 3]\n");
    });

    afterEach(() => {
        fs.rmSync(copyDir, { recursive: true, force: true });
    });

    it("reports a changed value", () => {
        const baseline = buildBaseline(copyDir);
        fs.writeFileSync(path.join(copyDir, "group", "a.json"), "{ \"label\": \"Iliac crest\", \"x\": 2 }");
        expect(compareWithBaseline(baseline, copyDir).changed).toEqual(["group/a.json"]);
    });

    it("reports a deleted file and a new file", () => {
        const baseline = buildBaseline(copyDir);
        fs.unlinkSync(path.join(copyDir, "b.json"));
        fs.writeFileSync(path.join(copyDir, "c.json"), "{}");
        expect(compareWithBaseline(baseline, copyDir)).toEqual({ missing: ["b.json"], changed: [], added: ["c.json"] });
    });

    it("ignores Windows line endings and indentation", () => {
        const baseline = buildBaseline(copyDir);
        fs.writeFileSync(path.join(copyDir, "group", "a.json"), "{\r\n    \"label\": \"Iliac crest\",\r\n    \"x\": 1\r\n}\r\n");
        expect(compareWithBaseline(baseline, copyDir)).toEqual({ missing: [], changed: [], added: [] });
    });
});