import { config } from "./env.js";
import { maybeOne, query } from "./db.js";
import { runMockOrchestrator } from "./orchestrator/mock.js";
import { runOrchestrator } from "./orchestrator/run.js";
import { finalizeRun, type ToolContext } from "./orchestrator/tools.js";

export async function enqueueGuideJob(scanId: string, pinnedProductId: string | null, note: string | null): Promise<void> {
  const suffix = pinnedProductId ? `:${pinnedProductId}` : "";
  await query(
    `INSERT INTO ingestion_jobs (kind, status, scan_id, provider, model, idempotency_key, input, available_at, max_attempts)
     VALUES ('guide_generation', 'pending', $1, 'anthropic', $2, $3, $4, now(), 2)
     ON CONFLICT (idempotency_key) DO UPDATE SET status = 'pending', available_at = now(), updated_at = now()`,
    [scanId, config.orchestratorModel, `guide_generation:${scanId}${suffix}`, JSON.stringify({ pinned_product_id: pinnedProductId, note })],
  );
}

interface JobRow {
  id: string;
  scan_id: string;
  input: { pinned_product_id?: string | null; note?: string | null } | null;
}

async function claimNext(): Promise<JobRow | null> {
  return maybeOne<JobRow>(
    `UPDATE ingestion_jobs SET status = 'running', attempt_count = attempt_count + 1, started_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM ingestion_jobs
         WHERE kind = 'guide_generation' AND status = 'pending' AND available_at <= now()
         ORDER BY priority DESC, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id, scan_id, input`,
  );
}

async function runJob(job: JobRow): Promise<void> {
  const scan = await maybeOne<{ id: string; image_key: string | null }>(
    `SELECT fs.id, ma.storage_key AS image_key
       FROM furniture_scans fs LEFT JOIN media_assets ma ON ma.id = fs.image_asset_id
      WHERE fs.id = $1`,
    [job.scan_id],
  );
  if (!scan || !scan.image_key) throw new Error(`scan ${job.scan_id} missing image`);

  const ctx: ToolContext = {
    scanId: scan.id,
    scanImageKey: scan.image_key,
    userNote: job.input?.note ?? null,
    pinnedProductId: job.input?.pinned_product_id ?? null,
    state: {},
  };

  try {
    if (config.mockOrchestrator) {
      await runMockOrchestrator(ctx);
    } else {
      await runOrchestrator(ctx, { jobId: job.id });
    }
  } catch (err) {
    ctx.state.finished ??= {
      outcome: "failed",
      message: "Guiden kunde inte bearbetas just nu. Försök igen om en stund.",
    };
    await finalizeRun(ctx).catch((eventError) => {
      console.error(`[jobs] failed to persist terminal event for ${job.id}:`, eventError);
    });
    throw err;
  }

  const outcome = ctx.state.finished?.outcome ?? "failed";
  await query(
    `UPDATE ingestion_jobs SET status = $2, completed_at = now(), updated_at = now(), output = $3 WHERE id = $1`,
    [job.id, outcome === "success" ? "succeeded" : "failed", JSON.stringify(ctx.state.finished ?? {})],
  );
}

// Each worker keeps claiming jobs until the queue is empty, then exits and
// frees its slot. A worker that races ahead and finds nothing pending must
// not block new work from starting on other slots — so slots are topped up
// independently every tick, not gated on the whole batch finishing.
let activeWorkers = 0;

export function startJobRunner(): void {
  const worker = async () => {
    activeWorkers += 1;
    try {
      let job = await claimNext();
      while (job) {
        try {
          await runJob(job);
        } catch (err) {
          console.error(`[jobs] job ${job.id} crashed:`, err);
          await query(`UPDATE ingestion_jobs SET status = 'failed', completed_at = now(), updated_at = now(), error_message = $2 WHERE id = $1`, [
            job.id,
            String((err as Error).message).slice(0, 500),
          ]).catch(() => {});
        }
        job = await claimNext();
      }
    } finally {
      activeWorkers -= 1;
    }
  };
  const tick = () => {
    while (activeWorkers < config.jobConcurrency) void worker();
  };
  setInterval(tick, 2000);
  tick();
}
