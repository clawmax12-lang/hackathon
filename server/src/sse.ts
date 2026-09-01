import { query } from "./db.js";

export type StageKey =
  | "reading_label"
  | "identifying"
  | "finding_instructions"
  | "planning"
  | "rendering";

export const STAGE_INDEX: Record<StageKey, 0 | 1 | 2 | 3 | 4> = {
  reading_label: 0,
  identifying: 1,
  finding_instructions: 2,
  planning: 3,
  rendering: 4,
};

export type ScanEvent =
  | { type: "stage"; index: 0 | 1 | 2 | 3 | 4; key: StageKey; status: "started" | "done"; detail?: string }
  | {
      type: "product_match";
      productId: string;
      name: string;
      itemNumber?: string;
      variant?: string;
      confidence: number;
      method: string;
      candidates: { productId: string; name: string; variant?: string; confidence: number }[];
    }
  | { type: "render_progress"; done: number; total: number; label: string }
  | {
      type: "guide_ready";
      guideId: string;
      title: string;
      videoUrl: string;
      thumbnailUrl: string;
      durationSeconds: number;
      stepCount: number;
    }
  | { type: "error"; stage: StageKey; message: string; recoverable: boolean }
  | { type: "done" };

export interface StoredScanEvent {
  id: number;
  event: ScanEvent;
}

export async function appendScanEvent(scanId: string, event: ScanEvent): Promise<number> {
  const [stored] = await query<{ id: string }>(
    `INSERT INTO scan_events (scan_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [scanId, event.type, JSON.stringify(event)],
  );
  if (!stored) throw new Error("scan event was not persisted");
  return Number(stored.id);
}

export async function listScanEvents(scanId: string, afterId: number): Promise<StoredScanEvent[]> {
  const rows = await query<{ id: string; payload: ScanEvent }>(
    `SELECT id, payload
       FROM scan_events
      WHERE scan_id = $1 AND id > $2
      ORDER BY id ASC`,
    [scanId, afterId],
  );
  return rows.map((row) => ({ id: Number(row.id), event: row.payload }));
}

export function isTerminalScanEvent(event: ScanEvent): boolean {
  return event.type === "done" || event.type === "error";
}
