/**
 * Vercel serverless entry. Exports the Express app so all rewritten
 * routes are handled by boneset-api/server.js.
 */
require("express");
const { app } = require("../boneset-api/server");

module.exports = app;
