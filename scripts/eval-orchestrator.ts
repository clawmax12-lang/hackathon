import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

interface Fixture {
  articleNumber: string;
  product: string;
  expectedSteps: number;
  expectedNeedsReview: number;
  gold: boolean;
}

interface FixtureFile {
  version: number;
  fixtures: Fixture[];
}

interface EvaluationResult {
  batchId: string;
  articleNumber: string;
  product: string;
  gold: boolean;
  model: string;
  effort: string;
  systemPromptVersion: string;
  guidePromptVersion: string;
  status: "success" | "failed";
  expectedSteps: number;
  actualSteps: number;
  expectedNeedsReview: number;
  actualNeedsReview: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  guideId: string | null;
  error: string | null;
}

interface EvalRow {
  article_number: string;
  model: string;
  effort: string;
  prompt_version: string;
  status: string;
  expected_steps: number;
  actual_steps: number;
  expected_needs_review: number;
  actual_needs_review: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: string;
  duration_ms: number;
  result: { product?: string; gold?: boolean };
}

const command = process.argv[2];
const args = parseArgs({
  args: process.argv.slice(3),
  options: {
    "fixture-file": { type: "string", default: "data/evals/orchestrator-fixtures.json" },
    "prompt-version": { type: "string", default: "monterra-system-v2" },
    effort: { type: "string", default: "default" },
    model: { type: "string" },
    limit: { type: "string", default: "20" },
    articles: { type: "string", default: "" },
    "confirm-provider-costs": { type: "boolean", default: false },
    "baseline-batch": { type: "string" },
    "candidate-batch": { type: "string" },
  },
  strict: true,
});

function positiveLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("--limit must be an integer from 1 to 20");
  }
  return parsed;
}

function selectedArticles(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((article) => article.replace(/\D/g, ""))
      .filter(Boolean),
  );
}

function validateEffort(value: string): void {
  if (!["default", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new Error("--effort must be one of default, low, medium, high, xhigh, max");
  }
}

async function loadFixtures(filename: string): Promise<FixtureFile> {
  const parsed = JSON.parse(await fs.readFile(path.resolve(filename), "utf8")) as FixtureFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.fixtures) || parsed.fixtures.length !== 20) {
    throw new Error("fixture file must contain exactly 20 version-1 fixtures");
  }
  const articles = new Set(parsed.fixtures.map((fixture) => fixture.articleNumber));
  if (articles.size !== parsed.fixtures.length) throw new Error("fixture article numbers must be unique");
  return parsed;
}

function setRunEnvironment(): void {
  const effort = args.values.effort ?? "default";
  validateEffort(effort);
  process.env.ANTHROPIC_ORCHESTRATOR_PROMPT_VERSION = args.values["prompt-version"];
  process.env.ANTHROPIC_EFFORT_ORCHESTRATOR = effort;
  if (args.values.model) process.env.ANTHROPIC_ORCHESTRATOR_MODEL = args.values.model;
}

async function runSuite(): Promise<void> {
  if (!args.values["confirm-provider-costs"]) {
    throw new Error("run calls real Anthropic and ElevenLabs APIs; pass --confirm-provider-costs");
  }
  setRunEnvironment();

  const [{ config }, db, storage, manual, orchestrator, tools] = await Promise.all([
    import("../server/src/env.js"),
    import("../server/src/db.js"),
    import("../server/src/storage.js"),
    import("../server/src/pipeline/manual.js"),
    import("../server/src/orchestrator/run.js"),
    import("../server/src/orchestrator/tools.js"),
  ]);
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required; execute this command in a Specific preview");
  }
  if (!config.elevenLabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY is required for end-to-end evals");
  }

  const fixtureFile = await loadFixtures(args.values["fixture-file"]!);
  const requestedArticles = selectedArticles(args.values.articles ?? "");
  const fixtures = fixtureFile.fixtures
    .filter((fixture) => requestedArticles.size === 0 || requestedArticles.has(fixture.articleNumber))
    .slice(0, positiveLimit(args.values.limit!));
  if (fixtures.length === 0) throw new Error("no fixtures matched --articles");

  const batchId = randomUUID();
  const effort = config.orchestratorEffort ?? "high";
  console.log(
    JSON.stringify({
      event: "eval_batch_started",
      batchId,
      fixtures: fixtures.length,
      model: config.orchestratorModel,
      effort,
      promptVersion: config.orchestratorPromptVersion,
    }),
  );

  const placeholder = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const placeholderAssetId = await storage.storeAsset({
    kind: "scan_image",
    storageKey: `evals/${batchId}/pinned-product-placeholder.png`,
    data: placeholder,
    metadata: { purpose: "orchestrator_eval", batch_id: batchId },
  });

  const results: EvaluationResult[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const product = await db.maybeOne<{
      product_id: string;
      product_name: string;
      document_id: string;
      storage_key: string;
      page_count: number;
    }>(
      `SELECT p.id AS product_id, p.name AS product_name, sd.id AS document_id,
              ma.storage_key, sd.page_count
         FROM products p
         JOIN product_documents pd
           ON pd.product_id = p.id AND pd.relationship = 'assembly_manual'
         JOIN source_documents sd
           ON sd.id = pd.document_id AND sd.status = 'ready' AND sd.page_count > 0
         JOIN media_assets ma
           ON ma.id = sd.asset_id AND ma.storage_key IS NOT NULL
        WHERE regexp_replace(p.ikea_item_number, '\\D', '', 'g') = $1
        ORDER BY sd.page_count DESC
        LIMIT 1`,
      [fixture.articleNumber],
    );
    if (!product) {
      throw new Error(`fixture ${fixture.product} ${fixture.articleNumber} has no verified manual`);
    }

    let pagesReady = false;
    try {
      const pages = await manual.listPageFiles(product.document_id, "vision");
      pagesReady = pages.length === product.page_count;
    } catch {
      pagesReady = false;
    }
    if (!pagesReady) {
      await manual.renderManualPages(product.document_id, product.storage_key);
    }

    const scanId = randomUUID();
    await db.query(
      "INSERT INTO furniture_scans (id, image_asset_id, status) VALUES ($1, $2, 'uploaded')",
      [scanId, placeholderAssetId],
    );
    const job = await db.one<{ id: string }>(
      `INSERT INTO ingestion_jobs
         (kind, status, product_id, scan_id, source_document_id, provider, model,
          attempt_count, max_attempts, idempotency_key, input, started_at)
       VALUES
         ('guide_generation', 'running', $1, $2, $3, 'anthropic', $4,
          1, 1, $5, $6::jsonb, now())
       RETURNING id`,
      [
        product.product_id,
        scanId,
        product.document_id,
        config.orchestratorModel,
        `orchestrator_eval:${batchId}:${fixture.articleNumber}`,
        JSON.stringify({ eval_batch_id: batchId, fixture }),
      ],
    );

    const ctx: tools.ToolContext = {
      scanId,
      scanImageKey: `evals/${batchId}/pinned-product-placeholder.png`,
      userNote: `Isolerat orchestrator-test för ${fixture.product} ${fixture.articleNumber}`,
      pinnedProductId: product.product_id,
      state: {},
    };
    const started = Date.now();
    let error: string | null = null;
    try {
      await orchestrator.runOrchestrator(ctx, { jobId: job.id });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      ctx.state.finished ??= {
        outcome: "failed",
        message: "Det isolerade kvalitetstestet kunde inte slutföras.",
      };
      await tools.finalizeRun(ctx).catch(() => {});
    }
    const durationMs = Date.now() - started;
    const succeeded = ctx.state.finished?.outcome === "success";
    await db.query(
      `UPDATE ingestion_jobs
          SET status = $2, completed_at = now(), updated_at = now(),
              output = $3::jsonb, error_message = $4
        WHERE id = $1`,
      [
        job.id,
        succeeded ? "succeeded" : "failed",
        JSON.stringify(ctx.state.finished ?? {}),
        error,
      ],
    );

    const guide = ctx.promptVersion
      ? await db.maybeOne<{
          id: string;
          step_count: number;
          needs_review_count: number;
        }>(
          `SELECT ag.id, count(s.id)::int AS step_count,
                  count(s.id) FILTER (WHERE s.needs_review)::int AS needs_review_count
             FROM assembly_guides ag
             LEFT JOIN assembly_steps s ON s.guide_id = ag.id
            WHERE ag.product_id = $1 AND ag.prompt_version = $2
            GROUP BY ag.id, ag.updated_at
            ORDER BY ag.updated_at DESC
            LIMIT 1`,
          [product.product_id, ctx.promptVersion],
        )
      : null;
    const usage = await db.one<{
      turns: number;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: string;
    }>(
      `SELECT count(*)::int AS turns,
              COALESCE(sum(input_tokens), 0)::int AS input_tokens,
              COALESCE(sum(output_tokens), 0)::int AS output_tokens,
              COALESCE(max(estimated_cost_usd), 0)::text AS estimated_cost_usd
         FROM job_attempts
        WHERE job_id = $1`,
      [job.id],
    );

    const result: EvaluationResult = {
      batchId,
      articleNumber: fixture.articleNumber,
      product: product.product_name,
      gold: fixture.gold,
      model: config.orchestratorModel,
      effort,
      systemPromptVersion: config.orchestratorPromptVersion,
      guidePromptVersion: ctx.promptVersion ?? "unknown",
      status: succeeded ? "success" : "failed",
      expectedSteps: fixture.expectedSteps,
      actualSteps: guide?.step_count ?? 0,
      expectedNeedsReview: fixture.expectedNeedsReview,
      actualNeedsReview: guide?.needs_review_count ?? 0,
      turns: usage.turns,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      estimatedCostUsd: Number(usage.estimated_cost_usd),
      durationMs,
      guideId: guide?.id ?? null,
      error,
    };
    await db.query(
      `INSERT INTO orchestrator_eval_runs
         (batch_id, suite_version, product_id, scan_id, job_id, article_number,
          model, effort, prompt_version, status, expected_steps, actual_steps,
          expected_needs_review, actual_needs_review, turns, input_tokens,
          output_tokens, estimated_cost_usd, duration_ms, result)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20::jsonb)`,
      [
        batchId,
        fixtureFile.version,
        product.product_id,
        scanId,
        job.id,
        fixture.articleNumber,
        result.model,
        result.effort,
        result.systemPromptVersion,
        result.status,
        result.expectedSteps,
        result.actualSteps,
        result.expectedNeedsReview,
        result.actualNeedsReview,
        result.turns,
        result.inputTokens,
        result.outputTokens,
        result.estimatedCostUsd,
        result.durationMs,
        JSON.stringify({
          product: result.product,
          gold: result.gold,
          guide_prompt_version: result.guidePromptVersion,
          guide_id: result.guideId,
          error: result.error,
        }),
      ],
    );
    results.push(result);
    console.log(
      JSON.stringify({
        event: "eval_fixture_finished",
        position: index + 1,
        total: fixtures.length,
        ...result,
      }),
    );
  }

  console.log(JSON.stringify({ event: "eval_batch_finished", batchId, summary: summarize(results) }, null, 2));
  await (await db.getPool()).end();
  if (results.some((result) => result.status !== "success")) process.exitCode = 1;
}

interface Summary {
  fixtures: number;
  successful: number;
  exactStepCount: number;
  goldExactStepCount: number;
  goldFixtures: number;
  meanAbsoluteStepDelta: number;
  totalNeedsReview: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

function summarize(results: Array<Pick<
  EvaluationResult,
  | "status"
  | "gold"
  | "expectedSteps"
  | "actualSteps"
  | "actualNeedsReview"
  | "turns"
  | "inputTokens"
  | "outputTokens"
  | "estimatedCostUsd"
  | "durationMs"
>>): Summary {
  const gold = results.filter((result) => result.gold);
  return {
    fixtures: results.length,
    successful: results.filter((result) => result.status === "success").length,
    exactStepCount: results.filter((result) => result.expectedSteps === result.actualSteps).length,
    goldExactStepCount: gold.filter((result) => result.expectedSteps === result.actualSteps).length,
    goldFixtures: gold.length,
    meanAbsoluteStepDelta:
      Math.round(
        (results.reduce((sum, result) => sum + Math.abs(result.expectedSteps - result.actualSteps), 0) /
          Math.max(1, results.length)) *
          100,
      ) / 100,
    totalNeedsReview: results.reduce((sum, result) => sum + result.actualNeedsReview, 0),
    turns: results.reduce((sum, result) => sum + result.turns, 0),
    inputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
    outputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
    estimatedCostUsd: Number(
      results.reduce((sum, result) => sum + result.estimatedCostUsd, 0).toFixed(4),
    ),
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
  };
}

async function readBatch(batchId: string): Promise<EvaluationResult[]> {
  const db = await import("../server/src/db.js");
  const rows = await db.query<EvalRow>(
    `SELECT article_number, model, effort, prompt_version, status,
            expected_steps, actual_steps, expected_needs_review,
            actual_needs_review, turns, input_tokens, output_tokens,
            estimated_cost_usd::text, duration_ms, result
       FROM orchestrator_eval_runs
      WHERE batch_id = $1
      ORDER BY article_number`,
    [batchId],
  );
  if (rows.length === 0) throw new Error(`no eval rows found for batch ${batchId}`);
  return rows.map((row) => ({
    batchId,
    articleNumber: row.article_number,
    product: row.result.product ?? row.article_number,
    gold: Boolean(row.result.gold),
    model: row.model,
    effort: row.effort,
    systemPromptVersion: row.prompt_version,
    guidePromptVersion: "",
    status: row.status === "success" ? "success" : "failed",
    expectedSteps: row.expected_steps,
    actualSteps: row.actual_steps,
    expectedNeedsReview: row.expected_needs_review,
    actualNeedsReview: row.actual_needs_review,
    turns: row.turns,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCostUsd: Number(row.estimated_cost_usd),
    durationMs: row.duration_ms,
    guideId: null,
    error: null,
  }));
}

async function compareBatches(): Promise<void> {
  const baselineId = args.values["baseline-batch"];
  const candidateId = args.values["candidate-batch"];
  if (!baselineId || !candidateId) {
    throw new Error("compare requires --baseline-batch and --candidate-batch");
  }
  const [baseline, candidate] = await Promise.all([readBatch(baselineId), readBatch(candidateId)]);
  const baselineArticles = baseline.map((row) => row.articleNumber).join(",");
  const candidateArticles = candidate.map((row) => row.articleNumber).join(",");
  if (baselineArticles !== candidateArticles) {
    throw new Error("baseline and candidate batches contain different fixtures");
  }
  const before = summarize(baseline);
  const after = summarize(candidate);
  const fidelityNotWorse =
    after.successful >= before.successful &&
    after.exactStepCount >= before.exactStepCount &&
    after.goldExactStepCount >= before.goldExactStepCount &&
    after.totalNeedsReview <= before.totalNeedsReview;
  const operationalImprovement =
    after.turns < before.turns ||
    after.estimatedCostUsd < before.estimatedCostUsd ||
    after.durationMs < before.durationMs;
  const verdict = fidelityNotWorse && operationalImprovement ? "pass" : "hold";

  console.log("| Metric | Baseline | Candidate |");
  console.log("|---|---:|---:|");
  for (const [label, key] of [
    ["Successful", "successful"],
    ["Exact step count", "exactStepCount"],
    ["Gold exact step count", "goldExactStepCount"],
    ["Mean absolute step delta", "meanAbsoluteStepDelta"],
    ["Needs-review steps", "totalNeedsReview"],
    ["Turns", "turns"],
    ["Input tokens", "inputTokens"],
    ["Output tokens", "outputTokens"],
    ["Estimated cost (USD)", "estimatedCostUsd"],
    ["Wall time (ms)", "durationMs"],
  ] as const) {
    console.log(`| ${label} | ${before[key]} | ${after[key]} |`);
  }
  console.log();
  console.log(
    JSON.stringify(
      {
        baselineBatch: baselineId,
        candidateBatch: candidateId,
        fidelityNotWorse,
        operationalImprovement,
        verdict,
      },
      null,
      2,
    ),
  );
  const db = await import("../server/src/db.js");
  await (await db.getPool()).end();
  if (verdict !== "pass") process.exitCode = 1;
}

async function main(): Promise<void> {
  if (command === "run") return runSuite();
  if (command === "compare") return compareBatches();
  throw new Error(
    "Usage: eval-orchestrator.ts run --confirm-provider-costs [--prompt-version=...] [--effort=...] [--limit=20]\n" +
      "   or: eval-orchestrator.ts compare --baseline-batch=<uuid> --candidate-batch=<uuid>",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
