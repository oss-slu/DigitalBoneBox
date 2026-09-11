const request = require("supertest");
const { app } = require("./server");

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
