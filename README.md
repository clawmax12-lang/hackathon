# Montera

[Public repository](https://github.com/clawmax12-lang/hackathon)

**Fota. Lyssna. Bygg.** Photograph a flat-pack label and Montera identifies the product, opens the manufacturer’s official manual, and turns its diagrams into a calm Swedish, voice-guided step player.

The interaction is camera-first: one shutter tap freezes and submits the frame, real pipeline events appear on that frame, and the guide opens without a composer or confirmation screen. There are no accounts. The first two steps are free; the complete guide costs **49 kr** through a Stripe Payment Link.

## Demo hero

The stage product is **IKEA TRANERED armstödsbricka, mörkbrun — 106.090.02**. Its golden label image, official manual, page renders, hand-reviewed eight-step guide, and Swedish ElevenLabs audio are cached before the API starts.

Measured locally on the golden input:

| Path | Before cache | Current cache path |
|---|---:|---:|
| Photo to useful result | 3:34 | **169 ms to mounted player** |
| Visible trace | — | **63 ms** |
| Catalog lookup alone | — | **17 ms** |

Every guide displays its source. The hero is [based on the manufacturer’s official 8-page manual](https://www.ikea.com/es/es/assembly_instructions/tranered-bandeja-reposabrazos-marron-oscuro__AA-2613017-4-2.pdf). Manual art is rendered directly; the product never invents screws, parts, or assembly imagery.

## How it works

1. The browser captures and uploads one frame.
2. A known article number or golden-input fingerprint takes the deterministic cache path; other photos use Claude vision for OCR and product identification.
3. PostgreSQL performs exact article-number matching first, then fuzzy name/variant matching.
4. A cached, verified manual opens immediately. A miss searches the official catalog and queues generation; after 15 seconds the user gets the honest one-hour concierge offer instead of a dead end.
5. Claude plans Swedish steps grounded in rendered manual pages. ElevenLabs creates one MP3 per step.
6. The player shows the manual’s own page region with per-step audio, **Nästa** and **Repetera** controls, plus optional Swedish voice commands.

The catalog currently contains the verified IKEA Sweden top 200 dataset: **200 real products, 72 with verified manuals, 71 unique PDF files**, plus the separately pinned hero. The schema includes manufacturer-neutral `manufacturer`, `variant`, and `article_no` fields; IKEA-specific ingestion metadata stays isolated in the import layer.

## Batch evidence

The required generalization run produced **20/20 ready guides**, so the target set is **21 guides including TRANERED**. Generation averaged **154 seconds per product** and the measured Claude cost was **$18.1918 total**, including the failed attempts that were recovered. Six ambiguous steps are correctly marked caption-only with no audio.

The checked-in [batch report](data/guide-batch-metrics.json) contains each product’s article number, official manual link, page and step counts, generation time, model cost, retry count, and review count. Its automated audit passed with no invalid page references, overlong narration, incorrect final narration, or missing audio.

## Architecture

| Area | Implementation |
|---|---|
| Web | React + Vite camera, trace, paywall, and step player in `src/` |
| API | Hono upload, SSE, guide, commercial, webhook, and asset routes in `server/src/` |
| Orchestration | Claude tool-use loop with cost/turn guards in `server/src/orchestrator/` |
| Media pipeline | PDF verification/rendering and ElevenLabs narration in `server/src/pipeline/` |
| Data | Specific Postgres + Reshape migrations in `db/migrations/` |
| Storage | Specific persistent volume for scans, PDFs, page PNGs, and step MP3s |
| Evidence | `/api/stats` exposes session, ready-guide, miss, and paid-miss counts |

Stripe sends `checkout.session.completed` events to `/api/stripe/webhook`. The handler verifies the webhook signature, marks the linked miss paid, and writes a loud `PAID MISS — FULFILL WITHIN ONE HOUR` log entry.

## Run locally

Infrastructure, secrets, migrations, and both services are defined by Specific. Do not run the frontend/backend separately.

```bash
npm install
specific check
specific dev
```

Put local values in gitignored `specific.local`:

- `anthropic_api_key`
- `anthropic_workspace_id`
- `elevenlabs_api_key`
- optional `firecrawl_api_key`
- `stripe_payment_link_url`
- `stripe_webhook_secret`

Production values are managed in the [Specific Dashboard](https://dashboard.specific.dev). Deploy with the repository’s configured Specific/GitHub workflow.

Useful checks:

```bash
npm run check
npm run build
specific exec api -- npx tsx scripts/seed-hero-product.ts
specific exec api -- npx tsx scripts/seed-hero-guide.ts
```

## API surface

- `POST /api/scans` — upload and immediately queue/resolve a scan
- `GET /api/scans/:id/events` — replayable real SSE events
- `GET /api/guides/:id` — step images, audio, source link, and grounded instructions
- `POST /api/misses` — persistent concierge miss log
- `GET /api/stats` — submission/traction counters
- `POST /api/stripe/webhook` — signature-verified paid-miss updates
- `GET /api/healthz` — runtime capability check

## Safety and source policy

- Never add a step, quantity, part, or tool unless the official manual shows it.
- Put warnings first in the relevant step.
- Use a caption-only step when the diagram is ambiguous; do not bluff with narration.
- Show “Baserad på tillverkarens officiella manual” with a direct link on every guide.
- Generated guides use the manufacturer’s real diagrams only—no generated assembly pixels.
