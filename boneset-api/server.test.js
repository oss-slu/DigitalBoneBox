const request = require("supertest");
const { app, serverReady } = require("./server");

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
