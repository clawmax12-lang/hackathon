import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { config } from "../env.js";
import { query } from "../db.js";
import { exists, pathFor, putFile, readFile } from "../storage.js";

const exec = promisify(execFile);

function cappedStepNarration(value: string, isLast: boolean): string {
  if (isLast) return "Klart. Snyggt jobbat.";
  const withoutStepLabel = value.trim().replace(/^Steg\s+[^.!?]+[.!?]\s*/iu, "");
  const sentences = withoutStepLabel.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  return sentences.slice(0, 2).join(" ");
}

export async function audioDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
    { timeout: 30000 },
  );
  return Number(stdout.trim()) || 0;
}

async function tts(text: string): Promise<Buffer> {
  const cacheKey = `cache/tts/${createHash("sha1").update(`${config.elevenLabsVoiceId}|${text}`).digest("hex")}.mp3`;
  if (await exists(cacheKey)) return readFile(cacheKey);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": config.elevenLabsApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.2 },
      }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = Buffer.from(await res.arrayBuffer());
  await putFile(cacheKey, data);
  return data;
}

export interface NarrationResult {
  steps: { step_number: number; seconds: number }[];
  intro_seconds: number;
  outro_seconds: number;
  total_characters: number;
}

/** Synthesize Swedish narration for every step plus intro/outro; updates estimated_seconds. */
export async function synthesizeNarration(guideId: string): Promise<NarrationResult> {
  if (!config.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

  const guide = (
    await query<{ title: string; summary: string | null }>(
      "SELECT title, summary FROM assembly_guides WHERE id = $1",
      [guideId],
    )
  )[0];
  if (!guide) throw new Error(`guide ${guideId} not found`);

  const steps = await query<{ step_number: number; title: string; instruction: string; narration_script: string | null; needs_review: boolean }>(
    "SELECT step_number, title, instruction, narration_script, needs_review FROM assembly_steps WHERE guide_id = $1 ORDER BY step_number",
    [guideId],
  );
  if (steps.length === 0) throw new Error("guide has no steps");

  const introText = `${guide.title}. ${guide.summary ?? "Vi bygger den tillsammans, steg för steg."} Lägg fram alla delar och verktyg innan du börjar.`;
  const outroText = "Klart! Bra jobbat. Kontrollera att alla skruvar är åtdragna, och spara instruktionen om du behöver den senare.";

  // Two guide jobs may run at once. Keeping each guide to two concurrent TTS
  // calls stays below ElevenLabs' five-request workspace limit.
  const limit = pLimit(2);
  let totalChars = introText.length + outroText.length;

  const jobs: Promise<void>[] = [];
  const result: NarrationResult = { steps: [], intro_seconds: 0, outro_seconds: 0, total_characters: 0 };

  jobs.push(
    limit(async () => {
      const audio = await tts(introText);
      await putFile(`audio/${guideId}/intro.mp3`, audio);
      result.intro_seconds = await audioDurationSeconds(pathFor(`audio/${guideId}/intro.mp3`));
    }),
  );
  jobs.push(
    limit(async () => {
      const audio = await tts(outroText);
      await putFile(`audio/${guideId}/outro.mp3`, audio);
      result.outro_seconds = await audioDurationSeconds(pathFor(`audio/${guideId}/outro.mp3`));
    }),
  );

  for (const [index, step] of steps.entries()) {
    if (step.needs_review) continue;
    const rawText = step.narration_script?.trim() || `${step.title}. ${step.instruction}`;
    const text = cappedStepNarration(rawText, index === steps.length - 1);
    await query("UPDATE assembly_steps SET narration_script=$1,updated_at=NOW() WHERE guide_id=$2 AND step_number=$3", [text, guideId, step.step_number]);
    totalChars += text.length;
    jobs.push(
      limit(async () => {
        const audio = await tts(text);
        const key = `audio/${guideId}/step-${String(step.step_number).padStart(2, "0")}.mp3`;
        await putFile(key, audio);
        const seconds = await audioDurationSeconds(pathFor(key));
        result.steps.push({ step_number: step.step_number, seconds });
        await query("UPDATE assembly_steps SET estimated_seconds = $1, updated_at = now() WHERE guide_id = $2 AND step_number = $3", [
          Math.ceil(seconds),
          guideId,
          step.step_number,
        ]);
      }),
    );
  }

  await Promise.all(jobs);
  result.steps.sort((a, b) => a.step_number - b.step_number);
  result.total_characters = totalChars;
  return result;
}
