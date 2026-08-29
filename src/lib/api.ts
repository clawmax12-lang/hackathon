// Monterra API client — the contract with server/src (see .context/API_CONTRACT.md).

export type ScanEvent =
  | { type: "stage"; index: 0 | 1 | 2 | 3 | 4; key: string; status: "started" | "done"; detail?: string }
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
  | { type: "guide_ready"; guideId: string; title: string; videoUrl: string; thumbnailUrl: string; durationSeconds: number; stepCount: number }
  | { type: "error"; stage: string; message: string; recoverable: boolean }
  | { type: "done" };

export interface GuideStep {
  stepNumber: number;
  title: string;
  instruction: string;
  safetyWarning: string | null;
  estimatedSeconds: number;
  parts: string[];
  tools: string[];
  manualPages: number[];
  imageUrl: string | null;
  audioUrl: string | null;
  focusRegion: "top" | "center" | "bottom" | "full";
  needsReview: boolean;
}

export interface GuideJson {
  guideId: string;
  title: string;
  summary: string;
  productName: string;
  category: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number;
  manualUrl: string | null;
  steps: GuideStep[];
}

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");

function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

function absoluteAssetUrl(url: string | null): string | null {
  if (!url || /^https?:\/\//.test(url)) return url;
  return apiUrl(url.startsWith("/") ? url : `/${url}`);
}

export async function startScan(opts: { photo?: File; demo?: boolean; note?: string }): Promise<{ scanId: string }> {
  const form = new FormData();
  if (opts.photo) form.append("photo", opts.photo);
  if (opts.demo) form.append("demo", "1");
  if (opts.note) form.append("note", opts.note);
  const res = await fetch(apiUrl("/api/scans"), { method: "POST", body: form });
  if (!res.ok) throw new Error(`startScan failed: ${res.status}`);
  return res.json();
}

/** Opens the SSE stream; the browser's EventSource handles Last-Event-ID replay on reconnect. */
export function openScanEvents(scanId: string, onEvent: (e: ScanEvent) => void): () => void {
  const source = new EventSource(apiUrl(`/api/scans/${scanId}/events`));
  const types = ["stage", "product_match", "render_progress", "guide_ready", "error", "done"] as const;
  for (const type of types) {
    source.addEventListener(type, (msg) => {
      try {
        onEvent(JSON.parse((msg as MessageEvent).data) as ScanEvent);
      } catch {
        /* ignore malformed event */
      }
      if (type === "done" || type === "error") source.close();
    });
  }
  return () => source.close();
}

export async function getScan(scanId: string): Promise<{
  status: string;
  stageIndex: number;
  match: { productId: string; name: string; confidence: number } | null;
  guideId: string | null;
}> {
  const res = await fetch(apiUrl(`/api/scans/${scanId}`));
  if (!res.ok) throw new Error(`getScan failed: ${res.status}`);
  return res.json();
}

export async function getGuide(guideId: string): Promise<GuideJson> {
  const res = await fetch(apiUrl(`/api/guides/${guideId}`));
  if (!res.ok) throw new Error(`getGuide failed: ${res.status}`);
  const guide = await res.json() as GuideJson;
  return {
    ...guide,
    videoUrl: absoluteAssetUrl(guide.videoUrl),
    thumbnailUrl: absoluteAssetUrl(guide.thumbnailUrl),
    steps: guide.steps.map((step) => ({
      ...step,
      imageUrl: absoluteAssetUrl(step.imageUrl),
      audioUrl: absoluteAssetUrl(step.audioUrl),
    })),
  };
}

export async function rematch(scanId: string, productId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/scans/${scanId}/rematch`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId }),
  });
  if (!res.ok) throw new Error(`rematch failed: ${res.status}`);
}

export async function askQuestion(guideId: string, question: string): Promise<{ answer: string }> {
  const res = await fetch(apiUrl(`/api/guides/${guideId}/questions`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`askQuestion failed: ${res.status}`);
  return res.json();
}

export async function getPublicConfig(): Promise<{ stripePaymentLinkUrl: string | null; guidePriceSek: number }> {
  const res = await fetch(apiUrl("/api/config"));
  if (!res.ok) throw new Error(`getPublicConfig failed: ${res.status}`);
  return res.json();
}

export async function logMiss(scanId: string | null, query: string): Promise<void> {
  await fetch(apiUrl("/api/misses"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scanId, query }),
  });
}
