import { Hono } from "hono";
import { maybeOne, query } from "../db.js";
import { answerQuestion } from "../pipeline/qa.js";

export const guides = new Hono();

guides.get("/:id", async (c) => {
  const guideId = c.req.param("id");
  const guide = await maybeOne<{
    id: string;
    title: string;
    summary: string | null;
    product_name: string;
    category: string | null;
    duration_seconds: number | null;
    video_key: string | null;
    thumb_key: string | null;
    manual_document_id: string | null;
    manual_url: string | null;
  }>(
    `SELECT ag.id, ag.title, ag.summary, p.name AS product_name, p.category,
            gv.duration_seconds, va.storage_key AS video_key, ta.storage_key AS thumb_key,
            ag.manual_document_id, sd.canonical_url AS manual_url
       FROM assembly_guides ag
       JOIN products p ON p.id = ag.product_id
       LEFT JOIN source_documents sd ON sd.id = ag.manual_document_id
       LEFT JOIN generated_videos gv ON gv.guide_id = ag.id
       LEFT JOIN media_assets va ON va.id = gv.video_asset_id
       LEFT JOIN media_assets ta ON ta.id = gv.thumbnail_asset_id
      WHERE ag.id = $1`,
    [guideId],
  );
  if (!guide) return c.json({ error: "unknown guide" }, 404);

  const steps = await query<{
    step_number: number;
    title: string;
    instruction: string;
    safety_warning: string | null;
    estimated_seconds: number | null;
    parts: string[] | null;
    tools: string[] | null;
    manual_pages: number[] | null;
    focus_region: string | null;
    needs_review: boolean;
  }>(
    `SELECT step_number, title, instruction, safety_warning, estimated_seconds, parts, tools, manual_pages, focus_region, needs_review
       FROM assembly_steps WHERE guide_id = $1 ORDER BY step_number`,
    [guideId],
  );

  return c.json({
    guideId: guide.id,
    title: guide.title,
    summary: guide.summary ?? "",
    productName: guide.product_name,
    category: guide.category,
    videoUrl: guide.video_key ? `/api/assets/${guide.video_key}` : null,
    thumbnailUrl: guide.thumb_key ? `/api/assets/${guide.thumb_key}` : null,
    durationSeconds: guide.duration_seconds ?? 0,
    manualUrl: guide.manual_url,
    steps: steps.map((s) => ({
      stepNumber: s.step_number,
      title: s.title,
      instruction: s.instruction,
      safetyWarning: s.safety_warning,
      estimatedSeconds: s.estimated_seconds ?? 25,
      parts: s.parts ?? [],
      tools: s.tools ?? [],
      manualPages: s.manual_pages ?? [],
      imageUrl: guide.manual_document_id && s.manual_pages?.[0]
        ? `/api/assets/pages/${guide.manual_document_id}/video/p-${s.manual_pages[0]}.png`
        : null,
      audioUrl: s.needs_review ? null : `/api/assets/audio/${guide.id}/step-${String(s.step_number).padStart(2, "0")}.mp3`,
      needsReview: s.needs_review,
      focusRegion: s.focus_region && ["top", "center", "bottom", "full"].includes(s.focus_region) ? s.focus_region : "full",
    })),
  });
});

guides.post("/:id/questions", async (c) => {
  const guideId = c.req.param("id");
  const { question } = await c.req.json<{ question: string }>();
  if (!question?.trim()) return c.json({ error: "question required" }, 400);
  try {
    const answer = await answerQuestion(guideId, question.trim().slice(0, 1000));
    return c.json({ answer });
  } catch (err) {
    return c.json({ answer: `Jag kunde inte svara just nu (${(err as Error).message}). Prova igen om en stund.` });
  }
});
