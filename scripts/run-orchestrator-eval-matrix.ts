import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";

const matrixId = process.env.ORCHESTRATOR_EVAL_MATRIX_ID ?? "";
const baselineBatchId = process.env.ORCHESTRATOR_EVAL_BASELINE_BATCH_ID ?? "";
const candidateBatchId = process.env.ORCHESTRATOR_EVAL_CANDIDATE_BATCH_ID ?? "";
const limit = Number(process.env.ORCHESTRATOR_EVAL_LIMIT ?? "2");
const maxUsdPerBatch = Number(
  process.env.ORCHESTRATOR_EVAL_MAX_ANTHROPIC_USD_PER_BATCH ?? "25",
);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!uuidV4.test(matrixId) || !uuidV4.test(baselineBatchId) || !uuidV4.test(candidateBatchId)) {
  throw new Error("matrix requires valid matrix, baseline, and candidate IDs");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
  throw new Error("ORCHESTRATOR_EVAL_LIMIT must be an integer from 1 to 20");
}
if (!Number.isFinite(maxUsdPerBatch) || maxUsdPerBatch <= 0 || maxUsdPerBatch > 60) {
  throw new Error("ORCHESTRATOR_EVAL_MAX_ANTHROPIC_USD_PER_BATCH must be in (0, 60]");
}

async function run(args: string[]): Promise<void> {
  if (abortReason) throw abortReason;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/eval-orchestrator.ts", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      activeChild = null;
      reject(abortReason ?? error);
    });
    child.once("exit", (code, signal) => {
      activeChild = null;
      if (abortReason) reject(abortReason);
      else if (code === 0) resolve();
      else reject(new Error(`eval command exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let activeChild: ChildProcess | null = null;
let abortReason: Error | null = null;
const abort = (reason: Error) => {
  abortReason ??= reason;
  activeChild?.kill("SIGTERM");
};
const onSigterm = () => abort(new Error("matrix received SIGTERM"));
const onSigint = () => abort(new Error("matrix received SIGINT"));
process.once("SIGTERM", onSigterm);
process.once("SIGINT", onSigint);
const heartbeat = setInterval(() => {
  void db
    .query(
      `UPDATE orchestrator_eval_matrices
          SET heartbeat_at = now()
        WHERE id = $1 AND status = 'running'
      RETURNING id`,
      [matrixId],
    )
    .then((result) => {
      if (result.rowCount !== 1) abort(new Error("matrix lease ownership was lost"));
    })
    .catch((error) => abort(new Error(`matrix heartbeat failed: ${(error as Error).message}`)));
}, 15_000);

try {
  await run([
    "run",
    `--batch-id=${baselineBatchId}`,
    "--prompt-version=monterra-system-v2",
    "--effort=default",
    `--limit=${limit}`,
    `--max-total-anthropic-usd=${maxUsdPerBatch}`,
    "--confirm-provider-costs",
    "--allow-fixture-failures",
  ]);

  await run([
    "run",
    `--batch-id=${candidateBatchId}`,
    "--prompt-version=monterra-system-v3",
    "--effort=high",
    `--limit=${limit}`,
    `--max-total-anthropic-usd=${maxUsdPerBatch}`,
    "--confirm-provider-costs",
    "--allow-fixture-failures",
  ]);

  await run([
    "compare",
    `--baseline-batch=${baselineBatchId}`,
    `--candidate-batch=${candidateBatchId}`,
  ]);
  if (abortReason) throw abortReason;
  await db.query(
    `UPDATE orchestrator_eval_matrices
        SET status = 'succeeded', exit_code = 0, completed_at = now(), heartbeat_at = now()
      WHERE id = $1 AND status = 'running'`,
    [matrixId],
  );
} catch (error) {
  await db.query(
    `UPDATE orchestrator_eval_matrices
        SET status = 'failed', exit_code = 1, completed_at = now(),
            heartbeat_at = now(), error_message = $2
      WHERE id = $1 AND status = 'running'`,
    [matrixId, (error instanceof Error ? error.message : String(error)).slice(0, 500)],
  );
  throw error;
} finally {
  clearInterval(heartbeat);
  process.off("SIGTERM", onSigterm);
  process.off("SIGINT", onSigint);
  activeChild?.kill("SIGTERM");
  await db.end();
}
