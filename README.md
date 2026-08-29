# Monterra

Photo of a flat-pack product in → pedagogic Swedish assembly **video** out.

A Claude agent orchestrates the whole pipeline: it identifies the product from the
photo (vision), matches it against a Postgres catalog of IKEA bestsellers, fetches
and cryptographically verifies the official assembly manual from ikea.com, reads
the manual's diagram pages as images, plans 10–20 pedagogic steps, narrates them
with ElevenLabs (Swedish, Stockholm-accented voice), and composes a 1080p video
with ffmpeg — Ken Burns motion over the actual manual diagrams, step overlays,
and safety banners.

## Running it

```bash
cp .env.example .env       # fill in the keys (ask a teammate — never commit .env)
npm install
npx tsx server/src/index.ts &   # API on :3002 (or PORT=...)
npm run dev                     # web UI; /api is proxied to the server
```

Or run everything (web + api + Postgres with migrations) under
[Specific](https://specific.dev): put the same secrets in `specific.local` and run
`specific dev`.

- `GET /api/healthz` shows which capabilities are live (`db`, `ffmpeg`,
  `anthropic`, `elevenlabs`, `mock`).
- `MOCK_ORCHESTRATOR=1` runs the identical pipeline with scripted reasoning
  (real narration + render) — the demo fallback when no Anthropic key is set.
- System deps: ffmpeg **with drawtext** (BtbN build), `poppler-utils`,
  `liberation-sans-fonts`.

## How it is put together

| Piece | Where |
|---|---|
| Claude orchestrator (tool-use loop, cost guards, job persistence) | `server/src/orchestrator/` |
| Pipeline stages: identify, catalog, manual fetch/verify, TTS, render | `server/src/pipeline/` |
| API: SSE progress, uploads, video streaming with Range, follow-up Q&A | `server/src/routes/`, `server/src/index.ts` |
| Postgres schema (Reshape migrations) | `db/migrations/` |
| Web UI (Vite + React) | `src/` — API client in `src/lib/api.ts` |
| UI ↔ backend contract | `.context/API_CONTRACT.md` |

Catalog rows are treated as hints, never trusted: a manual only counts once its
PDF has been downloaded, `%PDF`-verified, page-counted and SHA-256'd — and the
pipeline repairs stale catalog rows as it verifies them.

## Secrets

This repository is **public**: no key ever goes in a committed file. Copy
`.env.example` → `.env` (gitignored) and get values from a teammate. Real
environment variables always override `.env`.
