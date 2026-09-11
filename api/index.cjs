/**
 * Vercel serverless entry. Exports the Express app so all rewritten
 * routes are handled by boneset-api/server.js.
 */
const { app } = require("../boneset-api/server");

module.exports = app;
