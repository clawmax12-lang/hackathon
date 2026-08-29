import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { enqueueGuideJob } from "../server/src/jobs.js";
import { query } from "../server/src/db.js";
import { renderManualPages } from "../server/src/pipeline/manual.js";
import { config } from "../server/src/env.js";
import { storeAsset } from "../server/src/storage.js";
import pLimit from "p-limit";

const limitArg = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = Math.max(1, Math.min(50, Number(limitArg?.split("=")[1] ?? 20) || 20));
const articleArg = process.argv.find((argument) => argument.startsWith("--articles="));
const articles = (articleArg?.split("=")[1] ?? "")
  .split(",")
  .map((article) => article.replace(/\D/g, ""))
  .filter(Boolean);
const outputPath = path.resolve("data/guide-batch-metrics.json");

interface Candidate {
  product_id: string;
  name: string;
  item_number: string;
  document_id: string;
  storage_key: string;
  page_count: number;
}

async function pagesReady(candidate: Candidate): Promise<boolean> {
  try {
    const files = await fs.readdir(path.join(config.storageDir, "pages", candidate.document_id, "vision"));
    return files.filter((file) => file.endsWith(".png")).length === candidate.page_count;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const candidates = await query<Candidate>(
    `SELECT DISTINCT ON (p.id)
            p.id AS product_id,p.name,p.ikea_item_number AS item_number,
            sd.id AS document_id,ma.storage_key,sd.page_count
       FROM products p
       JOIN product_documents pd ON pd.product_id=p.id AND pd.relationship='assembly_manual'
       JOIN source_documents sd ON sd.id=pd.document_id AND sd.status='ready' AND sd.page_count>0
       JOIN media_assets ma ON ma.id=sd.asset_id AND ma.storage_key IS NOT NULL
      WHERE p.status='ready'
        AND regexp_replace(p.ikea_item_number,'\\D','','g')<>'10609002'
        AND ($2::text[] IS NULL OR p.article_no=ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM assembly_guides ag WHERE ag.product_id=p.id AND ag.status='ready')
      ORDER BY p.id,sd.page_count DESC,p.popularity_rank NULLS LAST
      LIMIT $1`,
    [limit, articles.length > 0 ? articles : null],
  );
  if (candidates.length === 0) {
    console.log(JSON.stringify({ status: "nothing_to_generate" }));
    return;
  }

  let rendered = 0;
  const renderLimit = pLimit(2);
  await Promise.all(candidates.map((candidate) => renderLimit(async () => {
    if (!await pagesReady(candidate)) await renderManualPages(candidate.document_id, candidate.storage_key);
    rendered += 1;
    console.log(`PAGE_CACHE ${rendered}/${candidates.length} ${candidate.name} ${candidate.page_count}`);
  })));

  const sample = await fs.readFile(path.join(config.sampleDir, "kallax-photo.jpg"));
  const assetId = await storeAsset({ kind: "scan_image", storageKey: "batch/pinned-product-placeholder.jpg", data: sample, metadata: { purpose: "pinned_batch_generation" } });
  const jobs: { jobId: string; scanId: string; candidate: Candidate; queuedAt: number }[] = [];
  for (const candidate of candidates) {
    const scanId = randomUUID();
    await query("INSERT INTO furniture_scans (id,image_asset_id,status) VALUES ($1,$2,'uploaded')", [scanId, assetId]);
    await enqueueGuideJob(scanId, candidate.product_id, `Batchgenerering för ${candidate.name} ${candidate.item_number}`);
    const [job] = await query<{ id: string }>("SELECT id FROM ingestion_jobs WHERE idempotency_key=$1", [`guide_generation:${scanId}:${candidate.product_id}`]);
    jobs.push({ jobId: job.id, scanId, candidate, queuedAt: Date.now() });
  }
  console.log(`QUEUED ${jobs.length}`);

  const pending = new Set(jobs.map((job) => job.jobId));
  const deadline = Date.now() + 90 * 60_000;
  while (pending.size > 0 && Date.now() < deadline) {
    const rows = await query<{ id: string; status: string }>("SELECT id,status::text FROM ingestion_jobs WHERE id=ANY($1::uuid[])", [[...pending]]);
    for (const row of rows) {
      if (["succeeded", "failed", "cancelled"].includes(row.status)) {
        pending.delete(row.id);
        const job = jobs.find((item) => item.jobId === row.id)!;
        console.log(`GUIDE_DONE ${jobs.length - pending.size}/${jobs.length} ${job.candidate.name} ${row.status} ${Math.round((Date.now() - job.queuedAt) / 1000)}s`);
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  const metrics = [];
  for (const job of jobs) {
    const [row] = await query<{
      status: string;
      started_at: string | null;
      completed_at: string | null;
      estimated_cost_usd: string | null;
      input_tokens: number;
      output_tokens: number;
      guide_id: string | null;
      step_count: number;
      needs_review_steps: number;
    }>(
      `SELECT j.status::text,j.started_at,j.completed_at,
              (SELECT max(estimated_cost_usd)::text FROM job_attempts ja WHERE ja.job_id=j.id) AS estimated_cost_usd,
              COALESCE((SELECT sum(input_tokens)::int FROM job_attempts ja WHERE ja.job_id=j.id),0) AS input_tokens,
              COALESCE((SELECT sum(output_tokens)::int FROM job_attempts ja WHERE ja.job_id=j.id),0) AS output_tokens,
              ag.id AS guide_id,
              count(s.id)::int AS step_count,
              count(s.id) FILTER (WHERE s.needs_review)::int AS needs_review_steps
         FROM ingestion_jobs j
         LEFT JOIN assembly_guides ag ON ag.product_id=$2
         LEFT JOIN assembly_steps s ON s.guide_id=ag.id
        WHERE j.id=$1
        GROUP BY j.id,j.status,j.started_at,j.completed_at,ag.id,ag.updated_at
        ORDER BY ag.updated_at DESC NULLS LAST LIMIT 1`,
      [job.jobId, job.candidate.product_id],
    );
    metrics.push({
      product: job.candidate.name,
      articleNumber: job.candidate.item_number,
      manualPages: job.candidate.page_count,
      status: row?.status ?? "timeout",
      seconds: row?.started_at && row?.completed_at ? Math.round((Date.parse(row.completed_at) - Date.parse(row.started_at)) / 1000) : null,
      estimatedCostUsd: row?.estimated_cost_usd ? Number(row.estimated_cost_usd) : null,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      guideId: row?.guide_id ?? null,
      steps: row?.step_count ?? 0,
      needsReviewSteps: row?.needs_review_steps ?? 0,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    requested: candidates.length,
    succeeded: metrics.filter((metric) => metric.status === "succeeded").length,
    totalEstimatedCostUsd: Number(metrics.reduce((sum, metric) => sum + (metric.estimatedCostUsd ?? 0), 0).toFixed(4)),
    averageSeconds: Math.round(metrics.reduce((sum, metric) => sum + (metric.seconds ?? 0), 0) / Math.max(1, metrics.filter((metric) => metric.seconds !== null).length)),
    guides: metrics,
  };
  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (pending.size > 0 || summary.succeeded !== candidates.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
