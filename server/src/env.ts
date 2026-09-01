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

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

function anthropicEffort(name: string): AnthropicEffort | undefined {
  const value = str(name);
  if (!value || value === "default") return undefined;
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) {
    return value as AnthropicEffort;
  }
  throw new Error(`${name} must be one of: default, low, medium, high, xhigh, max`);
}

const anthropicApiKey = str("ANTHROPIC_API_KEY");

export const config = {
  port: num("PORT", 3002),
  databaseUrl: str("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:3099/catalog"),
  storageDir: str("STORAGE_DIR", path.resolve(process.cwd(), ".specific/keys/default/data/volumes/api/storage")),

  anthropicApiKey,
  anthropicWorkspaceId: str("ANTHROPIC_WORKSPACE_ID"),
  orchestratorModel: str("ANTHROPIC_ORCHESTRATOR_MODEL", "claude-opus-5"),
  visionModel: str("ANTHROPIC_VISION_MODEL", "claude-haiku-4-5"),
  orchestratorPromptVersion: str("ANTHROPIC_ORCHESTRATOR_PROMPT_VERSION", "monterra-system-v2"),
  orchestratorEffort: anthropicEffort("ANTHROPIC_EFFORT_ORCHESTRATOR"),
  visionEffort: anthropicEffort("ANTHROPIC_EFFORT_VISION"),
  qaEffort: anthropicEffort("ANTHROPIC_EFFORT_QA"),

  elevenLabsApiKey: str("ELEVENLABS_API_KEY"),
  // "Adam Composer Stockholm" — Stockholm-accented voice already in this account.
  elevenLabsVoiceId: str("ELEVENLABS_VOICE_ID", "x0u3EW21dbrORJzOq1m9"),
  // ElevenLabs' aggregated video-generation endpoint (POST /v1/flows/video).
  // Live model_ids as of the current OpenAPI spec: veo-3.1-generate-001,
  // veo-3.1-fast-generate-001, bytedance-seedance-v2(-fast|-mini|-2.5),
  // creatify-aurora. No sora model_id is exposed by this endpoint yet.
  // Requires an ElevenLabs plan with Flows access — falls back to the real
  // manual-page image per step on any failure (quota, plan, moderation).
  // Default is the cheap tier: Seedance Mini bills ~8 credits/second at
  // 480p vs Veo's ~8,000 credits per flat generation — roughly 100x
  // cheaper for a 14-step guide.
  animatedVideoModel: str("ANIMATED_VIDEO_MODEL", "bytedance-seedance-v2-mini"),
  animatedVideoResolution: str("ANIMATED_VIDEO_RESOLUTION", "480p"),
  animatedVideoDurationSecs: num("ANIMATED_VIDEO_DURATION_SECS", 4),

  firecrawlApiKey: str("FIRECRAWL_API_KEY"),
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET"),
  stripePaymentLinkUrl: str("STRIPE_PAYMENT_LINK_URL"),
  guidePriceSek: num("GUIDE_PRICE_SEK", 49),

  // Mock mode is only for fixtures and local development. Production must
  // fail explicitly when a provider is unavailable rather than fabricate a
  // product match from the demo orchestrator.
  mockOrchestrator: str("MOCK_ORCHESTRATOR", "0") === "1",

  maxTurns: num("PIPELINE_MAX_TURNS", 24),
  jobConcurrency: num("JOB_CONCURRENCY", 2),
  maxCostUsd: Number(process.env.PIPELINE_MAX_COST_USD ?? "3.0"),
  includeMusic: str("INCLUDE_MUSIC", "0") === "1",

  orchestratorEvalToken: str("ORCHESTRATOR_EVAL_TOKEN"),
  orchestratorEvalEnabled: str("ORCHESTRATOR_EVAL_ENABLED", "false") === "true",
  orchestratorEvalLimit: Math.min(20, num("ORCHESTRATOR_EVAL_LIMIT", 2)),
  orchestratorEvalMaxAnthropicUsdPerBatch: Math.min(
    60,
    num("ORCHESTRATOR_EVAL_MAX_ANTHROPIC_USD_PER_BATCH", 25),
  ),

  market: str("IKEA_MARKET", "se"),
  language: str("IKEA_LANGUAGE", "sv"),

  sampleDir: path.resolve(import.meta.dirname, "../assets/sample"),
};

if (config.visionEffort && config.visionModel === "claude-haiku-4-5") {
  throw new Error(
    "ANTHROPIC_EFFORT_VISION requires a model that supports effort; claude-haiku-4-5 does not",
  );
}

export type Config = typeof config;
