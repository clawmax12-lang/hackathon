// Kept as a compatibility entry point for existing local commands. Seeding and
// video rendering must run as explicit one-off jobs: doing that work on every
// API restart exhausts the production service before its health check passes.
import "../server/src/index.js";
