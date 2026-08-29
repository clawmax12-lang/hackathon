import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../env.js";
import { executeTool, finalizeRun, type ToolContext } from "./tools.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Demo-day safety net: walks the SAME state machine through the SAME tool
 * implementations — real DB lookups, real manual fetch (live IKEA, with the
 * bundled KALLAX PDF as offline fallback), real ElevenLabs narration, real
 * ffmpeg render. Only the reasoning is scripted.
 */
export async function runMockOrchestrator(ctx: ToolContext): Promise<void> {
  const call = (name: string, input: Record<string, unknown> = {}) => executeTool(name, input, ctx);

  try {
    // Stage 0-1: identification. Use real vision when a key exists, else canned KALLAX.
    let name = "KALLAX";
    let variant: string | null = "77x77 vit";
    let itemNumbers: string[] = ["20275814"];
    if (config.anthropicApiKey) {
      const idJson = JSON.parse(String(await call("identify_product_from_image")));
      if (idJson.product_name_guess) {
        name = idJson.product_name_guess;
        variant = idJson.variant_guess;
        itemNumbers = idJson.item_number_candidates ?? [];
      }
    } else {
      await call("report_progress", { stage_index: 0, message: "Läser etiketten på förpackningen…" });
      await sleep(700);
      await call("report_progress", { stage_index: 1, message: `Det ser ut som ${name} ${variant ?? ""}.` });
    }

    // Stage 1: catalog lookup (real query)
    let lookup = JSON.parse(String(await call("lookup_catalog", { name_query: name, item_numbers: itemNumbers, variant })));
    let candidate = lookup.candidates[0];

    // Not in catalog -> discover on the web and register (real network path)
    if (!candidate) {
      const found = JSON.parse(String(await call("firecrawl_find_manual", { product_name: name, item_number: itemNumbers[0] ?? null })));
      if (found.product_url && found.item_number) {
        await call("register_product_from_web", {
          name: found.product_name ?? name,
          item_number: found.item_number,
          product_url: found.product_url,
          category: null,
          description: null,
        });
        lookup = JSON.parse(String(await call("lookup_catalog", { name_query: found.product_name ?? name, item_numbers: [found.item_number], variant: null })));
        candidate = lookup.candidates[0];
      }
    }
    if (!candidate) throw new Error(`hittade ingen produkt för "${name}"`);

    await call("confirm_match", {
      product_id: ctx.pinnedProductId ?? candidate.product_id,
      confidence: ctx.pinnedProductId ? 1 : Math.max(0.62, candidate.score ?? 0.62),
      method: ctx.pinnedProductId ? "manual_review" : itemNumbers.length ? "item_number" : "fuzzy_name",
      alternatives: lookup.candidates.slice(1, 4).map((c: { product_id: string }) => c.product_id),
    });
    const productId = ctx.pinnedProductId ?? candidate.product_id;

    // Stage 2: manual. verified catalog manual -> reuse; else discover live; else bundled sample.
    let documentId: string | null = candidate.manual?.verified ? candidate.manual.document_id : null;
    if (documentId) {
      await call("report_progress", { stage_index: 2, message: "Manualen finns redan verifierad i katalogen." });
      ctx.state.documentId = documentId;
    } else {
      await call("report_progress", { stage_index: 2, message: "Hämtar den officiella manualen från ikea.com…" });
      let urls: { url: string }[] = [];
      if (candidate.manual?.canonical_url && candidate.manual.canonical_url.startsWith("http")) {
        urls.push({ url: candidate.manual.canonical_url });
      }
      try {
        const found = JSON.parse(String(await call("firecrawl_find_manual", { product_name: candidate.name, item_number: candidate.item_number })));
        urls.push(...(found.manual_urls ?? []));
      } catch {
        /* offline */
      }
      urls.push({ url: `file://${path.join(config.sampleDir, "kallax-manual.pdf")}` }); // offline fallback

      for (const { url } of urls) {
        if (url.startsWith("file://")) {
          try {
            await fs.access(url.slice(7));
          } catch {
            continue;
          }
        }
        const res = JSON.parse(String(await call("fetch_and_verify_manual_pdf", { url, product_id: productId })));
        if (res.ok) {
          documentId = res.document_id;
          break;
        }
        await call("report_progress", { stage_index: 2, message: `Länken var död (${res.failure_reason}). Provar nästa…` });
      }
    }
    if (!documentId) throw new Error("ingen manual kunde verifieras");

    // Stage 3: guide. Reuse existing steps if this guide was generated before.
    const planned = await call("plan_assembly_guide", {
      product_id: productId,
      document_id: documentId,
      title: `Så monterar du ${candidate.name}`,
      summary: `Vi monterar ${candidate.name} lugnt och metodiskt, ett moment i taget.`,
    });
    void planned;
    const guideId = ctx.state.guideId;
    if (!guideId) throw new Error("guide skapades inte");

    const { query } = await import("../db.js");
    const existingSteps = await query<{ n: string }>("SELECT count(*) n FROM assembly_steps WHERE guide_id = $1", [guideId]);
    if (Number(existingSteps[0]?.n ?? 0) === 0) {
      const samplePath = path.join(config.sampleDir, "sample-guide.json");
      const steps: Record<string, unknown>[] = JSON.parse(await fs.readFile(samplePath, "utf8"));
      await call("report_progress", { stage_index: 3, message: `Planerar ${steps.length} steg…` });
      for (const step of steps) {
        await call("write_step_to_db", step);
        await sleep(120);
      }
    } else {
      await call("report_progress", { stage_index: 3, message: "Återanvänder befintlig guideplan." });
    }

    // Stage 4: narration + render (both real)
    await call("synthesize_narration");
    await call("render_video");
    await call("finish", { outcome: "success", message: "Din monteringsguide är klar!" });
  } catch (err) {
    await call("finish", { outcome: "failed", message: `Något gick fel: ${(err as Error).message}` }).catch(() => {});
  }
  await finalizeRun(ctx);
}
