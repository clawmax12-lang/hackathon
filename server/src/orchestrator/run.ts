import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../env.js";
import { query } from "../db.js";
import { anthropicClient } from "../pipeline/identify.js";
import { SYSTEM_PROMPT } from "./prompts/system.js";
import { executeTool, finalizeRun, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";

// claude-opus-5 pricing; close enough for guard purposes on other models.
const USD_PER_INPUT_TOKEN = 5 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 25 / 1_000_000;
const USD_PER_CACHE_READ_TOKEN = 0.5 / 1_000_000;

export interface RunOptions {
  jobId: string | null;
}

export async function runOrchestrator(ctx: ToolContext, opts: RunOptions): Promise<void> {
  const client = anthropicClient();
  let costUsd = 0;
  let turns = 0;
  const deadline = Date.now() + 12 * 60 * 1000;

  const taskLines = [
    `New scan. scan_id: ${ctx.scanId}.`,
    ctx.userNote ? `The user wrote: "${ctx.userNote}"` : "The user attached only a photo.",
    ctx.pinnedProductId
      ? `The user explicitly selected product_id ${ctx.pinnedProductId} — skip identification, confirm this product and proceed.`
      : "Identify the product from the photo first.",
    "Drive the pipeline to a finished video, then call finish.",
  ];

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: taskLines.join("\n") }];

  while (turns < config.maxTurns) {
    if (Date.now() > deadline) throw new Error("orchestrator deadline exceeded (12 min)");
    turns += 1;

    const resp = await client.messages.create(
      {
        model: config.orchestratorModel,
        max_tokens: 16000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOL_DEFINITIONS,
        messages,
      },
      { timeout: 300000 },
    );

    const inTok = resp.usage.input_tokens + (resp.usage.cache_creation_input_tokens ?? 0);
    const cacheTok = resp.usage.cache_read_input_tokens ?? 0;
    costUsd += inTok * USD_PER_INPUT_TOKEN + cacheTok * USD_PER_CACHE_READ_TOKEN + resp.usage.output_tokens * USD_PER_OUTPUT_TOKEN;
    if (opts.jobId) {
      await query(
        `INSERT INTO job_attempts (job_id, attempt_number, provider, model, input_tokens, output_tokens, estimated_cost_usd)
         VALUES ($1, $2, 'anthropic', $3, $4, $5, $6)`,
        [opts.jobId, turns, resp.model, inTok + cacheTok, resp.usage.output_tokens, costUsd.toFixed(4)],
      ).catch(() => {});
    }

    messages.push({ role: "assistant", content: resp.content });

    // A response can contain valid tool calls even when the provider labels the
    // stop as max_tokens. Always execute the calls that are actually present.
    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (!ctx.state.finished && turns < config.maxTurns && costUsd <= config.maxCostUsd) {
        messages.push({ role: "user", content: "Fortsätt nu genom att anropa nästa nödvändiga verktyg. Avsluta inte med vanlig text; kalla finish när guiden är klar eller ärligt blockerad." });
        continue;
      }
      if (!ctx.state.finished) ctx.state.finished = { outcome: "failed", message: "Orkestreringen avbröts oväntat." };
      break;
    }

    const results = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
        try {
          const content = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx);
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: typeof content === "string" ? content : (content as Anthropic.ToolResultBlockParam["content"]),
          };
        } catch (err) {
          return { type: "tool_result", tool_use_id: tu.id, content: `Tool failed: ${(err as Error).message}`, is_error: true };
        }
      }),
    );

    const followup: Anthropic.ContentBlockParam[] = [...results];
    if (costUsd > config.maxCostUsd) {
      followup.push({
        type: "text",
        text: `SYSTEM: cost guard reached ($${costUsd.toFixed(2)} > $${config.maxCostUsd}). Finish now: if the video is rendered call finish(success); otherwise call finish(failed) with a helpful Swedish message.`,
      });
    }
    messages.push({ role: "user", content: followup });

    if (ctx.state.finished) break;
  }

  if (!ctx.state.finished) {
    ctx.state.finished = { outcome: "failed", message: "Genereringen tog för många steg och avbröts." };
  }
  await finalizeRun(ctx);
}
