# Catalog database

The database is optimized around a catalog-first product lookup:

1. A package photo is registered in `furniture_scans` and its file metadata in
   `media_assets`.
2. Extracted text or an IKEA item number is matched against `products` and
   `product_aliases`.
3. `source_documents` caches IKEA product pages, manuals, and Firecrawl source
   snapshots. `product_documents` allows one manual to serve several products.
4. `assembly_guides`, `assembly_steps`, and `generated_videos` hold the reusable
   learning experience so it is generated once, not for every user.
5. `product_assets` and `step_assets` attach ordered images and generated
   visuals without putting large binary data in Postgres.
6. `ingestion_batches`, `ingestion_jobs`, and `job_attempts` make the initial
   200-product import and cache-miss fallback observable, retryable, and
   idempotent.

Large files are represented by `media_assets.storage_key`; PDFs, uploaded
photos, and generated video should live in object storage rather than Postgres.
Provider and model names are text fields so the scraping and generation stack
can be changed without a schema migration.

Schema changes use Reshape migrations in this directory. Always run
`specific check` after changing `specific.hcl` or a migration.
