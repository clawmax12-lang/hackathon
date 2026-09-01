import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "../env.js";

interface ActiveEvaluation {
  baselineBatchId: string;
  candidateBatchId: string;
  child: ChildProcess;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

let activeEvaluation: ActiveEvaluation | null = null;

export function isAuthorizedEvalRequest(authorization: string | undefined, token: string): boolean {
  if (!authorization || !token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(authorization);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function authorize(authorization: string | undefined): boolean {
  return isAuthorizedEvalRequest(authorization, config.orchestratorEvalToken);
}

export const evals = new Hono();

evals.post("/", (c) => {
  if (!config.orchestratorEvalEnabled) return c.json({ error: "not found" }, 404);
  if (!authorize(c.req.header("Authorization"))) return c.json({ error: "unauthorized" }, 401);
  if (activeEvaluation?.child.exitCode === null) {
    return c.json(
      {
        error: "an evaluation is already running",
        baselineBatchId: activeEvaluation.baselineBatchId,
        candidateBatchId: activeEvaluation.candidateBatchId,
      },
      409,
    );
  }

  const baselineBatchId = randomUUID();
  const candidateBatchId = randomUUID();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/run-orchestrator-eval-matrix.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORCHESTRATOR_EVAL_BASELINE_BATCH_ID: baselineBatchId,
        ORCHESTRATOR_EVAL_CANDIDATE_BATCH_ID: candidateBatchId,
        ORCHESTRATOR_EVAL_LIMIT: String(config.orchestratorEvalLimit),
        ORCHESTRATOR_EVAL_MAX_ANTHROPIC_USD_PER_BATCH: String(
          config.orchestratorEvalMaxAnthropicUsdPerBatch,
        ),
      },
      stdio: "inherit",
    },
  );
  activeEvaluation = {
    baselineBatchId,
    candidateBatchId,
    child,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
  };
  child.once("exit", (code) => {
    if (!activeEvaluation || activeEvaluation.child !== child) return;
    activeEvaluation.exitCode = code ?? 1;
    activeEvaluation.finishedAt = new Date().toISOString();
    console.info(
      JSON.stringify({
        event: "orchestrator_eval_matrix_finished",
        baseline_batch_id: baselineBatchId,
        candidate_batch_id: candidateBatchId,
        exit_code: activeEvaluation.exitCode,
      }),
    );
  });
  child.once("error", (error) => {
    console.error("[orchestrator-evals] matrix process failed to start", error);
    if (activeEvaluation?.child === child) {
      activeEvaluation.exitCode = 1;
      activeEvaluation.finishedAt = new Date().toISOString();
    }
  });

  console.info(
    JSON.stringify({
      event: "orchestrator_eval_matrix_started",
      baseline_batch_id: baselineBatchId,
      candidate_batch_id: candidateBatchId,
      limit: config.orchestratorEvalLimit,
      max_anthropic_usd_per_batch: config.orchestratorEvalMaxAnthropicUsdPerBatch,
    }),
  );
  return c.json(
    {
      status: "started",
      baselineBatchId,
      candidateBatchId,
      limit: config.orchestratorEvalLimit,
      mediaMode: "skip",
    },
    202,
  );
});

evals.get("/", (c) => {
  if (!config.orchestratorEvalEnabled) return c.json({ error: "not found" }, 404);
  if (!authorize(c.req.header("Authorization"))) return c.json({ error: "unauthorized" }, 401);
  if (!activeEvaluation) return c.json({ status: "idle" });
  return c.json({
    status: activeEvaluation.child.exitCode === null ? "running" : "finished",
    baselineBatchId: activeEvaluation.baselineBatchId,
    candidateBatchId: activeEvaluation.candidateBatchId,
    startedAt: activeEvaluation.startedAt,
    finishedAt: activeEvaluation.finishedAt,
    exitCode: activeEvaluation.exitCode,
  });
});
