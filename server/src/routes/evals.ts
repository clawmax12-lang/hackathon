import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { maybeOne, one, query } from "../db.js";
import { config } from "../env.js";

const evalChildren = new Set<ChildProcess>();
const forwardSigterm = () => {
  for (const child of evalChildren) child.kill("SIGTERM");
  process.off("SIGTERM", forwardSigterm);
  process.kill(process.pid, "SIGTERM");
};
const forwardSigint = () => {
  for (const child of evalChildren) child.kill("SIGINT");
  process.off("SIGINT", forwardSigint);
  process.kill(process.pid, "SIGINT");
};
process.once("SIGTERM", forwardSigterm);
process.once("SIGINT", forwardSigint);

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

evals.post("/", async (c) => {
  if (!config.orchestratorEvalEnabled) return c.json({ error: "not found" }, 404);
  if (!authorize(c.req.header("Authorization"))) return c.json({ error: "unauthorized" }, 401);

  // A dead pod cannot hold the lease forever. A live matrix refreshes this
  // timestamp from its own process every 15 seconds.
  await query(
    `UPDATE orchestrator_eval_matrices
        SET status = 'failed', completed_at = now(),
            error_message = 'stale evaluation lease expired'
      WHERE status = 'running'
        AND heartbeat_at < now() - interval '5 minutes'`,
  );

  const matrixId = randomUUID();
  const baselineBatchId = randomUUID();
  const candidateBatchId = randomUUID();
  try {
    await one(
      `INSERT INTO orchestrator_eval_matrices
         (id, baseline_batch_id, candidate_batch_id, status, fixture_limit,
          max_anthropic_usd_per_batch, started_at, heartbeat_at)
       VALUES ($1, $2, $3, 'running', $4, $5, now(), now())
       RETURNING id`,
      [
        matrixId,
        baselineBatchId,
        candidateBatchId,
        config.orchestratorEvalLimit,
        config.orchestratorEvalMaxAnthropicUsdPerBatch,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const running = await maybeOne<{
      id: string;
      baseline_batch_id: string;
      candidate_batch_id: string;
    }>(
      `SELECT id, baseline_batch_id, candidate_batch_id
         FROM orchestrator_eval_matrices
        WHERE status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    return c.json(
      {
        error: "an evaluation is already running",
        matrixId: running?.id,
        baselineBatchId: running?.baseline_batch_id,
        candidateBatchId: running?.candidate_batch_id,
      },
      409,
    );
  }

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/run-orchestrator-eval-matrix.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORCHESTRATOR_EVAL_MATRIX_ID: matrixId,
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
  evalChildren.add(child);
  child.once("exit", (code) => {
    evalChildren.delete(child);
    const exitCode = code ?? 1;
    void query(
      `UPDATE orchestrator_eval_matrices
          SET status = CASE WHEN $2 = 0 THEN 'succeeded' ELSE 'failed' END,
              exit_code = $2, completed_at = now(), heartbeat_at = now()
        WHERE id = $1 AND status = 'running'`,
      [matrixId, exitCode],
    ).catch((error) => console.error("[orchestrator-evals] failed to persist exit", error));
    console.info(
      JSON.stringify({
        event: "orchestrator_eval_matrix_finished",
        baseline_batch_id: baselineBatchId,
        candidate_batch_id: candidateBatchId,
        exit_code: exitCode,
      }),
    );
  });
  child.once("error", (error) => {
    evalChildren.delete(child);
    console.error("[orchestrator-evals] matrix process failed to start", error);
    void query(
      `UPDATE orchestrator_eval_matrices
          SET status = 'failed', exit_code = 1, completed_at = now(),
              heartbeat_at = now(), error_message = $2
        WHERE id = $1 AND status = 'running'`,
      [matrixId, error.message.slice(0, 500)],
    ).catch((persistError) =>
      console.error("[orchestrator-evals] failed to persist spawn error", persistError),
    );
  });

  console.info(
    JSON.stringify({
      event: "orchestrator_eval_matrix_started",
      matrix_id: matrixId,
      baseline_batch_id: baselineBatchId,
      candidate_batch_id: candidateBatchId,
      limit: config.orchestratorEvalLimit,
      max_anthropic_usd_per_batch: config.orchestratorEvalMaxAnthropicUsdPerBatch,
    }),
  );
  return c.json(
    {
      status: "started",
      matrixId,
      baselineBatchId,
      candidateBatchId,
      limit: config.orchestratorEvalLimit,
      mediaMode: "skip",
    },
    202,
  );
});

evals.get("/", async (c) => {
  if (!config.orchestratorEvalEnabled) return c.json({ error: "not found" }, 404);
  if (!authorize(c.req.header("Authorization"))) return c.json({ error: "unauthorized" }, 401);
  const latest = await maybeOne<{
    id: string;
    status: string;
    baseline_batch_id: string;
    candidate_batch_id: string;
    started_at: string;
    heartbeat_at: string;
    completed_at: string | null;
    exit_code: number | null;
    error_message: string | null;
  }>(
    `SELECT id, status, baseline_batch_id, candidate_batch_id, started_at,
            heartbeat_at, completed_at, exit_code, error_message
       FROM orchestrator_eval_matrices
      ORDER BY started_at DESC
      LIMIT 1`,
  );
  if (!latest) return c.json({ status: "idle" });
  return c.json({
    status: latest.status,
    matrixId: latest.id,
    baselineBatchId: latest.baseline_batch_id,
    candidateBatchId: latest.candidate_batch_id,
    startedAt: latest.started_at,
    heartbeatAt: latest.heartbeat_at,
    finishedAt: latest.completed_at,
    exitCode: latest.exit_code,
    error: latest.error_message,
  });
});
