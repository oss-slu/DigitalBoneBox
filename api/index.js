import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { app } = require("../boneset-api/server.js");

export default app;
