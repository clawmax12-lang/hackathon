import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

interface Fixture {
  articleNumber: string;
  product: string;
  expectedSteps: number;
  expectedNeedsReview: number;
  gold: boolean;
  expectedPageSequence?: number[];
  requiredPartTokens?: Record<string, string[]>;
  requiredInstructionTokens?: Record<string, string[]>;
  requiredWarningSteps?: number[];
  requiredWarningTokens?: Record<string, string[]>;
}

interface FixtureFile {
  version: number;
  fixtures: Fixture[];
}

interface LoadedFixtureFile extends FixtureFile {
  hash: string;
}

interface EvaluationResult {
  batchId: string;
  suiteVersion: number;
  fixtureHash: string;
  articleNumber: string;
  product: string;
  gold: boolean;
  documentId: string;
  documentChecksum: string;
  model: string;
  effort: string;
  systemPromptVersion: string;
  guidePromptVersion: string;
  status: "success" | "failed";
  expectedSteps: number;
  actualSteps: number;
  expectedNeedsReview: number;
  actualNeedsReview: number;
  groundingAssertionsPassed: number;
  groundingAssertionsTotal: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  guideId: string | null;
  error: string | null;
}

interface EvalRow {
  suite_version: number;
  fixture_hash: string;
  article_number: string;
  document_id: string;
  document_checksum: string;
  model: string;
  effort: string;
  prompt_version: string;
  status: string;
  expected_steps: number;
  actual_steps: number;
  expected_needs_review: number;
  actual_needs_review: number;
  grounding_assertions_passed: number;
  grounding_assertions_total: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: string;
  duration_ms: number;
  result: { product?: string; gold?: boolean };
}

let activeDb: typeof import("../server/src/db.js") | null = null;

const command = process.argv[2];
const args = parseArgs({
  args: process.argv.slice(3),
  options: {
    "fixture-file": { type: "string", default: "data/evals/orchestrator-fixtures.json" },
    "prompt-version": { type: "string", default: "monterra-system-v2" },
    effort: { type: "string", default: "default" },
    model: { type: "string" },
    limit: { type: "string", default: "20" },
    "max-total-anthropic-usd": { type: "string", default: "25" },
    articles: { type: "string", default: "" },
    "confirm-provider-costs": { type: "boolean", default: false },
    "allow-fixture-failures": { type: "boolean", default: false },
    "baseline-batch": { type: "string" },
    "candidate-batch": { type: "string" },
    "batch-id": { type: "string" },
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

function positiveUsd(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 60) {
    throw new Error("--max-total-anthropic-usd must be greater than 0 and at most 60");
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

async function loadFixtures(filename: string): Promise<LoadedFixtureFile> {
  const raw = await fs.readFile(path.resolve(filename), "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;
  if (
    !Number.isInteger(parsed.version) ||
    parsed.version < 1 ||
    !Array.isArray(parsed.fixtures) ||
    parsed.fixtures.length !== 20
  ) {
    throw new Error("fixture file must contain exactly 20 versioned fixtures");
  }
  const articles = new Set(parsed.fixtures.map((fixture) => fixture.articleNumber));
  if (articles.size !== parsed.fixtures.length) throw new Error("fixture article numbers must be unique");
  return { ...parsed, hash: createHash("sha256").update(raw).digest("hex") };
}

function setRunEnvironment(): void {
  const effort = args.values.effort ?? "default";
  validateEffort(effort);
  process.env.ANTHROPIC_ORCHESTRATOR_PROMPT_VERSION = args.values["prompt-version"];
  process.env.ANTHROPIC_EFFORT_ORCHESTRATOR = effort;
  if (args.values.model) process.env.ANTHROPIC_ORCHESTRATOR_MODEL = args.values.model;
}

function scoreGrounding(
  fixture: Fixture,
  steps: Array<{
    step_number: number;
    manual_pages: number[] | null;
    parts: unknown;
    instruction: string;
    safety_warning: string | null;
  }>,
): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  const byNumber = new Map(steps.map((step) => [step.step_number, step]));

  for (const [index, expectedPage] of (fixture.expectedPageSequence ?? []).entries()) {
    total += 1;
    const pages = byNumber.get(index + 1)?.manual_pages ?? [];
    if (pages.length === 1 && pages[0] === expectedPage) passed += 1;
  }
  for (const [stepNumber, tokens] of Object.entries(fixture.requiredPartTokens ?? {})) {
    const parts = JSON.stringify(byNumber.get(Number(stepNumber))?.parts ?? []).toLowerCase();
    for (const token of tokens) {
      total += 1;
      if (parts.includes(token.toLowerCase())) passed += 1;
    }
  }
  for (const [stepNumber, tokens] of Object.entries(fixture.requiredInstructionTokens ?? {})) {
    const instruction = byNumber.get(Number(stepNumber))?.instruction?.toLowerCase() ?? "";
    for (const token of tokens) {
      total += 1;
      if (instruction.includes(token.toLowerCase())) passed += 1;
    }
  }
  for (const stepNumber of fixture.requiredWarningSteps ?? []) {
    total += 1;
    if (byNumber.get(stepNumber)?.safety_warning?.trim()) passed += 1;
  }
  for (const [stepNumber, tokens] of Object.entries(fixture.requiredWarningTokens ?? {})) {
    const warning = byNumber.get(Number(stepNumber))?.safety_warning?.toLowerCase() ?? "";
    for (const token of tokens) {
      total += 1;
      if (warning.includes(token.toLowerCase())) passed += 1;
    }
  }
  return { passed, total };
}

async function runSuite(): Promise<void> {
  if (!["1", "true"].includes(process.env.ORCHESTRATOR_EVAL_ENABLED ?? "")) {
    throw new Error(
      "orchestrator evals are disabled; enable ORCHESTRATOR_EVAL_ENABLED only in an isolated Specific preview",
    );
  }
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
  activeDb = db;
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required; execute this command in a Specific preview");
  }

  const fixtureFile = await loadFixtures(args.values["fixture-file"]!);
  const requestedArticles = selectedArticles(args.values.articles ?? "");
  const fixtures = fixtureFile.fixtures
    .filter((fixture) => requestedArticles.size === 0 || requestedArticles.has(fixture.articleNumber))
    .slice(0, positiveLimit(args.values.limit!));
  if (fixtures.length === 0) throw new Error("no fixtures matched --articles");

  const requestedBatchId = args.values["batch-id"];
  if (requestedBatchId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedBatchId)) {
    throw new Error("--batch-id must be a version-4 UUID");
  }
  const batchId = requestedBatchId ?? randomUUID();
  const maxTotalAnthropicUsd = positiveUsd(args.values["max-total-anthropic-usd"]!);
  const effort = config.orchestratorEffort ?? "default";
  console.log(
    JSON.stringify({
      event: "eval_batch_started",
      batchId,
      fixtures: fixtures.length,
      model: config.orchestratorModel,
      effort,
      promptVersion: config.orchestratorPromptVersion,
      maxTotalAnthropicUsd,
      mediaMode: "skip",
    }),
  );

  const products = new Map<
    string,
    {
      product_id: string;
      product_name: string;
      document_id: string;
      document_checksum: string;
      storage_key: string;
      page_count: number;
    }
  >();
  const missingFixtures: string[] = [];
  for (const fixture of fixtures) {
    const product = await db.maybeOne<{
      product_id: string;
      product_name: string;
      document_id: string;
      document_checksum: string;
      storage_key: string;
      page_count: number;
    }>(
      `SELECT p.id AS product_id, p.name AS product_name, sd.id AS document_id,
              sd.checksum_sha256 AS document_checksum, ma.storage_key, sd.page_count
         FROM products p
         JOIN product_documents pd
           ON pd.product_id = p.id AND pd.relationship = 'assembly_manual'
         JOIN source_documents sd
           ON sd.id = pd.document_id
          AND sd.status = 'ready'
          AND sd.page_count > 0
          AND sd.checksum_sha256 IS NOT NULL
         JOIN media_assets ma
           ON ma.id = sd.asset_id AND ma.storage_key IS NOT NULL
        WHERE regexp_replace(p.ikea_item_number, '\\D', '', 'g') = $1
        ORDER BY sd.page_count DESC
        LIMIT 1`,
      [fixture.articleNumber],
    );
    if (!product) {
      missingFixtures.push(`${fixture.product} ${fixture.articleNumber}`);
      continue;
    }
    products.set(fixture.articleNumber, product);
  }
  if (missingFixtures.length > 0) {
    throw new Error(`fixtures missing verified manuals: ${missingFixtures.join(", ")}`);
  }

  // Finish all no-provider setup before the first billable request.
  for (const fixture of fixtures) {
    const product = products.get(fixture.articleNumber)!;
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
  }

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
  let spentAnthropicUsd = 0;
  for (const [index, fixture] of fixtures.entries()) {
    const remainingAnthropicUsd = maxTotalAnthropicUsd - spentAnthropicUsd;
    if (remainingAnthropicUsd < 0.01) {
      throw new Error(
        `aggregate Anthropic cost guard reached ($${spentAnthropicUsd.toFixed(4)} of $${maxTotalAnthropicUsd.toFixed(2)})`,
      );
    }
    const product = products.get(fixture.articleNumber)!;

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
      promptVersion: `eval-v${fixtureFile.version}:${config.orchestratorPromptVersion}:${batchId}`,
      requiredDocumentId: product.document_id,
      mediaMode: "skip",
      state: {},
    };
    const started = Date.now();
    let error: string | null = null;
    let runMetrics: Awaited<ReturnType<typeof orchestrator.runOrchestrator>> | null = null;
    try {
      runMetrics = await orchestrator.runOrchestrator(ctx, {
        jobId: job.id,
        systemPromptVersion: config.orchestratorPromptVersion,
        effort: config.orchestratorEffort,
        maxCostUsd: remainingAnthropicUsd,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      ctx.state.finished ??= {
        outcome: "failed",
        message: "Det isolerade kvalitetstestet kunde inte slutföras.",
      };
      await tools.finalizeRun(ctx).catch(() => {});
    }
    const durationMs = Date.now() - started;

    const guide = ctx.promptVersion
      ? await db.maybeOne<{
          id: string;
          status: string;
          manual_document_id: string | null;
          step_count: number;
          needs_review_count: number;
        }>(
          `SELECT ag.id, ag.status::text, ag.manual_document_id,
                  count(s.id)::int AS step_count,
                  count(s.id) FILTER (WHERE s.needs_review)::int AS needs_review_count
             FROM assembly_guides ag
             LEFT JOIN assembly_steps s ON s.guide_id = ag.id
            WHERE ag.product_id = $1 AND ag.prompt_version = $2
            GROUP BY ag.id, ag.status, ag.manual_document_id, ag.updated_at
            ORDER BY ag.updated_at DESC
            LIMIT 1`,
          [product.product_id, ctx.promptVersion],
        )
      : null;
    const guideSteps = guide
      ? await db.query<{
          step_number: number;
          manual_pages: number[] | null;
          parts: unknown;
          instruction: string;
          safety_warning: string | null;
        }>(
          `SELECT step_number, manual_pages, parts, instruction, safety_warning
             FROM assembly_steps
            WHERE guide_id = $1
            ORDER BY step_number`,
          [guide.id],
        )
      : [];
    const grounding = scoreGrounding(fixture, guideSteps);
    const persistedUsage = await db.one<{
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
    const usage = runMetrics
      ? {
          turns: runMetrics.turns,
          input_tokens: runMetrics.inputTokens,
          output_tokens: runMetrics.outputTokens,
          estimated_cost_usd: String(runMetrics.estimatedCostUsd),
        }
      : persistedUsage;
    const producedValidGuide =
      guide?.status === "ready" &&
      guide.manual_document_id === product.document_id &&
      guide.step_count > 0 &&
      ctx.state.videoUrl !== undefined;
    const succeeded = ctx.state.finished?.outcome === "success" && producedValidGuide;
    if (ctx.state.finished?.outcome === "success" && !producedValidGuide) {
      error ??= "orchestrator reported success without a ready, nonempty guide for the pinned manual";
    }
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

    const result: EvaluationResult = {
      batchId,
      suiteVersion: fixtureFile.version,
      fixtureHash: fixtureFile.hash,
      articleNumber: fixture.articleNumber,
      product: product.product_name,
      gold: fixture.gold,
      documentId: product.document_id,
      documentChecksum: product.document_checksum,
      model: config.orchestratorModel,
      effort,
      systemPromptVersion: config.orchestratorPromptVersion,
      guidePromptVersion: ctx.promptVersion ?? "unknown",
      status: succeeded ? "success" : "failed",
      expectedSteps: fixture.expectedSteps,
      actualSteps: guide?.step_count ?? 0,
      expectedNeedsReview: fixture.expectedNeedsReview,
      actualNeedsReview: guide?.needs_review_count ?? 0,
      groundingAssertionsPassed: grounding.passed,
      groundingAssertionsTotal: grounding.total,
      turns: usage.turns,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      estimatedCostUsd: Number(usage.estimated_cost_usd),
      durationMs,
      guideId: guide?.id ?? null,
      error,
    };
    spentAnthropicUsd += result.estimatedCostUsd;
    await db.query(
      `INSERT INTO orchestrator_eval_runs
         (batch_id, suite_version, fixture_hash, product_id, document_id,
          document_checksum, scan_id, job_id, article_number, model, effort,
          prompt_version, status, expected_steps, actual_steps,
          expected_needs_review, actual_needs_review,
          grounding_assertions_passed, grounding_assertions_total, turns,
          input_tokens, output_tokens, estimated_cost_usd, duration_ms, result)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb)`,
      [
        batchId,
        fixtureFile.version,
        fixtureFile.hash,
        product.product_id,
        product.document_id,
        product.document_checksum,
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
        result.groundingAssertionsPassed,
        result.groundingAssertionsTotal,
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
  if (
    !args.values["allow-fixture-failures"] &&
    results.some((result) => result.status !== "success")
  ) {
    process.exitCode = 1;
  }
}

interface Summary {
  fixtures: number;
  successful: number;
  exactStepCount: number;
  goldExactStepCount: number;
  goldFixtures: number;
  meanAbsoluteStepDelta: number;
  goldMeanAbsoluteStepDelta: number;
  totalNeedsReview: number;
  needsReviewDeviation: number;
  goldNeedsReviewDeviation: number;
  groundingAssertionsPassed: number;
  groundingAssertionsTotal: number;
  groundingRate: number;
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
  | "expectedNeedsReview"
  | "actualNeedsReview"
  | "groundingAssertionsPassed"
  | "groundingAssertionsTotal"
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
    goldMeanAbsoluteStepDelta:
      Math.round(
        (gold.reduce((sum, result) => sum + Math.abs(result.expectedSteps - result.actualSteps), 0) /
          Math.max(1, gold.length)) *
          100,
      ) / 100,
    totalNeedsReview: results.reduce((sum, result) => sum + result.actualNeedsReview, 0),
    needsReviewDeviation: results.reduce(
      (sum, result) => sum + Math.abs(result.expectedNeedsReview - result.actualNeedsReview),
      0,
    ),
    goldNeedsReviewDeviation: gold.reduce(
      (sum, result) => sum + Math.abs(result.expectedNeedsReview - result.actualNeedsReview),
      0,
    ),
    groundingAssertionsPassed: gold.reduce(
      (sum, result) => sum + result.groundingAssertionsPassed,
      0,
    ),
    groundingAssertionsTotal: gold.reduce(
      (sum, result) => sum + result.groundingAssertionsTotal,
      0,
    ),
    groundingRate:
      Math.round(
        (gold.reduce((sum, result) => sum + result.groundingAssertionsPassed, 0) /
          Math.max(1, gold.reduce((sum, result) => sum + result.groundingAssertionsTotal, 0))) *
          10000,
      ) / 10000,
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
  activeDb = db;
  const rows = await db.query<EvalRow>(
    `SELECT suite_version, fixture_hash, article_number, document_id,
            document_checksum, model, effort, prompt_version, status,
            expected_steps, actual_steps, expected_needs_review,
            actual_needs_review, grounding_assertions_passed,
            grounding_assertions_total, turns, input_tokens, output_tokens,
            estimated_cost_usd::text, duration_ms, result
       FROM orchestrator_eval_runs
      WHERE batch_id = $1
      ORDER BY article_number`,
    [batchId],
  );
  if (rows.length === 0) throw new Error(`no eval rows found for batch ${batchId}`);
  return rows.map((row) => ({
    batchId,
    suiteVersion: row.suite_version,
    fixtureHash: row.fixture_hash,
    articleNumber: row.article_number,
    product: row.result.product ?? row.article_number,
    gold: Boolean(row.result.gold),
    documentId: row.document_id,
    documentChecksum: row.document_checksum,
    model: row.model,
    effort: row.effort,
    systemPromptVersion: row.prompt_version,
    guidePromptVersion: "",
    status: row.status === "success" ? "success" : "failed",
    expectedSteps: row.expected_steps,
    actualSteps: row.actual_steps,
    expectedNeedsReview: row.expected_needs_review,
    actualNeedsReview: row.actual_needs_review,
    groundingAssertionsPassed: row.grounding_assertions_passed,
    groundingAssertionsTotal: row.grounding_assertions_total,
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
  const identity = (row: EvaluationResult) =>
    [
      row.suiteVersion,
      row.fixtureHash,
      row.articleNumber,
      row.documentId,
      row.documentChecksum,
    ].join(":");
  if (baseline.map(identity).join("|") !== candidate.map(identity).join("|")) {
    throw new Error("baseline and candidate batches contain different fixture or document identities");
  }
  const before = summarize(baseline);
  const after = summarize(candidate);
  const fidelityNotWorse =
    after.goldFixtures > 0 &&
    after.groundingAssertionsTotal > 0 &&
    after.successful >= before.successful &&
    after.goldExactStepCount >= before.goldExactStepCount &&
    after.goldMeanAbsoluteStepDelta <= before.goldMeanAbsoluteStepDelta &&
    after.goldNeedsReviewDeviation <= before.goldNeedsReviewDeviation &&
    after.groundingRate >= before.groundingRate &&
    after.groundingAssertionsPassed === after.groundingAssertionsTotal;
  const withinTolerance = (candidateValue: number, baselineValue: number, multiplier: number) =>
    baselineValue === 0 ? candidateValue === 0 : candidateValue <= baselineValue * multiplier;
  const operationalNotWorse =
    withinTolerance(after.turns, before.turns, 1.05) &&
    withinTolerance(after.estimatedCostUsd, before.estimatedCostUsd, 1.05) &&
    withinTolerance(after.durationMs, before.durationMs, 1.1);
  const operationalImprovement =
    after.turns < before.turns ||
    after.estimatedCostUsd < before.estimatedCostUsd ||
    after.durationMs < before.durationMs;
  const verdict = fidelityNotWorse && operationalNotWorse && operationalImprovement ? "pass" : "hold";

  console.log("| Metric | Baseline | Candidate |");
  console.log("|---|---:|---:|");
  for (const [label, key] of [
    ["Successful", "successful"],
    ["Exact step count", "exactStepCount"],
    ["Gold exact step count", "goldExactStepCount"],
    ["Mean absolute step delta", "meanAbsoluteStepDelta"],
    ["Gold mean absolute step delta", "goldMeanAbsoluteStepDelta"],
    ["Needs-review steps", "totalNeedsReview"],
    ["Needs-review deviation", "needsReviewDeviation"],
    ["Gold needs-review deviation", "goldNeedsReviewDeviation"],
    ["Grounding assertions passed", "groundingAssertionsPassed"],
    ["Grounding assertions total", "groundingAssertionsTotal"],
    ["Grounding rate", "groundingRate"],
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
        operationalNotWorse,
        operationalImprovement,
        verdict,
      },
      null,
      2,
    ),
  );
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (activeDb) {
      const pool = await activeDb.getPool();
      await pool.end();
    }
  });
