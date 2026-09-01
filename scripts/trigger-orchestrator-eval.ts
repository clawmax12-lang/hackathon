const enabled = process.env.ORCHESTRATOR_EVAL_ENABLED === "true";
if (!enabled) {
  console.log(JSON.stringify({ event: "orchestrator_eval_trigger_skipped", reason: "disabled" }));
  process.exit(0);
}

const url = process.env.ORCHESTRATOR_EVAL_TRIGGER_URL;
const token = process.env.ORCHESTRATOR_EVAL_TOKEN;
if (!url || !token) {
  throw new Error("ORCHESTRATOR_EVAL_TRIGGER_URL and ORCHESTRATOR_EVAL_TOKEN are required");
}

const response = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(30_000),
});
const text = await response.text();
if (!response.ok) {
  throw new Error(`eval trigger returned ${response.status}: ${text.slice(0, 500)}`);
}
console.log(text);
