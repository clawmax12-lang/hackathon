import type Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import { config } from "../env.js";
import { maybeOne, one, query } from "../db.js";
import { hub, STAGE_INDEX, type ScanEvent, type StageKey } from "../sse.js";
import { findReadyGuideByItemNumbers, getProduct, lookupCatalog, registerProductFromWeb } from "../pipeline/catalog.js";
import { discoverManual, fetchAndVerifyManualPdf, getManualDocument, listPageFiles } from "../pipeline/manual.js";
import { identifyProductFromImage } from "../pipeline/identify.js";
import { synthesizeNarration } from "../pipeline/narration.js";
import { renderVideo } from "../pipeline/render.js";
import { PROMPT_VERSION, productPrompt, STYLE_PROMPT } from "./prompts/style.js";

export interface ToolContext {
  scanId: string;
  scanImageKey: string;
  userNote: string | null;
  pinnedProductId: string | null;
  state: {
    productId?: string;
    documentId?: string;
    guideId?: string;
    guideTitle?: string;
    videoUrl?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    stepCount?: number;
    finished?: { outcome: "success" | "failed"; message: string };
  };
}

export function emit(ctx: ToolContext, event: ScanEvent): void {
  hub.emit(ctx.scanId, event);
}

function stage(ctx: ToolContext, key: StageKey, status: "started" | "done", detail?: string): void {
  emit(ctx, { type: "stage", index: STAGE_INDEX[key], key, status, detail });
}

async function finishFromReadyGuide(ctx: ToolContext, itemNumbers: string[]): Promise<boolean> {
  const cached = await findReadyGuideByItemNumbers(itemNumbers);
  if (!cached) return false;

  await query(
    `UPDATE furniture_scans
        SET status = 'matched', extracted_item_number = $2, matched_product_id = $3,
            match_method = 'item_number', match_confidence = 0.98
      WHERE id = $1`,
    [ctx.scanId, cached.item_number, cached.product_id],
  );
  ctx.state.productId = cached.product_id;
  ctx.state.guideId = cached.guide_id;
  ctx.state.guideTitle = cached.guide_title;
  ctx.state.stepCount = cached.step_count;

  stage(ctx, "reading_label", "done", `Läste art.nr ${cached.item_number}`);
  stage(ctx, "identifying", "started");
  emit(ctx, {
    type: "product_match",
    productId: cached.product_id,
    name: cached.product_name,
    itemNumber: cached.item_number,
    variant: cached.variant ?? undefined,
    confidence: 0.98,
    method: "item_number",
    candidates: [],
  });
  stage(ctx, "identifying", "done", `${cached.product_name} · exakt artikelnummer`);
  stage(ctx, "finding_instructions", "started", "Kontrollerar den färdiga guiden…");
  stage(ctx, "finding_instructions", "done", "Verifierad manual och guide hittad i cache");
  stage(ctx, "planning", "started");
  stage(ctx, "planning", "done", `${cached.step_count} färdiga steg`);
  stage(ctx, "rendering", "started");
  stage(ctx, "rendering", "done", "Berättarröst och guide klara");
  ctx.state.finished = { outcome: "success", message: "Den färdiga guiden hittades via exakt artikelnummer." };
  return true;
}

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "identify_product_from_image",
    description: "Run vision analysis on the user's scan photo: OCR all text and infer the IKEA product family.",
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: "lookup_catalog",
    description: "Search the product catalog by name and/or item numbers. Returns candidates with manual availability (verified = PDF bytes actually stored).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["name_query", "item_numbers", "variant"],
      properties: {
        name_query: { type: ["string", "null"] },
        item_numbers: { type: "array", items: { type: "string" } },
        variant: { type: ["string", "null"] },
      },
    },
  },
  {
    name: "firecrawl_find_manual",
    description: "Discover the official assembly manual PDF for a product on ikea.com (web search + product page scrape).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["product_name", "item_number"],
      properties: {
        product_name: { type: "string" },
        item_number: { type: ["string", "null"] },
      },
    },
  },
  {
    name: "fetch_and_verify_manual_pdf",
    description: "Download a manual PDF, verify it is a real PDF, checksum and store it, link it to the product, and render its pages. The only way to make a manual usable.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url", "product_id"],
      properties: { url: { type: "string" }, product_id: { type: "string" } },
    },
  },
  {
    name: "register_product_from_web",
    description: "Insert or update a product discovered on the web (fallback-scrape path). Idempotent by item number.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "item_number", "product_url", "category", "description"],
      properties: {
        name: { type: "string" },
        item_number: { type: "string" },
        product_url: { type: "string" },
        category: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
      },
    },
  },
  {
    name: "confirm_match",
    description: "Record the matched product on the scan and show the user the match with alternatives.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "confidence", "method", "alternatives"],
      properties: {
        product_id: { type: "string" },
        confidence: { type: "number" },
        method: { type: "string", enum: ["item_number", "alias", "fuzzy_name", "fallback_scrape", "manual_review"] },
        alternatives: { type: "array", items: { type: "string" }, description: "candidate product_ids, best first" },
      },
    },
  },
  {
    name: "plan_assembly_guide",
    description:
      "Create the guide record and receive the style guide plus EVERY manual page as an image. Read the diagrams, then write all steps with write_step_to_db.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["product_id", "document_id", "title", "summary"],
      properties: {
        product_id: { type: "string" },
        document_id: { type: "string" },
        title: { type: "string", description: "Swedish video title, e.g. 'Så monterar du KALLAX 77×77'" },
        summary: { type: "string", description: "One Swedish sentence describing the build." },
      },
    },
  },
  {
    name: "write_step_to_db",
    description: "Write one assembly step. Emit ALL steps as parallel tool calls in a single reply.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "step_number",
        "title",
        "instruction",
        "narration_script",
        "safety_warning",
        "manual_pages",
        "parts",
        "tools",
        "estimated_seconds",
        "focus_page",
        "focus_region",
        "visual_prompt",
        "needs_review",
      ],
      properties: {
        step_number: { type: "integer", minimum: 1 },
        title: { type: "string", description: "Short Swedish step title" },
        instruction: { type: "string", description: "1-2 Swedish sentences shown as text" },
        narration_script: { type: "string", description: "At most 2 short Swedish sentences of spoken narration" },
        safety_warning: { type: ["string", "null"] },
        manual_pages: { type: "array", items: { type: "integer" } },
        parts: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
        estimated_seconds: { type: "integer" },
        focus_page: { type: "integer", description: "Manual page shown during this step" },
        focus_region: { type: "string", enum: ["top", "center", "bottom", "full"] },
        visual_prompt: {
          type: "string",
          description:
            "English image-generation prompt for this step only (no style restatement, no faces) — see VISUAL_PROMPT rules",
        },
        needs_review: { type: "boolean", description: "True when the manual image is ambiguous; never guess." },
      },
    },
  },
  {
    name: "synthesize_narration",
    description: "Generate ElevenLabs narration audio for every written step plus intro/outro.",
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: "render_video",
    description: "Render the final video from manual pages + narration. Returns URLs.",
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: "report_progress",
    description: "Show the user a short Swedish progress note under the current stage.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["stage_index", "message"],
      properties: {
        stage_index: { type: "integer", minimum: 0, maximum: 4 },
        message: { type: "string" },
      },
    },
  },
  {
    name: "finish",
    description: "Terminate the run.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "message"],
      properties: {
        outcome: { type: "string", enum: ["success", "failed"] },
        message: { type: "string", description: "Swedish, user-facing" },
      },
    },
  },
];

type ToolResultContent = string | Anthropic.ContentBlockParam[];

export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultContent> {
  switch (name) {
    case "identify_product_from_image": {
      stage(ctx, "reading_label", "started");
      await query("UPDATE furniture_scans SET status = 'recognizing' WHERE id = $1", [ctx.scanId]);
      const id = await identifyProductFromImage(ctx.scanImageKey, ctx.userNote);
      await query("UPDATE furniture_scans SET extracted_text = $2, extracted_item_number = $3 WHERE id = $1", [
        ctx.scanId,
        id.visible_text.slice(0, 4000),
        id.item_number_candidates[0] ?? null,
      ]);
      if (await finishFromReadyGuide(ctx, id.item_number_candidates)) {
        return JSON.stringify({ ...id, user_note: ctx.userNote, cache_hit: true });
      }
      stage(ctx, "reading_label", "done", id.product_name_guess ? `Läste: ${id.product_name_guess}` : undefined);
      stage(ctx, "identifying", "started");
      return JSON.stringify({ ...id, user_note: ctx.userNote });
    }

    case "lookup_catalog": {
      const res = await lookupCatalog(input as never);
      return JSON.stringify(res);
    }

    case "firecrawl_find_manual": {
      stage(ctx, "finding_instructions", "started");
      const res = await discoverManual(String(input.product_name), (input.item_number as string | null) ?? null);
      return JSON.stringify(res);
    }

    case "fetch_and_verify_manual_pdf": {
      stage(ctx, "finding_instructions", "started");
      const res = await fetchAndVerifyManualPdf(String(input.url), String(input.product_id));
      if (res.ok) {
        ctx.state.documentId = res.document_id;
        stage(ctx, "finding_instructions", "done", `Manual verifierad · ${res.page_count} sidor`);
      }
      return JSON.stringify(res);
    }

    case "register_product_from_web": {
      const res = await registerProductFromWeb(input as never);
      return JSON.stringify(res);
    }

    case "confirm_match": {
      const productId = String(input.product_id);
      const product = await getProduct(productId);
      if (!product) return JSON.stringify({ ok: false, error: "unknown product_id" });
      ctx.state.productId = productId;
      const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));
      await query(
        `UPDATE furniture_scans SET status = 'matched', matched_product_id = $2, match_method = $3, match_confidence = $4 WHERE id = $1`,
        [ctx.scanId, productId, String(input.method), confidence],
      );
      const altIds = (input.alternatives as string[]) ?? [];
      const candidates = [];
      for (const id of altIds.slice(0, 4)) {
        const p = await getProduct(id);
        if (p && p.id !== productId) candidates.push({ productId: p.id, name: p.name, confidence: 0 });
      }
      emit(ctx, {
        type: "product_match",
        productId,
        name: product.name,
        itemNumber: product.ikea_item_number,
        confidence,
        method: String(input.method),
        candidates,
      });
      stage(ctx, "identifying", "done", `${product.name} · ${Math.round(confidence * 100)} %`);
      return JSON.stringify({ ok: true, product });
    }

    case "plan_assembly_guide": {
      stage(ctx, "planning", "started");
      const productId = String(input.product_id);
      const documentId = String(input.document_id);
      const product = await getProduct(productId);
      const doc = await getManualDocument(documentId);
      if (!product || !doc) return JSON.stringify({ ok: false, error: "unknown product or document" });

      // Reuse the existing guide for this product+manual+prompt (guides are generated once and reused).
      const existing = await maybeOne<{ id: string }>(
        `SELECT id FROM assembly_guides WHERE product_id = $1 AND manual_document_id = $2 AND prompt_version = $3 LIMIT 1`,
        [productId, documentId, PROMPT_VERSION],
      );
      const guide = existing
        ? await one<{ id: string }>(
            `UPDATE assembly_guides SET status = 'generating', title = $2, summary = $3, updated_at = now() WHERE id = $1 RETURNING id`,
            [existing.id, String(input.title), String(input.summary)],
          )
        : await one<{ id: string }>(
            `INSERT INTO assembly_guides (product_id, manual_document_id, status, language, title, summary, generator_provider, generator_model, prompt_version, source_fingerprint)
             VALUES ($1, $2, 'generating', 'sv', $3, $4, 'anthropic', $5, $6, $7)
             RETURNING id`,
            [productId, documentId, String(input.title), String(input.summary), config.orchestratorModel, PROMPT_VERSION, doc.checksum_sha256 ?? ""],
          );
      ctx.state.guideId = guide.id;
      ctx.state.guideTitle = String(input.title);
      ctx.state.productId = productId;
      ctx.state.documentId = documentId;

      const pages = await listPageFiles(documentId, "vision");
      const blocks: Anthropic.ContentBlockParam[] = [
        { type: "text", text: STYLE_PROMPT },
        {
          type: "text",
          text: productPrompt({
            productName: product.name,
            itemNumber: product.ikea_item_number,
            category: product.category,
            pageCount: pages.length,
          }) + `\n\nguide_id: ${guide.id}`,
        },
      ];
      for (let i = 0; i < pages.length; i++) {
        blocks.push({ type: "text", text: `Sida ${i + 1}:` });
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: (await fs.readFile(pages[i])).toString("base64") },
        });
      }
      return blocks;
    }

    case "write_step_to_db": {
      if (!ctx.state.guideId) return JSON.stringify({ ok: false, error: "call plan_assembly_guide first" });
      await query(
        `INSERT INTO assembly_steps (guide_id, step_number, title, instruction, narration_script, safety_warning, estimated_seconds, manual_pages, parts, tools, focus_page, focus_region, visual_prompt, needs_review)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (guide_id, step_number) DO UPDATE
           SET title = EXCLUDED.title, instruction = EXCLUDED.instruction, narration_script = EXCLUDED.narration_script,
               safety_warning = EXCLUDED.safety_warning, estimated_seconds = EXCLUDED.estimated_seconds,
               manual_pages = EXCLUDED.manual_pages, parts = EXCLUDED.parts, tools = EXCLUDED.tools,
               focus_page = EXCLUDED.focus_page, focus_region = EXCLUDED.focus_region,
               visual_prompt = EXCLUDED.visual_prompt, needs_review = EXCLUDED.needs_review, updated_at = now()`,
        [
          ctx.state.guideId,
          Number(input.step_number),
          String(input.title),
          String(input.instruction),
          String(input.narration_script),
          (input.safety_warning as string | null) ?? null,
          Number(input.estimated_seconds) || 25,
          (input.manual_pages as number[]) ?? [],
          JSON.stringify((input.parts as string[]) ?? []),
          JSON.stringify((input.tools as string[]) ?? []),
          Number(input.focus_page) || 1,
          String(input.focus_region ?? "full"),
          String(input.visual_prompt ?? ""),
          Boolean(input.needs_review),
        ],
      );
      return JSON.stringify({ ok: true });
    }

    case "synthesize_narration": {
      if (!ctx.state.guideId) return JSON.stringify({ ok: false, error: "no guide yet" });
      const count = await maybeOne<{ n: string }>("SELECT count(*) n FROM assembly_steps WHERE guide_id = $1", [ctx.state.guideId]);
      stage(ctx, "planning", "done", `${count?.n ?? "?"} steg planerade`);
      stage(ctx, "rendering", "started", "Skapar berättarröst…");
      const res = await synthesizeNarration(ctx.state.guideId);
      ctx.state.stepCount = res.steps.length;
      await query("UPDATE assembly_guides SET status='ready',published_at=NOW(),updated_at=NOW() WHERE id=$1", [ctx.state.guideId]);
      stage(ctx, "rendering", "done", `${res.steps.length} ljudsteg klara`);
      return JSON.stringify(res);
    }

    case "render_video": {
      if (!ctx.state.guideId) return JSON.stringify({ ok: false, error: "no guide yet" });
      const res = await renderVideo(ctx.state.guideId, (done, total, label) =>
        emit(ctx, { type: "render_progress", done, total, label }),
      );
      ctx.state.videoUrl = res.video_url;
      ctx.state.thumbnailUrl = res.thumbnail_url;
      ctx.state.durationSeconds = res.duration_seconds;
      stage(ctx, "rendering", "done", `${Math.floor(res.duration_seconds / 60)}:${String(res.duration_seconds % 60).padStart(2, "0")}`);
      return JSON.stringify(res);
    }

    case "report_progress": {
      const idx = Math.max(0, Math.min(4, Number(input.stage_index) || 0)) as 0 | 1 | 2 | 3 | 4;
      const keys: StageKey[] = ["reading_label", "identifying", "finding_instructions", "planning", "rendering"];
      emit(ctx, { type: "stage", index: idx, key: keys[idx], status: "started", detail: String(input.message) });
      return JSON.stringify({ ok: true });
    }

    case "finish": {
      ctx.state.finished = { outcome: input.outcome as "success" | "failed", message: String(input.message) };
      return JSON.stringify({ ok: true });
    }

    default:
      return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
  }
}

/** Emits the terminal SSE events once the orchestrator (real or mock) is done. */
export async function finalizeRun(ctx: ToolContext): Promise<void> {
  const fin = ctx.state.finished;
  if (fin?.outcome === "success" && ctx.state.guideId) {
    const stepCount = ctx.state.stepCount ?? 0;
    emit(ctx, {
      type: "guide_ready",
      guideId: ctx.state.guideId,
      title: ctx.state.guideTitle ?? "Din monteringsguide",
      videoUrl: ctx.state.videoUrl ?? "",
      thumbnailUrl: ctx.state.thumbnailUrl ?? "",
      durationSeconds: ctx.state.durationSeconds ?? 0,
      stepCount,
    });
    emit(ctx, { type: "done" });
    await query("UPDATE furniture_scans SET status = 'matched', processed_at = now() WHERE id = $1", [ctx.scanId]);
  } else {
    emit(ctx, {
      type: "error",
      stage: "rendering",
      message: fin?.message ?? "Något gick fel under genereringen.",
      recoverable: true,
    });
    await query("UPDATE furniture_scans SET status = 'failed', processed_at = now() WHERE id = $1", [ctx.scanId]);
  }
}
