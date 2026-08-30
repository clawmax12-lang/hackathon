import { Hono } from "hono";
import { one, query } from "../db.js";

export const waitlist = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CountRow = { count: string };

async function signupCount(): Promise<number> {
  const { count } = await one<CountRow>("SELECT COUNT(*) AS count FROM waitlist_signups");
  return Number(count);
}

waitlist.post("/", async (c) => {
  const body = await c.req.json<{ email?: unknown }>().catch(() => ({ email: undefined }));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!EMAIL_RE.test(email) || email.length > 320) {
    return c.json({ error: "A valid email address is required" }, 400);
  }

  // The unique email index is the source of truth. This makes two concurrent
  // submissions safe and treats a repeat submission as a successful signup.
  const [inserted] = await query<{ id: string }>(
    `INSERT INTO waitlist_signups (email)
     VALUES ($1)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email],
  );

  const count = await signupCount();
  return c.json({ ok: true, alreadyJoined: !inserted, count }, inserted ? 201 : 200);
});

waitlist.get("/count", async (c) => c.json({ count: await signupCount() }));
