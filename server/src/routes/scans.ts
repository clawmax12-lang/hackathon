import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../env.js";
import { maybeOne, one } from "../db.js";
import { storeAsset } from "../storage.js";
import { hub } from "../sse.js";
import { enqueueGuideJob } from "../jobs.js";

export const scans = new Hono();

scans.post("/", async (c) => {
  const body = await c.req.parseBody();
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  const demo = body.demo === "1" || body.demo === "true";

  let data: Buffer;
  let ext = ".jpg";
  const photo = body.photo;
  if (photo instanceof File) {
    if (photo.size > 15 * 1024 * 1024) return c.json({ error: "image too large (max 15 MB)" }, 413);
    data = Buffer.from(await photo.arrayBuffer());
    ext = photo.type === "image/png" ? ".png" : ".jpg";
  } else if (demo) {
    data = await fs.readFile(path.join(config.sampleDir, "kallax-photo.jpg"));
  } else {
    return c.json({ error: "attach a photo or set demo=1" }, 400);
  }

  const scanId = randomUUID();
  const assetId = await storeAsset({ kind: "scan_image", storageKey: `scans/${scanId}${ext}`, data });
  await one(`INSERT INTO furniture_scans (id, image_asset_id, status) VALUES ($1, $2, 'uploaded') RETURNING id`, [scanId, assetId]);
  await enqueueGuideJob(scanId, null, note);
  return c.json({ scanId }, 202);
});

scans.post("/:id/rematch", async (c) => {
  const scanId = c.req.param("id");
  const { productId } = await c.req.json<{ productId: string }>();
  if (!productId) return c.json({ error: "productId required" }, 400);
  const scan = await maybeOne("SELECT id FROM furniture_scans WHERE id = $1", [scanId]);
  if (!scan) return c.json({ error: "unknown scan" }, 404);
  await enqueueGuideJob(scanId, productId, null);
  return c.json({ ok: true }, 202);
});

scans.get("/:id", async (c) => {
  const scanId = c.req.param("id");
  const row = await maybeOne<{
    status: string;
    matched_product_id: string | null;
    match_confidence: number | null;
    product_name: string | null;
    guide_id: string | null;
    guide_status: string | null;
    video_status: string | null;
  }>(
    `SELECT fs.status, fs.matched_product_id, fs.match_confidence, p.name AS product_name,
            ag.id AS guide_id, ag.status AS guide_status, gv.status AS video_status
       FROM furniture_scans fs
       LEFT JOIN products p ON p.id = fs.matched_product_id
       LEFT JOIN assembly_guides ag ON ag.product_id = fs.matched_product_id
       LEFT JOIN generated_videos gv ON gv.guide_id = ag.id
      WHERE fs.id = $1
      ORDER BY ag.updated_at DESC NULLS LAST LIMIT 1`,
    [scanId],
  );
  if (!row) return c.json({ error: "unknown scan" }, 404);

  const stageIndex =
    row.video_status === "ready" ? 5 : row.guide_status ? 4 : row.matched_product_id ? 2 : row.status === "recognizing" ? 1 : 0;
  return c.json({
    status: row.status,
    stageIndex,
    match: row.matched_product_id
      ? { productId: row.matched_product_id, name: row.product_name, confidence: row.match_confidence }
      : null,
    guideId: row.video_status === "ready" ? row.guide_id : null,
  });
});

scans.get("/:id/events", (c) => {
  const scanId = c.req.param("id");
  const lastId = Number(c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? 0) || 0;

  return streamSSE(c, async (stream) => {
    let unsubscribe = () => {};
    let finished = false;
    const queue: { id: number; payload: string; type: string }[] = [];
    let notify: (() => void) | null = null;

    unsubscribe = hub.subscribe(scanId, lastId, (id, event) => {
      queue.push({ id, payload: JSON.stringify(event), type: event.type });
      notify?.();
    });
    stream.onAbort(() => {
      finished = true;
      unsubscribe();
      notify?.();
    });

    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "{}" });
    }, 15000);

    try {
      while (!finished) {
        while (queue.length > 0) {
          const item = queue.shift()!;
          await stream.writeSSE({ id: String(item.id), event: item.type, data: item.payload });
          if (item.type === "done" || item.type === "error") finished = true;
        }
        if (finished || hub.isFinished(scanId)) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 5000);
        });
        notify = null;
      }
      while (queue.length > 0) {
        const item = queue.shift()!;
        await stream.writeSSE({ id: String(item.id), event: item.type, data: item.payload });
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});
