import { createHash } from "node:crypto";
import { config } from "../env.js";
import { exists, pathFor, putFile } from "../storage.js";
import { VISUAL_STYLE_PREFIX } from "../orchestrator/prompts/style.js";

const BASE = "https://api.elevenlabs.io/v1/flows/video";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface InProgress {
  id: string;
  status: "pending" | "generating";
}
interface Completed {
  id: string;
  status: "completed";
  content_url: string;
  content_mime_type: string;
}
interface Failed {
  id: string;
  status: "failed";
  failure_reason: string;
  error_message: string;
}
type GenerationResponse = InProgress | Completed | Failed;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKeyFor(prompt: string, durationSecs: number): string {
  const hash = createHash("sha1").update(`${config.animatedVideoModel}|${durationSecs}|${prompt}`).digest("hex");
  return `cache/animate/${hash}.mp4`;
}

/**
 * Generate a short animated clip for one assembly step via ElevenLabs'
 * aggregated video endpoint (POST /v1/flows/video, model configurable —
 * see env.ts). Content-hash cached like TTS: identical prompt+model never
 * re-generates (real cost per generation). Returns the local file path.
 * Throws on any failure — callers fall back to the real manual-page image
 * rather than surface a broken step.
 */
export async function generateStepClip(stepPrompt: string, durationSecs = config.animatedVideoDurationSecs): Promise<string> {
  if (!config.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY is not configured");
  const prompt = `${VISUAL_STYLE_PREFIX} ${stepPrompt}`.trim();
  const cacheKey = cacheKeyFor(prompt, durationSecs);
  if (await exists(cacheKey)) return pathFor(cacheKey);

  const startRes = await fetch(BASE, {
    method: "POST",
    headers: { "xi-api-key": config.elevenLabsApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: config.animatedVideoModel,
      prompt,
      duration_secs: durationSecs,
      aspect_ratio: "16:9",
      resolution: config.animatedVideoResolution,
      generate_audio: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!startRes.ok) {
    const body = await startRes.text().catch(() => "");
    throw new Error(`ElevenLabs video generation -> ${startRes.status}: ${body.slice(0, 300)}`);
  }
  const started = (await startRes.json()) as GenerationResponse;
  if (started.status === "failed") throw new Error(`ElevenLabs video generation failed: ${started.error_message}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let result: GenerationResponse = started;
  while (result.status === "pending" || result.status === "generating") {
    if (Date.now() > deadline) throw new Error(`ElevenLabs video generation ${started.id} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${BASE}/${started.id}`, {
      headers: { "xi-api-key": config.elevenLabsApiKey },
      signal: AbortSignal.timeout(30000),
    });
    if (!pollRes.ok) throw new Error(`ElevenLabs video poll -> ${pollRes.status}`);
    result = (await pollRes.json()) as GenerationResponse;
  }
  if (result.status !== "completed") {
    throw new Error(`ElevenLabs video generation failed: ${"error_message" in result ? result.error_message : result.status}`);
  }

  const videoRes = await fetch(result.content_url, { signal: AbortSignal.timeout(60000) });
  if (!videoRes.ok) throw new Error(`Downloading generated clip -> ${videoRes.status}`);
  const data = Buffer.from(await videoRes.arrayBuffer());
  await putFile(cacheKey, data);
  return pathFor(cacheKey);
}
