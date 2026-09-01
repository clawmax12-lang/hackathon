import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getPool, one, query } from "./db.js";
import { appendScanEvent, isTerminalScanEvent, listScanEvents } from "./sse.js";

test("scan events persist, replay in order, and cascade with their scan", async () => {
  const storageKey = `test/scans/${randomUUID()}.jpg`;
  let assetId = "";
  let scanId = "";

  try {
    const asset = await one<{ id: string }>(
      `INSERT INTO media_assets (kind, storage_key, mime_type, byte_size)
       VALUES ('scan_image', $1, 'image/jpeg', 0)
       RETURNING id`,
      [storageKey],
    );
    assetId = asset.id;

    const scan = await one<{ id: string }>(
      `INSERT INTO furniture_scans (image_asset_id, status)
       VALUES ($1, 'uploaded')
       RETURNING id`,
      [assetId],
    );
    scanId = scan.id;

    const firstId = await appendScanEvent(scanId, {
      type: "stage",
      index: 0,
      key: "reading_label",
      status: "started",
      detail: "Reading label",
    });
    const secondId = await appendScanEvent(scanId, { type: "done" });

    assert.ok(secondId > firstId);
    assert.deepEqual(await listScanEvents(scanId, 0), [
      {
        id: firstId,
        event: {
          type: "stage",
          index: 0,
          key: "reading_label",
          status: "started",
          detail: "Reading label",
        },
      },
      { id: secondId, event: { type: "done" } },
    ]);
    assert.deepEqual(await listScanEvents(scanId, firstId), [{ id: secondId, event: { type: "done" } }]);
    assert.equal(isTerminalScanEvent({ type: "done" }), true);
    assert.equal(isTerminalScanEvent({ type: "stage", index: 0, key: "reading_label", status: "started" }), false);

    await query("DELETE FROM furniture_scans WHERE id = $1", [scanId]);
    const remaining = await query<{ count: string }>("SELECT count(*) AS count FROM scan_events WHERE scan_id = $1", [scanId]);
    assert.equal(Number(remaining[0]?.count), 0);
    scanId = "";
  } finally {
    if (scanId) await query("DELETE FROM furniture_scans WHERE id = $1", [scanId]);
    if (assetId) await query("DELETE FROM media_assets WHERE id = $1", [assetId]);
    await (await getPool()).end();
  }
});
