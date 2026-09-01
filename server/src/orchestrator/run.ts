import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config, type AnthropicEffort } from "../env.js";
import { query } from "../db.js";
import { anthropicClient } from "../pipeline/identify.js";
import {
  appendUserTurn,
  REFUSAL_RETRY,
  shouldRetryRefusal,
  TURN_SCOPED_SYSTEM_BETA,
} from "./conversation.js";
import {
  getSystemPrompt,
  guidePromptVersion,
} from "./prompts/system.js";
import { PROMPT_VERSION as STYLE_PROMPT_VERSION } from "./prompts/style.js";
import { estimateAnthropicCostUsd } from "./pricing.js";
import { executeTool, finalizeRun, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";

const PINNED_EVAL_TOOLS = new Set([
  "lookup_catalog",
  "confirm_match",
  "plan_assembly_guide",
  "inspect_manual_region",
  "write_step_to_db",
  "synthesize_narration",
  "render_video",
  "report_progress",
  "finish",
]);

export interface RunOptions {
  jobId: string | null;
  systemPromptVersion?: string;
  effort?: AnthropicEffort;
  maxCostUsd?: number;
}

export interface OrchestratorRunMetrics {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export async function runOrchestrator(ctx: ToolContext, opts: RunOptions): Promise<OrchestratorRunMetrics> {
  const client = anthropicClient();
  let costUsd = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let refusalRetries = 0;
  let costGuardCrossed = false;
  const deadline = Date.now() + 12 * 60 * 1000;
  const systemPromptVersion = opts.systemPromptVersion ?? config.orchestratorPromptVersion;
  const effort = opts.effort ?? config.orchestratorEffort;
  const effectiveEffort = effort ?? "default";
  const maxCostUsd = Math.min(opts.maxCostUsd ?? config.maxCostUsd, config.maxCostUsd);
  const systemPrompt = getSystemPrompt(systemPromptVersion);
  ctx.promptVersion ??= guidePromptVersion(systemPromptVersion, STYLE_PROMPT_VERSION);
  const toolDefinitions = ctx.requiredDocumentId
    ? TOOL_DEFINITIONS.filter((tool) => "name" in tool && PINNED_EVAL_TOOLS.has(tool.name))
    : TOOL_DEFINITIONS;
  const metrics = (): OrchestratorRunMetrics => ({
    turns,
    inputTokens,
    outputTokens,
    estimatedCostUsd: Number(costUsd.toFixed(6)),
  });

  let initialIdentification: string | null = null;
  if (!ctx.pinnedProductId) {
    try {
      const result = await executeTool("identify_product_from_image", {}, ctx);
      initialIdentification = typeof result === "string" ? result : null;
      if (ctx.state.finished) {
        await finalizeRun(ctx);
        return metrics();
      }
    } catch (err) {
      console.warn(`[orchestrator] fast identification failed for scan ${ctx.scanId}; retrying in tool loop`, err);
    }
  }

  const taskLines = [
    `New scan. scan_id: ${ctx.scanId}.`,
    ctx.userNote ? `The user wrote: "${ctx.userNote}"` : "The user attached only a photo.",
    ctx.pinnedProductId
      ? `The user explicitly selected product_id ${ctx.pinnedProductId} — skip identification, confirm this product and proceed.`
      : initialIdentification
        ? "Vision identification is already complete below. Start with lookup_catalog; do not identify the image again."
        : "Identify the product from the photo first.",
    ctx.requiredDocumentId
      ? `This isolated evaluation is pinned to verified document_id ${ctx.requiredDocumentId}; use that exact manual.`
      : "",
    "Drive the pipeline to a finished video, then call finish.",
    initialIdentification ? `IDENTIFICATION_RESULT:\n${initialIdentification}` : "",
  ];

  const messages: BetaMessageParam[] = [];
  appendUserTurn(messages, taskLines.join("\n"));

  while (turns < config.maxTurns) {
    if (Date.now() > deadline) throw new Error("orchestrator deadline exceeded (12 min)");
    const isCostGuardClosingTurn = costGuardCrossed;
    turns += 1;

    const resp = await client.beta.messages.create(
      {
        betas: [TURN_SCOPED_SYSTEM_BETA],
        model: config.orchestratorModel,
        max_tokens: 16000,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: toolDefinitions,
        messages,
        ...(effort
          ? { output_config: { effort } }
          : {}),
      },
      { timeout: 300000 },
    );

    const inTok = resp.usage.input_tokens + (resp.usage.cache_creation_input_tokens ?? 0);
    const cacheTok = resp.usage.cache_read_input_tokens ?? 0;
    inputTokens += inTok + cacheTok;
    outputTokens += resp.usage.output_tokens;
    costUsd += estimateAnthropicCostUsd(resp.model, resp.usage);
    if (costUsd > maxCostUsd) costGuardCrossed = true;
    const requestedToolUses = resp.content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
    const toolUses = isCostGuardClosingTurn
      ? requestedToolUses.filter((toolUse) => toolUse.name === "finish")
      : requestedToolUses;
    if (opts.jobId) {
      await query(
        `INSERT INTO job_attempts
           (job_id, attempt_number, provider, model, input_tokens, output_tokens,
            estimated_cost_usd, effort, stop_reason, prompt_version,
            tool_calls_in_turn, finished_at)
         VALUES ($1, $2, 'anthropic', $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          opts.jobId,
          turns,
          resp.model,
          inTok + cacheTok,
          resp.usage.output_tokens,
          costUsd.toFixed(4),
          effectiveEffort,
          resp.stop_reason,
          systemPromptVersion,
          requestedToolUses.length,
        ],
      ).catch((error) => {
        console.warn(`[orchestrator] failed to record attempt ${turns} for job ${opts.jobId}`, error);
      });
    }
    console.info(
      JSON.stringify({
        event: "orchestrator_turn",
        scan_id: ctx.scanId,
        job_id: opts.jobId,
        turn: turns,
        model: resp.model,
        effort: effectiveEffort,
        prompt_version: systemPromptVersion,
        stop_reason: resp.stop_reason,
        tool_calls: requestedToolUses.length,
        input_tokens: inTok + cacheTok,
        output_tokens: resp.usage.output_tokens,
        cumulative_cost_usd: Number(costUsd.toFixed(4)),
      }),
    );

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "refusal") {
      if (shouldRetryRefusal(refusalRetries, costUsd, maxCostUsd)) {
        refusalRetries += 1;
        appendUserTurn(messages, REFUSAL_RETRY);
        continue;
      }
      ctx.state.finished = {
        outcome: "failed",
        message: "Guiden kunde inte skapas eftersom modellförfrågan stoppades. Försök igen med en tydligare produktbild.",
      };
      break;
    }

    if (isCostGuardClosingTurn && toolUses.length === 0) {
      ctx.state.finished = {
        outcome: "failed",
        message: "Genereringen stoppades när kostnadsgränsen nåddes.",
      };
      break;
    }

    // A response can contain valid tool calls even when the provider labels the
    // stop as max_tokens. Always execute the calls that are actually present.
    if (toolUses.length === 0) {
      if (!ctx.state.finished && turns < config.maxTurns && costUsd <= maxCostUsd) {
        appendUserTurn(
          messages,
          "Fortsätt nu genom att anropa nästa nödvändiga verktyg. Avsluta inte med vanlig text; kalla finish när guiden är klar eller ärligt blockerad.",
        );
        continue;
      }
      if (!ctx.state.finished) ctx.state.finished = { outcome: "failed", message: "Orkestreringen avbröts oväntat." };
      break;
    }

    const results = await Promise.all(
      toolUses.map(async (tu): Promise<BetaToolResultBlockParam> => {
        try {
          const content = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx);
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content,
          };
        } catch (err) {
          return { type: "tool_result", tool_use_id: tu.id, content: `Tool failed: ${(err as Error).message}`, is_error: true };
        }
      }),
    );

    const followup: BetaContentBlockParam[] = [...results];
    appendUserTurn(messages, followup, {
      costGuardMessage:
        costUsd > maxCostUsd
          ? `Cost guard reached ($${costUsd.toFixed(2)} > $${maxCostUsd.toFixed(2)}). Finish now: if the video is rendered call finish(success); otherwise call finish(failed) with a helpful Swedish message.`
          : undefined,
    });

    if (isCostGuardClosingTurn) {
      ctx.state.finished ??= {
        outcome: "failed",
        message: "Genereringen stoppades när kostnadsgränsen nåddes.",
      };
      break;
    }
    if (ctx.state.finished) break;
  }

  if (!ctx.state.finished) {
    ctx.state.finished = { outcome: "failed", message: "Genereringen tog för många steg och avbröts." };
  }
  await finalizeRun(ctx);
  return metrics();
}
