import { Hono } from "hono";
import { maybeOne, one } from "../db.js";

export const waitlist = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

waitlist.post("/", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return c.json({ error: "valid email required" }, 400);
  }

  const existing = await maybeOne("SELECT id FROM waitlist_signups WHERE email = $1", [email]);
  if (!existing) {
    await one("INSERT INTO waitlist_signups (email) VALUES ($1) RETURNING id", [email]);
  }
  const { count } = await one<{ count: string }>("SELECT COUNT(*) AS count FROM waitlist_signups");
  return c.json({ ok: true, alreadyJoined: Boolean(existing), count: Number(count) }, existing ? 200 : 201);
});

waitlist.get("/count", async (c) => {
  const { count } = await one<{ count: string }>("SELECT COUNT(*) AS count FROM waitlist_signups");
  return c.json({ count: Number(count) });
});
