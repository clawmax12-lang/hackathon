import { spawn } from "node:child_process";

const baselineBatchId = process.env.ORCHESTRATOR_EVAL_BASELINE_BATCH_ID ?? "";
const candidateBatchId = process.env.ORCHESTRATOR_EVAL_CANDIDATE_BATCH_ID ?? "";
const limit = Number(process.env.ORCHESTRATOR_EVAL_LIMIT ?? "2");
const maxUsdPerBatch = Number(
  process.env.ORCHESTRATOR_EVAL_MAX_ANTHROPIC_USD_PER_BATCH ?? "25",
);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!uuidV4.test(baselineBatchId) || !uuidV4.test(candidateBatchId)) {
  throw new Error("matrix requires valid baseline and candidate batch IDs");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
  throw new Error("ORCHESTRATOR_EVAL_LIMIT must be an integer from 1 to 20");
}
if (!Number.isFinite(maxUsdPerBatch) || maxUsdPerBatch <= 0 || maxUsdPerBatch > 60) {
  throw new Error("ORCHESTRATOR_EVAL_MAX_ANTHROPIC_USD_PER_BATCH must be in (0, 60]");
}

async function run(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/eval-orchestrator.ts", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`eval command exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

await run([
  "run",
  `--batch-id=${baselineBatchId}`,
  "--prompt-version=monterra-system-v2",
  "--effort=default",
  `--limit=${limit}`,
  `--max-total-anthropic-usd=${maxUsdPerBatch}`,
  "--confirm-provider-costs",
]);

await run([
  "run",
  `--batch-id=${candidateBatchId}`,
  "--prompt-version=monterra-system-v3",
  "--effort=high",
  `--limit=${limit}`,
  `--max-total-anthropic-usd=${maxUsdPerBatch}`,
  "--confirm-provider-costs",
]);

await run([
  "compare",
  `--baseline-batch=${baselineBatchId}`,
  `--candidate-batch=${candidateBatchId}`,
]);
