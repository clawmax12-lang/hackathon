import { serve } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./env.js";
import { maybeOne } from "./db.js";
import { mimeFor, pathFor } from "./storage.js";
import { scans } from "./routes/scans.js";
import { guides } from "./routes/guides.js";
import { waitlist } from "./routes/waitlist.js";
import { startJobRunner } from "./jobs.js";

const exec = promisify(execFile);
const app = new Hono();

app.route("/api/scans", scans);
app.route("/api/guides", guides);
app.route("/api/waitlist", waitlist);

// Asset streaming with HTTP Range support (video seeking in Safari/Chrome).
app.get("/api/assets/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/assets\//, ""));
  let abs: string;
  try {
    abs = pathFor(key);
  } catch {
    return c.text("bad path", 400);
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return c.text("not found", 404);
  }

  const mime = mimeFor(abs);
  const range = c.req.header("Range");
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      return c.body(null, 416, { "Content-Range": `bytes */${stat.size}` });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["Content-Length"] = String(end - start + 1);
    const stream = fs.createReadStream(abs, { start, end });
    return c.body(stream as unknown as ReadableStream, 206, headers);
  }

  headers["Content-Length"] = String(stat.size);
  return c.body(fs.createReadStream(abs) as unknown as ReadableStream, 200, headers);
});

app.get("/api/healthz", async (c) => {
  const checks: Record<string, unknown> = { ok: true, mock: config.mockOrchestrator };
  try {
    await maybeOne("SELECT 1 AS one");
    checks.db = true;
  } catch {
    checks.db = false;
    checks.ok = false;
  }
  try {
    await exec("ffmpeg", ["-version"], { timeout: 5000 });
    checks.ffmpeg = true;
  } catch {
    checks.ffmpeg = false;
    checks.ok = false;
  }
  checks.anthropic = Boolean(config.anthropicApiKey);
  checks.elevenlabs = Boolean(config.elevenLabsApiKey);
  checks.firecrawl = Boolean(config.firecrawlApiKey);
  return c.json(checks, checks.ok ? 200 : 503);
});

startJobRunner();

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[monterra-api] listening on :${info.port} (mock=${config.mockOrchestrator}, model=${config.orchestratorModel})`);
});
