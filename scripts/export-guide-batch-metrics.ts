import fs from "node:fs/promises";
import path from "node:path";
import { query } from "../server/src/db.js";
import { exists } from "../server/src/storage.js";

const TARGET_ARTICLES = [
  "70253541", "10542115", "70242656", "30497490", "10564616",
  "80396865", "20538721", "50178411", "30454004", "20544492",
  "30488966", "60491038", "80096372", "50333049", "10539066",
  "00314468", "50461937", "30401510", "10203610", "10269696",
];

interface GuideMetric {
  article_number: string;
  product: string;
  guide_id: string;
  manual_url: string;
  manual_pages: number;
  steps: number;
  needs_review_steps: number;
  generation_attempts: number;
  failed_attempts: number;
  generation_seconds: number;
  estimated_cost_usd: string;
  input_tokens: number;
  output_tokens: number;
}

interface StepAudit {
  guide_id: string;
  step_number: number;
  narration_script: string | null;
  manual_pages: number[] | null;
  needs_review: boolean;
  page_count: number;
}

function sentenceCount(value: string): number {
  return value.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean).length ?? 0;
}

async function main(): Promise<void> {
  const rows = await query<GuideMetric>(
    `SELECT p.article_no AS article_number,p.name AS product,
            ag.id AS guide_id,sd.canonical_url AS manual_url,sd.page_count AS manual_pages,
            steps.steps,steps.needs_review_steps,
            COALESCE(jobs.generation_attempts,0)::int AS generation_attempts,
            COALESCE(jobs.failed_attempts,0)::int AS failed_attempts,
            COALESCE(jobs.generation_seconds,0)::int AS generation_seconds,
            COALESCE(jobs.estimated_cost_usd,0)::text AS estimated_cost_usd,
            COALESCE(jobs.input_tokens,0)::int AS input_tokens,
            COALESCE(jobs.output_tokens,0)::int AS output_tokens
       FROM products p
       JOIN LATERAL (
         SELECT candidate.* FROM assembly_guides candidate
          WHERE candidate.product_id=p.id AND candidate.status='ready'
          ORDER BY candidate.published_at DESC NULLS LAST LIMIT 1
       ) ag ON TRUE
       JOIN source_documents sd ON sd.id=ag.manual_document_id AND sd.status='ready'
       JOIN LATERAL (
         SELECT count(*)::int AS steps,
                count(*) FILTER (WHERE s.needs_review)::int AS needs_review_steps
           FROM assembly_steps s WHERE s.guide_id=ag.id
       ) steps ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS generation_attempts,
                count(*) FILTER (WHERE rolled.status='failed')::int AS failed_attempts,
                round(sum(rolled.seconds))::int AS generation_seconds,
                sum(rolled.cost) AS estimated_cost_usd,
                sum(rolled.input_tokens)::int AS input_tokens,
                sum(rolled.output_tokens)::int AS output_tokens
           FROM (
             SELECT j.status,
                    COALESCE(extract(epoch FROM j.completed_at-j.started_at),0) AS seconds,
                    COALESCE((SELECT max(ja.estimated_cost_usd) FROM job_attempts ja WHERE ja.job_id=j.id),0) AS cost,
                    COALESCE((SELECT sum(ja.input_tokens) FROM job_attempts ja WHERE ja.job_id=j.id),0) AS input_tokens,
                    COALESCE((SELECT sum(ja.output_tokens) FROM job_attempts ja WHERE ja.job_id=j.id),0) AS output_tokens
               FROM ingestion_jobs j
              WHERE j.kind='guide_generation' AND j.input->>'pinned_product_id'=p.id::text
           ) rolled
       ) jobs ON TRUE
      WHERE p.article_no=ANY($1::text[])
      ORDER BY array_position($1::text[],p.article_no)`,
    [TARGET_ARTICLES],
  );

  const steps = await query<StepAudit>(
    `SELECT s.guide_id,s.step_number,s.narration_script,s.manual_pages,s.needs_review,sd.page_count
       FROM assembly_steps s
       JOIN assembly_guides ag ON ag.id=s.guide_id AND ag.status='ready'
       JOIN products p ON p.id=ag.product_id
       JOIN source_documents sd ON sd.id=ag.manual_document_id
      WHERE p.article_no=ANY($1::text[])
      ORDER BY s.guide_id,s.step_number`,
    [TARGET_ARTICLES],
  );

  const invalidPageReferences: string[] = [];
  const overlongNarrations: string[] = [];
  const invalidFinalNarrations: string[] = [];
  const missingAudio: string[] = [];
  for (const row of rows) {
    const guideSteps = steps.filter((step) => step.guide_id === row.guide_id);
    for (const step of guideSteps) {
      if (!step.manual_pages?.length || step.manual_pages.some((page) => page < 1 || page > step.page_count)) {
        invalidPageReferences.push(`${row.article_number}:${step.step_number}`);
      }
      if (!step.needs_review && sentenceCount(step.narration_script ?? "") > 2) {
        overlongNarrations.push(`${row.article_number}:${step.step_number}`);
      }
      if (!step.needs_review && !await exists(`audio/${row.guide_id}/step-${String(step.step_number).padStart(2, "0")}.mp3`)) {
        missingAudio.push(`${row.article_number}:${step.step_number}`);
      }
    }
    const finalStep = guideSteps.at(-1);
    if (finalStep?.narration_script?.trim() !== "Klart. Snyggt jobbat.") {
      invalidFinalNarrations.push(row.article_number);
    }
  }

  const guides = rows.map((row) => ({
    product: row.product,
    articleNumber: row.article_number,
    guideId: row.guide_id,
    manualUrl: row.manual_url,
    manualPages: row.manual_pages,
    steps: row.steps,
    needsReviewSteps: row.needs_review_steps,
    generationAttempts: row.generation_attempts,
    failedAttemptsRecovered: row.failed_attempts,
    generationSeconds: row.generation_seconds,
    estimatedCostUsd: Number(row.estimated_cost_usd),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    status: "ready",
  }));
  const completed = rows.length;
  const report = {
    generatedAt: new Date().toISOString(),
    requested: TARGET_ARTICLES.length,
    ready: completed,
    totalEstimatedCostUsd: Number(guides.reduce((sum, guide) => sum + guide.estimatedCostUsd, 0).toFixed(4)),
    averageGenerationSeconds: Math.round(guides.reduce((sum, guide) => sum + guide.generationSeconds, 0) / Math.max(1, guides.length)),
    totalNeedsReviewSteps: guides.reduce((sum, guide) => sum + guide.needsReviewSteps, 0),
    audit: {
      allReady: completed === TARGET_ARTICLES.length,
      officialManualLinks: guides.every((guide) => /^https:\/\/www\.ikea\.com\//.test(guide.manualUrl)),
      invalidPageReferences,
      overlongNarrations,
      invalidFinalNarrations,
      missingAudio,
    },
    guides,
  };
  await fs.writeFile(path.resolve("data/guide-batch-metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.audit.allReady || invalidPageReferences.length || overlongNarrations.length || invalidFinalNarrations.length || missingAudio.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
