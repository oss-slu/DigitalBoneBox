/**
 * Vercel entrypoint. Re-exports the Express app so the platform can
 * detect and run the existing boneset-api server without route rewrites.
 */
require("express");
const { app } = require("./boneset-api/server");

module.exports = app;
