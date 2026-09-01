# Montera production roadmap v2

Technical plan for turning the hackathon build into a real product. Version 2 adds a
prompt-engineering layer on top of the architecture plan: it treats the Claude
orchestrator as a production system with the same rigor as the database, and it
defines how founders and coding agents work on this repository so the codebase
compounds instead of decaying.

Scope of this document: engineering only. No fundraising or pricing advice.

Status of the foundation branch (`cursor/production-foundation-6c69`):

| Change | State |
|---|---|
| `MOCK_ORCHESTRATOR` explicit; production never falls into mock silently | done |
| `PITCH_MODE` driven by `VITE_PITCH_MODE`, not hardcoded | done |
| Scan events persisted in Postgres (`007_scan_events.toml`, `sse.ts`, replay via `Last-Event-ID`) | done |
| Job runner always writes a terminal event on failure | done |
| `sse.test.ts` + `npm run test:server` | done |
| Opaque recovery overlay (`thinking-state--recovery`) | done |
| SSE replay timing investigation | closed, no bug: late EventSource connections replay persisted events in order including the terminal `error`; `Last-Event-ID` resumes correctly. The browser observation was a test-sequencing artifact. No code change. |

Every gate below requires an explicit human review before merge.

---

## 0. Principles

1. **Source fidelity over fluency.** Every step, part count, and warning must trace to a manual page. A guide that reads well and is wrong is a liability, not a feature. This rule shapes the prompts, the tools, and the evals.
2. **Modular monolith.** One Hono API, one job runner, one Postgres. Module boundaries by domain (`catalog`, `scan`, `guide`, `narration`, `render`, `billing`), not by technology. Split into services only when a measured constraint forces it.
3. **Durable by default.** Anything a user can wait on is a row in Postgres first and a stream second. The SSE work on this branch is the pattern; payments and renders follow it.
4. **Prompts are code.** Versioned, reviewed, tested against fixtures, rolled out behind a flag. `PROMPT_VERSION` in `style.ts` already exists; extend it to every prompt.
5. **Measured, not assumed.** Effort level, model choice, and prompt wording are chosen by evals on our own fixtures, not by intuition or by what worked on a previous model.
6. **Fail loud in production, fake nothing.** Mock and pitch paths exist only behind explicit flags. Missing credentials produce a terminal error event and a legible message.

---

## 1. Target architecture

```
web (Vite/React, camera-first)
  └─ POST /scans  ─────────────────────┐
  └─ GET  /scans/:id/events (SSE, replay from Last-Event-ID)
                                       ▼
api (Hono)                     ingestion_jobs (Postgres, SKIP LOCKED)
  routes/scans, guides,                │
  commercial (Stripe), waitlist        ▼
                               job runner (Node, JOB_CONCURRENCY)
                                 └─ orchestrator (Claude tool loop)
                                      ├─ identify (vision)          ─ Anthropic
                                      ├─ catalog / manual (Firecrawl fallback)
                                      ├─ plan + write_step_to_db
                                      ├─ synthesize_narration       ─ ElevenLabs
                                      └─ render_video (ffmpeg / player assets)
                               scan_events (durable, ordered, cascades with scan)
                               media_assets / source_documents / generated_videos
```

Storage: local filesystem behind `storage.ts` today; swap to S3-compatible blob storage
behind the same interface when deploying. Migrations: Reshape TOML in `db/migrations/`.

### 1.1 Module boundaries (server/src)

| Module | Owns | Must not import |
|---|---|---|
| `catalog` | products, source_documents, verification of manual PDFs | orchestrator, routes |
| `scan` | furniture_scans, scan_events, SSE replay | orchestrator internals |
| `orchestrator` | Claude loop, tool definitions, prompts, cost guard | routes |
| `pipeline/*` | pure-ish functions: identify, manual, narration, render, qa | routes, sse |
| `billing` | Stripe webhooks, entitlements, idempotency keys | orchestrator |
| `routes` | HTTP only; validate, call a module, return | pipeline internals |

Enforce with an ESLint `no-restricted-imports` rule per folder once the split is done.

---

## 2. The orchestrator as a production system

This is the core of the product and the part most shaped by the Fable 5.1 guidance.
Current state: `run.ts` runs `claude-opus-5` with a 12-minute deadline, 24-turn cap,
$3 cost guard, prompt caching on the system prompt, and tool results returned as-is.
Good bones. The changes below are ordered by risk reduction per hour.

### 2.1 Conversation hygiene (correctness, do first)

The loop in `run.ts` is already append-only: each `resp.content` is pushed unchanged and
tool results follow. Keep it that way and make it a tested invariant, because on Fable
5.1 thinking blocks are bound to the exact conversation that produced them. Any prefix
edit returns a 400 or silently drops blocks.

Rules to encode, with a unit test on the message-array builder:

- Never mutate `SYSTEM_PROMPT` or `TOOL_DEFINITIONS` mid-run. If a run needs different instructions (cost guard, deadline warning), send them as a **turn-scoped system message** (`role: "system"`, `clear_at: "next_user_message"`, beta `mid-conversation-system-clear-at-2026-08-21`), not as a text block spliced into the user turn as the cost guard does today.
- Never delete or rewrite earlier turns. Earlier turn-scoped messages stay in the array byte-for-byte; the API clears them.
- Compaction: the 12-minute, 24-turn envelope rarely needs it. If a run ever must compact, replace the whole history with one summary message plus the pending tool results, and replay nothing else. Use the compaction instruction from §4.3 with the six preserve-items adapted to a run (product decision, verified document id, steps written so far, cost so far, failures and how they were handled, what remains).
- Log `input_transformations` in a staging run with `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`) to confirm the harness makes no hidden edits before Fable 5.1 goes live.

### 2.2 Batching and turn economy

`write_step_to_db` already asks for all steps in one reply. Extend the pattern:

- After every tool-result turn, append the batch nudge as a turn-scoped system message: *"First privately list what you need next; then request every item that doesn't depend on another's result in this one response."* Cost: a few tokens per turn. Benefit: `lookup_catalog` + `fetch_and_verify_manual_pdf` for several candidates, or `confirm_match` + `plan_assembly_guide`, collapse into one round trip.
- Measure turns-per-successful-guide before and after. Target: median ≤ 7 turns for a catalog hit (identify → lookup → verify → confirm+plan → steps → narration+render → finish).
- Fix the observed failure mode from `DECISIONS.md`: tool calls returned alongside a `max_tokens` stop. `run.ts` already executes them. Add a metric for it; if it recurs above 1% of turns, raise `max_tokens` for the step-writing turn only.

### 2.3 Effort as a first-class knob

Effort is the primary intelligence/latency/cost control on Fable 5.1, and the level names
do not map to the same amount of thinking as on Fable 5. Do not carry over assumptions.

| Call site | Start at | Sweep against | Why |
|---|---|---|---|
| `identify.ts` vision OCR | `low` (Fable 5.1) vs current Haiku | 40-photo fixture set, exact item-number match | At `low` Fable 5.1 is competitive with smaller models on cost and scores higher; this is a bounded extraction task |
| Orchestrator decision turns | `high` | turns, cost, success rate on 20 fixture products | Default; recommended starting point |
| Step-writing turn (`plan_assembly_guide` → `write_step_to_db`) | `high`, never `xhigh`/`max` | step-count accuracy vs hand-reviewed KALLAX/TRANERED | At `xhigh`/`max` the model may draft the whole deliverable in thinking and then again in output; that doubles a 20-step turn |
| `qa.ts` follow-up answers | `medium` | 30 Q&A pairs graded for grounding | Latency-sensitive (user is mid-assembly), bounded context |

Search triggering caveat: at `low` effort Fable 5.1 calls retrieval tools less and answers from memory more. The orchestrator must never guess a manual URL from memory. Two defenses: run decision turns at `high`, and add to the system prompt the verification rule — a recognized product name is not the same as knowing its current manual; `lookup_catalog` and `fetch_and_verify_manual_pdf` are mandatory before any manual is used.

Config: `ANTHROPIC_EFFORT_ORCHESTRATOR`, `ANTHROPIC_EFFORT_VISION`, `ANTHROPIC_EFFORT_QA` in `env.ts`, per-call override, logged into `job_attempts` alongside model and tokens so evals can be sliced by effort.

### 2.4 Vision: give the model a way to look closer

IKEA manuals are almost wordless diagrams; step accuracy depends on reading small
screw icons, counts, and arrows. Fable 5.1 does its best vision work when it can crop
and zoom rather than reason over a whole page once.

Add one tool: `inspect_manual_region(document_id, page, x0, y0, x1, y1)` returning the
region rendered at 2–3× scale (pdftoppm is already installed; `render.ts` already
crops regions). Prompt guidance: *"When a count, screw type, or direction is not
legible at page scale, call `inspect_manual_region` on that area before writing the
step. Prefer one inspection over a `needs_review` flag; prefer `needs_review` over a
guess."* Measure: `needs_review` rate and part-count accuracy on the 20-product
fixture set before/after.

Also: `plan_assembly_guide` returns every page as an image block. Keep them as
`image` content blocks, not base64 strings inside text — base64 in tool output is a
known trigger for safeguard false positives (`stop_reason: "refusal"`). Add a
`refusal` branch in `run.ts` that records the stop reason in `job_attempts`, retries
once with a rephrased task message, then finishes `failed` with a Swedish message.
Never loop on a refusal.

### 2.5 Prompt rewrite: system.ts v3

Keep the decision policy; restructure it so each rule states the behavior, the trigger,
and the reason, and so the user-visible contract is explicit. Draft, to be evaluated
against the fixture set before it replaces v2:

```text
You are the orchestrator of Montera. You turn one photo of a flat-pack product into a
Swedish assembly guide (steps, narration, and a rendered guide) by calling tools.
You run unattended inside a job; nobody can answer questions mid-run.

WHAT THE USER SEES
- Five stages: (0) reading the label, (1) identifying the model, (2) finding the
  instructions, (3) planning the sequence, (4) creating the guide. Tools emit stage
  transitions automatically.
- You may add one short Swedish line per stage with report_progress, stating what you
  found and what you do next ("Hittade 3 kandidater, kontrollerar KALLAX-manualen").
  Nothing else you write is shown to the user, so do not narrate in plain text.

SOURCE FIDELITY (highest priority)
- Every step, count, tool, and warning must be visible on a manual page you received.
- Recognizing a product name is not knowing its manual. Always lookup_catalog, and only
  use a manual after fetch_and_verify_manual_pdf succeeds. Unverified URLs are hints.
- If a count or part is not legible, call inspect_manual_region on that area. If it is
  still ambiguous, set needs_review=true and write "skruvarna som visas". Never guess.

DECISION POLICY
- With IDENTIFICATION_RESULT present: start at lookup_catalog; do not re-read the image.
- With pinned product_id: confirm_match that product and proceed.
- Catalog miss: firecrawl_find_manual, then register_product_from_web so the catalog
  converges.
- Several manuals: pick the primary assembly manual (name match, else most pages).
- confirm_match as soon as confident, with honest confidence and alternatives. Below
  0.5, still pick the best candidate and list alternatives.

EXECUTION
- Before each reply, list privately what you need next, then call every tool that does
  not depend on another's result in that same reply.
- After plan_assembly_guide, write ALL steps with write_step_to_db in one reply, then
  synthesize_narration, then render_video, then finish. render_video is the deliverable.
- Retry transient failures once. Impossible stages (no manual exists, unreadable photo)
  end with finish(failed) and a helpful Swedish message.
- Do not re-call tools whose results you already have.

LANGUAGE
- All user-visible text is Swedish. visual_prompt is English. Reasoning: any language.
```

Changes versus v2 and why: the "you run unattended" line replaces the implicit
assumption and removes the model's temptation to end with prose; the source-fidelity
block moves above the decision policy because that is the ordering of priorities; the
batching sentence is inline; the progress-update rule says exactly what a user-facing
line should contain instead of leaving it to taste.

`style.ts` stays largely as is; it is already specific and example-driven. Two edits:
add one complete worked example of a correct `write_step_to_db` call (input diagram
description → tool arguments → one-sentence rationale), and move the Khan-style
narration rules to a numbered list so evals can reference rule ids.

### 2.6 Follow-up Q&A (`qa.ts`)

Fable 5.1 is more likely than Fable 5 to reproduce source passages without marking them
as quotations. Manuals are diagrams so the risk is small, but step text is our own
generated content and the answer must not silently restate it as fresh fact. Add one
complete example to the system prompt: user question, the answer in the assistant's
own words citing "steg 4, sida 6", one short marked quotation at most, and a
rationale line. Ground rule already present ("om du inte vet: säg det") stays.

### 2.7 Observability for LLM runs

Extend `job_attempts` with `effort`, `stop_reason`, `refusal`, `tool_calls_in_turn`,
`prompt_version`. Emit one structured log line per turn. Dashboards: cost per guide,
turns per guide, `needs_review` rate, refusal rate, p50/p95 wall time per stage. Query
these through Specific's observability tooling; do not build a separate stack.

---

## 3. Evals: the gate for every prompt and model change

No prompt, model, or effort change ships without a run of the fixture suite.

- **Fixture set:** 20 products with verified manuals (KALLAX and TRANERED hand-reviewed as gold; 18 more from the verified bestseller import). 40 label photos (clean, blurred, angled, partial) with known item numbers.
- **Metrics:** identification exact-match, catalog-hit rate, step count within ±1 of gold, part-count accuracy on gold steps, `needs_review` rate, refusal rate, turns, cost USD, wall time.
- **Runner:** `scripts/eval-orchestrator.ts` writing one JSON row per run into `eval_runs`; a `compare` mode that diffs two `prompt_version`/model/effort combinations.
- **Policy:** a change ships when it is not worse on fidelity metrics and better on at least one of cost, turns, or time. Fidelity regressions block regardless of savings.
- **Frequency:** every prompt PR; every model or effort change; monthly against the live model to catch provider drift.

This is the direct application of "start at `high`, then sweep the other levels against
your own evals" to our system. Without the suite, effort tuning is guesswork.

---

## 4. How we build: founders and coding agents

The repository is built largely with AI coding agents. The Fable 5.1 guidance applies to
them as much as to the product. These rules go into `AGENTS.md` (repo-level, always
applied) so every agent session inherits them.

### 4.1 AGENTS.md additions (draft)

```text
## Working in this repository

Autonomy. You are operating autonomously; the user is not watching in real time. For
reversible actions that follow from the request, proceed. Stop only for destructive
actions, anything that pushes or merges, or genuine scope changes. Before ending a turn,
check your last paragraph: if it is a plan or a promise, do that work now.

Scope. The request sets the scope. Do not narrow, widen, or swap it. If you find a
pre-existing bug or a nearby improvement, report it as a follow-up; do not fix it in
this change unless the requested behavior cannot work without it. State any assumption
you made about ambiguous wording in your summary.

Tests. Commit tests only where the task asks for them or the neighboring code already
has tests, sized like the neighboring files (roughly one focused test per stated
behavior). Scratch checks live under /tmp and are not committed.

Edits. Prefer surgical edits over whole-file rewrites unless most of the file changes.

Progress. Before starting, say in one line what you are about to do. Close with a recap
that stands on its own: what you found, what you changed, what is next.

Git. Never push, merge, force-push, or amend without an explicit instruction in the
current message. Work on cursor/<name>-<suffix> branches. One logical change per commit.

Prompts are code. Any change under server/src/orchestrator/prompts/ bumps
PROMPT_VERSION and runs scripts/eval-orchestrator.ts; include the before/after table
in the PR description.

Environment. Use `specific dev` to run locally and `specific check` after any change to
specific.hcl. Provider keys are optional in dev; production fails closed without them.
```

### 4.2 Writing style for docs, PRs, and user-facing copy

Remove mannered prose. Say what you mean; when a literal phrase exists, use it. Use
lists and tables when the content is multifaceted; keep conversational replies in plain
prose. This applies to PR descriptions, `DECISIONS.md` entries, and the Swedish UI
copy alike (the narration rules in `style.ts` already enforce it for the product).

### 4.3 Compaction instruction for long agent sessions

When a coding session is compacted client-side, the summary must preserve, exactly:
(1) problems that came up and how they were handled; (2) approaches tried or set aside
and why; (3) everything asked for, decided, ruled out, or set as a constraint, in the
user's words; (4) exactly where things stand; (5) what is still open or promised;
(6) hard-to-reconstruct details (ids, paths, numbers, exact wording). Keep the user's
statements close to verbatim; condense the agent's own reasoning to conclusions.
Plans and decisions live in the repository, not in session artifacts: the v1 of this
document was lost twice from a transient artifacts directory before it was committed.

### 4.4 Subagent usage

Let the lead agent keep working while subagents run (explore, debug, computer-use
verification). Do not idle on a subagent; do independent work and collect the result
when it arrives. Give every subagent the full context it needs in the prompt: it does
not see the conversation.

---

## 5. Reliability, payments, and security

### 5.1 Jobs and events (mostly done on this branch)

- `ingestion_jobs` are already claimed with `FOR UPDATE SKIP LOCKED`. To add: a heartbeat column and a reaper that re-queues jobs whose worker died mid-run.
- `scan_events` is the source of truth for progress; SSE is a view over it. Replay after a late connection and resume via `Last-Event-ID` were verified at runtime against the real API; no change needed. Add a regression test that opens the stream after the terminal event exists so the property stays covered.
- Idempotent tool side effects are already in place: `write_step_to_db` upserts on `(guide_id, step_number)`; narration and animated clips are content-hash cached. Keep this property for every new tool.

### 5.2 Payments

- Stripe webhook handler verifies signature, stores `event.id` in `stripe_events` with a unique constraint, and processes inside one transaction. Duplicate deliveries are no-ops.
- Entitlement is a row (`guide_entitlements`), checked server-side on `GET /guides/:id/*`. The client never decides whether a paywall applies.
- Missing `STRIPE_*` config → button disabled, server refuses checkout with a clear error (current fail-closed behavior, keep).

### 5.3 Security and abuse

- Rate limit `POST /scans` per IP and per device token; cap image size; strip EXIF.
- Cost guard stays at $3/run; add a per-day account cap and an alert at 80%.
- Provider keys only via Specific secrets; never in `.env` committed files.
- Signed, expiring URLs for media once blob storage is remote.

### 5.4 CI

`npm run check` (tsc), `npm run build`, `npm run test:server` against an ephemeral
Postgres, `specific check`, migration dry-run, and the eval suite on prompt PRs (can be
a manual approval step because it costs real tokens).

---

## 6. Execution order and gates

Every gate is a human review of a pull request. Nothing is merged before the
corresponding approval.

**Gate A — foundation (this branch).** Explicit mock/pitch flags, durable scan events,
terminal events on failure, opaque recovery overlay, server test baseline, Cloud Agent
environment config. Review the PR diff; approve to merge.

**Gate B — orchestrator hardening.** §2.1 turn-scoped system messages replacing the
spliced cost-guard text; §2.2 batch nudge and turn metric; §2.4 refusal handling and
`inspect_manual_region`; `job_attempts` columns from §2.7. Ship behind
`PROMPT_VERSION` bump with v2 still default. Approval required after eval table.

**Gate C — evals and Fable 5.1 migration.** §3 fixture set and runner. Effort sweep per
§2.3. Switch `orchestratorModel`/`visionModel` and default effort only where the table
shows no fidelity regression. Approval required per model switch.

**Gate D — product completeness.** Payments with idempotent webhooks and server-side
entitlements; miss logging on catalog misses; voice control ("nästa"/"backa") in the
player; error copy review.

**Gate E — operability.** Module boundaries with lint enforcement; remote blob storage;
rate limits and caps; CI as in §5.4; dashboards from §2.7.

Each gate produces: a diff, the eval table where relevant, a `DECISIONS.md` entry, and
a walkthrough recording for UI-affecting work.

---

## 7. Things deliberately not done

- No microservices, queues, or Kubernetes until a measured constraint appears.
- No generative video hero path (ElevenLabs does audio only; the animated clip path is best-effort and falls back to manual-page renders).
- No client-side paywall logic.
- No prompt changes without the eval suite.
- No merges or pushes from agent sessions without an explicit, in-message instruction.
