import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "../env.js";
import { maybeOne, one, query } from "../db.js";

export const commercial = new Hono();

commercial.get("/config", (c) => c.json({
  stripePaymentLinkUrl: config.stripePaymentLinkUrl || null,
  guidePriceSek: config.guidePriceSek,
}));

commercial.post("/misses", async (c) => {
  const body = await c.req.json<{ scanId?: string; query?: string }>();
  const queryText = body.query?.trim().slice(0, 500) || "Okänd möbel";
  let scanId: string | null = body.scanId ?? null;
  if (scanId && !await maybeOne("SELECT id FROM furniture_scans WHERE id=$1", [scanId])) scanId = null;
  const miss = await one<{ id: string }>(
    `INSERT INTO misses (scan_id,query) VALUES ($1,$2)
     ON CONFLICT (scan_id) WHERE scan_id IS NOT NULL DO UPDATE SET query=EXCLUDED.query
     RETURNING id`,
    [scanId, queryText],
  );
  console.warn(`[MISS] id=${miss.id} scan=${scanId ?? "none"} query=${JSON.stringify(queryText)}`);
  return c.json({ missId: miss.id }, 201);
});

commercial.get("/stats", async (c) => {
  const stats = await one<{ sessions: number; guides: number; misses: number; paid_misses: number }>(
    `SELECT
       (SELECT count(*)::int FROM furniture_scans) AS sessions,
       (SELECT count(*)::int FROM assembly_guides WHERE status='ready') AS guides,
       (SELECT count(*)::int FROM misses) AS misses,
       (SELECT count(*)::int FROM misses WHERE paid) AS paid_misses`,
  );
  return c.json({ sessions: stats.sessions, guides: stats.guides, misses: stats.misses, paidMisses: stats.paid_misses });
});

function stripeSignatureIsValid(payload: string, header: string): boolean {
  if (!config.stripeWebhookSecret) return false;
  const values = header.split(",").map((part) => part.split("=", 2));
  const timestamp = values.find(([key]) => key === "t")?.[1];
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0 || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", config.stripeWebhookSecret).update(`${timestamp}.${payload}`).digest("hex");
  return signatures.some((signature) => {
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  });
}

commercial.post("/stripe/webhook", async (c) => {
  if (!config.stripeWebhookSecret) return c.json({ error: "Stripe webhook is not configured" }, 503);
  const payload = await c.req.text();
  if (!stripeSignatureIsValid(payload, c.req.header("stripe-signature") ?? "")) return c.json({ error: "Invalid signature" }, 400);
  const event = JSON.parse(payload) as {
    id?: string;
    type?: string;
    data?: { object?: { id?: string; client_reference_id?: string; payment_status?: string } };
  };
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type ?? "")) {
    const session = event.data?.object;
    const scanId = session?.client_reference_id?.replace(/^scan:/, "");
    if (scanId && (session?.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded")) {
      const paid = await query<{ id: string; query: string }>(
        `UPDATE misses SET paid=TRUE,paid_at=NOW(),stripe_session_id=$2 WHERE scan_id=$1 RETURNING id,query`,
        [scanId, session?.id ?? event.id ?? null],
      );
      for (const miss of paid) console.error(`[PAID MISS — FULFILL WITHIN ONE HOUR] id=${miss.id} scan=${scanId} query=${JSON.stringify(miss.query)}`);
    }
  }
  return c.json({ received: true });
});
