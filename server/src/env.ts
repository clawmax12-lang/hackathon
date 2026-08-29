import fs from "node:fs";
import path from "node:path";

// Load .env (repo root) as a fallback: values already present in the real
// environment always win, matching the machine-level secret-store precedence.
for (const envPath of [path.resolve(process.cwd(), ".env"), path.resolve(import.meta.dirname, "../../.env")]) {
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
    break;
  } catch {
    /* no .env here — fine */
  }
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const anthropicApiKey = str("ANTHROPIC_API_KEY");

export const config = {
  port: num("PORT", 3002),
  databaseUrl: str("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:3099/catalog"),
  storageDir: str("STORAGE_DIR", path.resolve(process.cwd(), "var/storage")),

  anthropicApiKey,
  anthropicWorkspaceId: str("ANTHROPIC_WORKSPACE_ID"),
  orchestratorModel: str("ANTHROPIC_ORCHESTRATOR_MODEL", "claude-opus-5"),
  visionModel: str("ANTHROPIC_VISION_MODEL", "claude-haiku-4-5"),

  elevenLabsApiKey: str("ELEVENLABS_API_KEY"),
  // "Adam Composer Stockholm" — Stockholm-accented voice already in this account.
  elevenLabsVoiceId: str("ELEVENLABS_VOICE_ID", "x0u3EW21dbrORJzOq1m9"),

  firecrawlApiKey: str("FIRECRAWL_API_KEY"),

  // Mock walks the same state machine with scripted reasoning; defaults to
  // mock only when no Anthropic key is configured.
  mockOrchestrator: str("MOCK_ORCHESTRATOR", anthropicApiKey ? "0" : "1") === "1",

  maxTurns: num("PIPELINE_MAX_TURNS", 24),
  maxCostUsd: Number(process.env.PIPELINE_MAX_COST_USD ?? "3.0"),
  includeMusic: str("INCLUDE_MUSIC", "0") === "1",

  market: str("IKEA_MARKET", "se"),
  language: str("IKEA_LANGUAGE", "sv"),

  sampleDir: path.resolve(import.meta.dirname, "../assets/sample"),
};

export type Config = typeof config;
