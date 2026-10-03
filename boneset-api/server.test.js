const request = require("supertest");
const fs = require("fs").promises;
const path = require("path");
const { app, serverReady, formatDescriptionText } = require("./server");

beforeAll(() => serverReady);

describe("Initial configuration tests 263", () => {
    it("should return 200 OK from health", async () => {
        const response = await request(app).get("/health");
        expect(response.statusCode).toBe(200);
    });

    it("should return message welcome from health", async () => {
        const response = await request(app).get("/health");
        expect(response.body.message).toBe("Welcome to the Boneset API");
    });

    it("should serve the app HTML at /", async () => {
        const response = await request(app).get("/");
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toMatch(/html/);
        expect(response.text).toContain("Digital Bone Box");
    });
});

// Unit tests for Issue 267: GET /api/annotations/:boneId
describe("GET /api/annotations/:boneId - Issue 267", () => {

    // Verify that an existing and properly formatted boneId
    // successfully returns annotation data.
    it("should return 200 and annotation data for a valid boneId", async () => {
        const response = await request(app).get("/api/annotations/bony_pelvis");

        // A successful request should return HTTP 200.
        expect(response.statusCode).toBe(200);

        // The response should contain the annotation information
        // required by the frontend.
        expect(response.body).toHaveProperty("annotations");
        expect(response.body).toHaveProperty("normalized_geometry");

        // Annotations should always be returned as an array.
        expect(Array.isArray(response.body.annotations)).toBe(true);
    });

    // Verify that boneIds containing characters that are not allowed
    // by the API validation logic are rejected.
    it("should return 400 for an invalid boneId", async () => {
        const response = await request(app).get(
            "/api/annotations/invalid-bone!"
        );

        // Invalid input should result in a Bad Request response.
        expect(response.statusCode).toBe(400);
        expect(response.body.error).toBe("Invalid boneId format.");
    });

    // Verify that a correctly formatted boneId that does not have
    // corresponding annotation data returns a Not Found response.
    it("should return 404 for a boneId that does not exist", async () => {
        const response = await request(app).get(
            "/api/annotations/nonexistent_bone"
        );

        // The ID is valid in format, but its data does not exist.
        expect(response.statusCode).toBe(404);
        expect(response.body).toHaveProperty("error");
    });

    // Verify the maximum length validation for boneId.
    // The API only allows boneIds up to 100 characters.
    it("should reject a boneId longer than 100 characters", async () => {
        const longBoneId = "a".repeat(101);

        const response = await request(app).get(
            `/api/annotations/${longBoneId}`
        );

        // A boneId exceeding the maximum length should be rejected.
        expect(response.statusCode).toBe(400);
        expect(response.body.error).toBe("Invalid boneId format.");
    });
});

// Unit tests for Issue 381: lightweight text formatting in bone descriptions
describe("formatDescriptionText - Issue 381", () => {
    it("leaves plain text with no markers unchanged", () => {
        expect(formatDescriptionText("First cervical vertebra.")).toBe(
            "First cervical vertebra."
        );
    });

    it("converts **bold** markers to <strong>", () => {
        expect(formatDescriptionText("This is **bold** text.")).toBe(
            "This is <strong>bold</strong> text."
        );
    });

    it("converts *italic* markers to <em>", () => {
        expect(formatDescriptionText("This is *italic* text.")).toBe(
            "This is <em>italic</em> text."
        );
    });

    it("handles bold and italic together in the same string", () => {
        expect(formatDescriptionText("**Bold** and *italic* together.")).toBe(
            "<strong>Bold</strong> and <em>italic</em> together."
        );
    });

    it("leaves an unmatched single marker as a literal asterisk", () => {
        expect(formatDescriptionText("Trailing marker *")).toBe(
            "Trailing marker *"
        );
    });

    it("escapes HTML in the source text so it cannot be smuggled through as markup", () => {
        expect(formatDescriptionText("<script>alert(1)</script>")).toBe(
            "&lt;script&gt;alert(1)&lt;/script&gt;"
        );
    });

    it("escapes HTML even when it appears alongside formatting markers", () => {
        expect(formatDescriptionText("**<img src=x onerror=alert(1)>**")).toBe(
            "<strong>&lt;img src=x onerror=alert(1)&gt;</strong>"
        );
    });
});

// Integration test for Issue 381: GET /api/description renders the formatting end-to-end
describe("GET /api/description - Issue 381", () => {
    const testBoneId = "__format_test_bone_381";
    const descriptionsDir = path.join(__dirname, "data", "descriptions");
    const fixturePath = path.join(descriptionsDir, `${testBoneId}_description.json`);

    beforeAll(async () => {
        await fs.writeFile(
            fixturePath,
            JSON.stringify({
                name: "Format Test Bone",
                id: testBoneId,
                description: [
                    "Plain sentence with no markers.",
                    "A **bold** point and an *italic* point.",
                ],
                images: [],
            })
        );
    });

    afterAll(async () => {
        await fs.unlink(fixturePath);
    });

    it("renders <strong>/<em> tags for a description that uses formatting markers", async () => {
        const response = await request(app).get(
            `/api/description/?boneId=${testBoneId}`
        );

        expect(response.statusCode).toBe(200);
        expect(response.text).toContain("<li>Plain sentence with no markers.</li>");
        expect(response.text).toContain(
            "<li>A <strong>bold</strong> point and an <em>italic</em> point.</li>"
        );
    });
});
