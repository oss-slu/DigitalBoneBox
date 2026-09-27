
const fs = require("fs");

const os = require("os");

const path = require("path");

const request = require("supertest");

// ---------------------------------------------------------------------------
// Test environment setup
// ---------------------------------------------------------------------------

// This keeps test data out of the real boneset-api/data/scenes folder.
const scenesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bonebox-legacy-test-"));

// Tell the scene store to use the temporary folder.

process.env.SCENES_DIR = scenesDir;

const { app, serverReady } = require("./server");

const { createFileSceneStore } = require("./scenes");

beforeAll(() => serverReady);

// Remove the temporary scenes folder after all tests finish, leaving no files behind.
afterAll(() => {
    fs.rmSync(scenesDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// The six bonesets from the original PowerPoint content, in the order the server lists them.
const EXPECTED_BONESETS = ["bony_pelvis", "skull", "thorax", "vertebrae", "upper_limb", "lower_limb"];

// Representative legacy items chosen to cover every level of the content
// hierarchy (boneset, bone, sub-bone) and at least one item from each boneset.
//
// Fields:
//   id             - the ID used by the API (matches the JSON file names)
//   name           - the display name expected in API responses
//   type           - "boneset", "bone", or "subbone"
//   coloredRegions - true if this item has colored region overlay data
//
// Notes:
//   - bony_pelvis is included because server.js applies a special alignment
//     workaround to it, which makes it a higher-risk item.
//   - anterior_mandible represents the Skull boneset, because the Skull
//     boneset and its four view-level bones currently have no description
//     files (reported separately in issue 488).
const REPRESENTATIVE_ITEMS = [
    { id: "bony_pelvis", name: "Bony Pelvis", type: "boneset", coloredRegions: false },
    { id: "ilium", name: "Ilium", type: "bone", coloredRegions: false },
    { id: "iliac_crest", name: "Iliac Crest", type: "subbone", coloredRegions: true },
    { id: "anterior_mandible", name: "Mandible", type: "subbone", coloredRegions: true },
    { id: "sternum", name: "Sternum", type: "bone", coloredRegions: false },
    { id: "atlas", name: "Atlas", type: "bone", coloredRegions: true },
    { id: "cervical_body", name: "Body", type: "subbone", coloredRegions: true },      
    { id: "axis", name: "Axis", type: "bone", coloredRegions: false },
    { id: "axis_body", name: "Body (Dens)", type: "subbone", coloredRegions: true },
    { id: "humerus", name: "Humerus", type: "bone", coloredRegions: false },
    { id: "humerus_head", name: "Humerus Head", type: "subbone", coloredRegions: true },
    { id: "femur", name: "Femur", type: "bone", coloredRegions: false },
    { id: "femur_head", name: "Head", type: "subbone", coloredRegions: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Legacy content compatibility - Issue 484", () => {

    // -----------------------------------------------------------------------
    // Section 1: Legacy navigation data
    // The /combined-data endpoint feeds the boneset, bone, and sub-bone
    // dropdowns in the viewer. If an item is missing here, students
    // cannot navigate to it.
    // -----------------------------------------------------------------------
    describe("Legacy navigation data", () => {

        // Confirms that all six original bonesets are still listed, in order.
        it("still lists all six original bonesets", async () => {
            // Request the combined dropdown data from the API.
            const response = await request(app).get("/combined-data");

            // The request should succeed.
            expect(response.statusCode).toBe(200);

            // Extract only the IDs and compare them to the expected list.
            expect(response.body.bonesets.map((b) => b.id)).toEqual(EXPECTED_BONESETS);
        });

        // Runs one test per representative bone or sub-bone (bonesets are
        // skipped here because they were already checked above).
        it.each(REPRESENTATIVE_ITEMS.filter((item) => item.type !== "boneset"))(
            "still lists $type $id in the dropdown data",
            async ({ id, type }) => {
                // Request the combined dropdown data from the API.
                const response = await request(app).get("/combined-data");

                // Choose the bones list or the sub-bones list based on the item type.
                const list = type === "bone" ? response.body.bones : response.body.subbones;

                // The item's ID should appear in the correct list.
                expect(list.map((entry) => entry.id)).toContain(id);
            }
        );

        // Regression coverage for issue #487: every bone must be served with
        // an id and name so it can appear correctly in the dropdowns and search.
        it("serves every bone with an id and a name", async () => {
            // Request the combined dropdown data from the API.
            const response = await request(app).get("/combined-data");

            // Every bone must have a string id and a string name to display correctly.
            for (const bone of response.body.bones) {
                expect(typeof bone.id).toBe("string");
                expect(typeof bone.name).toBe("string");
            }
        });
    });

    // -----------------------------------------------------------------------
    // Section 2: Representative legacy content
    // describe.each() creates a separate group of tests for every item in
    // REPRESENTATIVE_ITEMS, so each failure clearly names the broken item.
    // -----------------------------------------------------------------------
    describe.each(REPRESENTATIVE_ITEMS)("Legacy $type: $id", ({ id, name, coloredRegions }) => {

        // Confirms the viewer can load the item's name and image list.
        it("returns its bone data with at least one image", async () => {
            // Request the item's details from the bone data endpoint.
            const response = await request(app).get(`/api/bone-data/?boneId=${id}`);

            // The request should succeed.
            expect(response.statusCode).toBe(200);

            // The display name should match the original content.
            expect(response.body.name).toBe(name);

            // Images should be returned as a list with at least one entry.
            expect(Array.isArray(response.body.images)).toBe(true);
            expect(response.body.images.length).toBeGreaterThan(0);
        });

        // Confirms every image URL the API returns actually downloads,
        // which catches renamed or deleted image files.
        it("serves every one of its images", async () => {
            // Get the list of image URLs for this item.
            const boneData = await request(app).get(`/api/bone-data/?boneId=${id}`);

            // Request each image and verify it is a real, reachable image file.
            for (const image of boneData.body.images) {
                const response = await request(app).get(image.url);
                expect(response.statusCode).toBe(200);
                expect(response.headers["content-type"]).toMatch(/^image\//);
            }
        });

        // Confirms the description panel will show real content.
        it("returns its description", async () => {
            // Request the item's description, which the server returns as HTML list items.
            const response = await request(app).get(`/api/description/?boneId=${id}`);

            // The request should succeed.
            expect(response.statusCode).toBe(200);

            // The description should include the item's name...
            expect(response.text).toContain(name);

            // ...and should not be the server's fallback message for missing data.
            expect(response.text).not.toContain("Description not available");
        });

        // Only items that have colored region overlays get this test.
        if (coloredRegions) {
            // Confirms the colored highlight overlay data still loads.
            it("returns its colored regions", async () => {
                // Request the colored region data for this item.
                const response = await request(app).get(`/api/colored-regions?boneId=${id}`);

                // The request should succeed.
                expect(response.statusCode).toBe(200);
            });
        }
    });

    // -----------------------------------------------------------------------
    // Section 3: Scene content and legacy content in the same release
    // Verifies that the Scene Editor and the original viewer can be used
    // together without interfering with each other.
    // -----------------------------------------------------------------------
    describe("Scene content and legacy content in the same release", () => {

        // A real legacy image URL that a scene can reference.
        const LEGACY_IMAGE_URL = "/api/images/ilium_image1.jpg";

        // Confirms a scene built from legacy images can be saved, reopened,
        // and still display its image.
        it("reopens a saved scene that uses a legacy bone image, and the image still loads", async () => {
            // Create a new, empty scene through the Scenes API.
            const created = await request(app).post("/api/scenes").send({ name: "Legacy Pelvis Scene" });

            // Scene creation should return 201 Created.
            expect(created.statusCode).toBe(201);

            // Build a copy of the new scene that includes one legacy image.
            // The Scenes API does not yet have a route for saving images, so this
            // mirrors boneset-api/scenes.test.js by saving through the file store.
            const sceneWithLegacyImage = {
                ...created.body,
                images: [{ id: "img1", src: LEGACY_IMAGE_URL, x: 0, y: 0, width: 235, height: 371, rotation: 0 }],
            };

            // Save the updated scene into the temporary scenes folder.
            await createFileSceneStore(scenesDir).save(sceneWithLegacyImage);

            // Reopen the scene through the API, as the Scene Editor would.
            const reopened = await request(app).get(`/api/scenes/${created.body.id}`);

            // The scene should load, and its image reference should be unchanged.
            expect(reopened.statusCode).toBe(200);
            expect(reopened.body.images[0].src).toBe(LEGACY_IMAGE_URL);

            // Follow the scene's image reference to confirm the legacy image still loads.
            const image = await request(app).get(reopened.body.images[0].src);
            expect(image.statusCode).toBe(200);
            expect(image.headers["content-type"]).toMatch(/^image\//);
        });

        // Confirms the original viewer still works while scenes exist.
        it("keeps serving legacy bone data while scenes exist", async () => {
            // Confirm at least one scene exists (created by the previous test).
            const scenes = await request(app).get("/api/scenes");
            expect(scenes.body.scenes.length).toBeGreaterThan(0);

            // Legacy bone data should still load normally.
            const boneData = await request(app).get("/api/bone-data/?boneId=ilium");
            expect(boneData.statusCode).toBe(200);
            expect(boneData.body.name).toBe("Ilium");
        });

        // Confirms the bone search only returns legacy content and
        // does not accidentally include scene names.
        it("keeps scenes and legacy search results separate", async () => {
            // Searching for a legacy bone should still find it.
            const legacy = await request(app).get("/api/search").query({ q: "ilium" });
            expect(legacy.text).toContain("data-id=\"ilium\"");

            // Searching for the scene's name should not return any bone results.
            const sceneName = await request(app).get("/api/search").query({ q: "Legacy Pelvis Scene" });
            expect(sceneName.text).toContain("No results found");
        });
    });
});
