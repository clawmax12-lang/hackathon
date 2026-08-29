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

type StoredEvent = { id: number; event: ScanEvent };
type Subscriber = (id: number, event: ScanEvent) => void;

class ScanEventHub {
  private logs = new Map<string, StoredEvent[]>();
  private subs = new Map<string, Set<Subscriber>>();

  emit(scanId: string, event: ScanEvent): void {
    const log = this.logs.get(scanId) ?? [];
    const id = log.length + 1;
    log.push({ id, event });
    this.logs.set(scanId, log);
    for (const sub of this.subs.get(scanId) ?? []) {
      try {
        sub(id, event);
      } catch {
        /* subscriber gone */
      }
    }
  }

  /** Replays events after `afterId`, then streams live. Returns unsubscribe. */
  subscribe(scanId: string, afterId: number, sub: Subscriber): () => void {
    for (const stored of this.logs.get(scanId) ?? []) {
      if (stored.id > afterId) sub(stored.id, stored.event);
    }
    let set = this.subs.get(scanId);
    if (!set) {
      set = new Set();
      this.subs.set(scanId, set);
    }
    set.add(sub);
    return () => set.delete(sub);
  }

  isFinished(scanId: string): boolean {
    const log = this.logs.get(scanId) ?? [];
    return log.some((s) => s.event.type === "done" || (s.event.type === "error" && !s.event.recoverable));
  }
}

export const hub = new ScanEventHub();
