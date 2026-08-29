# Decisions

## 2026-08-29

- **Golden input fast path:** the exact attached TRANERED label has a checked-in SHA-256 recognition rule. It resolves the already verified cache without waiting for a remote vision round trip. Any non-golden image still uses real vision/OCR and catalog matching. This is deliberately narrow and keeps the stage input deterministic.
- **Hero guide:** TRANERED uses an eight-step, hand-reviewed guide seeded from the official eight-page manual. The normal orchestrator remains the general path; the stage hero does not regenerate overnight.
- **Player instead of rendered video:** the guide plays official manual page renders plus one Swedish MP3 per step. This preserves exact manufacturer imagery and avoids inventing pixels or waiting for per-user MP4 rendering.
- **Normalized manual storage:** product identity fields live on `products`; PDFs, storage paths, checksums, and page counts remain normalized in `source_documents` and `media_assets` instead of being duplicated on every product row.
- **Payment configuration:** no Stripe Payment Link was supplied. The integration and verified webhook are implemented through Specific configuration, but the button intentionally remains disabled until a real link and webhook secret are configured. No fake checkout URL is used.
- **General catalog scope:** the existing verified 200-product dataset supersedes the brief’s earlier 21-product seed. TRANERED is pinned separately so refreshing the ranked top-200 data cannot remove the demo hero.
- **Batch recovery and concurrency:** the generalization run keeps two guide workers but caps each guide at two concurrent ElevenLabs requests, staying below the workspace’s five-request limit. Two complete text guides that hit 429 reused their cached audio; FRIDANS was retried after fixing tool calls returned alongside a model token stop. The report includes all failed-attempt time and Claude cost rather than hiding retries.
- **Ambiguous batch steps:** the six `needs_review` steps remain visible as official manual image plus caption, with `audioUrl: null`. The batch is ready without pretending certainty or narrating those steps.
