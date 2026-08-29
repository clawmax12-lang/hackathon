import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import pLimit from "p-limit";
import pg from "pg";

const exec = promisify(execFile);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const IMPORT_NAME = "IKEA Sweden Best Sellers Top 200 — Firecrawl 2026-08-29";
const DISCOVERY_URL = "https://www.ikea.com/se/sv/cat/best-sellers/";
const DISCOVERY_SCRAPE_ID = "01a04d6a-89c5-715f-8c2a-98ee05bb7b84";

interface RankedProduct {
  url: string;
  name: string;
  description: string;
  sourcePage: number;
  sourcePosition: number;
}

interface ManualFile {
  url: string;
  storageKey: string;
  byteSize: number;
  checksum: string;
  pageCount: number;
}

interface PreparedProduct extends RankedProduct {
  rank: number;
  itemNumber: string;
  category: string | null;
  snapshotPath: string;
  snapshot: Buffer;
  snapshotMimeType: "text/markdown" | "application/json";
  snapshotChecksum: string;
  snapshotStorageKey: string;
  manualUrls: string[];
  manuals: ManualFile[];
  manualFailures: { url: string; error: string }[];
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function articleFromUrl(url: string): { filenameArticle: string; itemNumber: string } {
  const match = new URL(url).pathname.match(/-(s?\d{8})\/?$/i);
  if (!match) throw new Error(`No IKEA article number in ${url}`);
  return { filenameArticle: match[1].toLowerCase(), itemNumber: match[1].replace(/^s/i, "") };
}

function manualUrlsFromSnapshot(snapshot: string): string[] {
  const urls = snapshot.match(
    /https:\/\/www\.ikea\.com\/[^\s"'<>\])]*\/assembly_instructions\/[^\s"'<>\])]*?\.pdf/gi,
  );
  return [...new Set((urls ?? []).map((url) => url.replaceAll("&amp;", "&")))];
}

async function readCandidates(filename: string, limit: number): Promise<RankedProduct[]> {
  const raw = JSON.parse(await fs.readFile(filename, "utf8")) as {
    result?: string;
    products?: RankedProduct[];
  };
  const parsed = raw.result ? (JSON.parse(raw.result) as { products?: RankedProduct[] }) : raw;
  const products = parsed.products?.slice(0, limit) ?? [];
  if (products.length !== limit) {
    throw new Error(`Expected ${limit} ranked products, found ${products.length}`);
  }
  for (const product of products) {
    const url = new URL(product.url);
    if (url.hostname !== "www.ikea.com" || !url.pathname.startsWith("/se/sv/p/")) {
      throw new Error(`Non-IKEA Sweden product URL rejected: ${product.url}`);
    }
  }
  return products;
}

async function findSnapshot(snapshotDir: string, filenameArticle: string): Promise<string> {
  const filenames = await fs.readdir(snapshotDir);
  const suffixes = [`-${filenameArticle}.md`, `-${filenameArticle}.json`];
  const filename = suffixes
    .map((suffix) => filenames.find((candidate) => candidate.toLowerCase().endsWith(suffix)))
    .find(Boolean);
  if (!filename) throw new Error(`Missing Firecrawl snapshot for ${filenameArticle}`);
  return path.join(snapshotDir, filename);
}

async function verifyAndStorePdf(url: string, storageDir: string): Promise<ManualFile> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("PDF magic bytes missing");
  }

  const checksum = sha256(data);
  const storageKey = `manuals/${checksum}.pdf`;
  const absolutePath = path.join(storageDir, storageKey);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, data);

  const { stdout } = await exec("pdfinfo", [absolutePath], { timeout: 30_000 });
  const pageCount = Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1] ?? "0");
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error("pdfinfo returned no positive page count");
  }

  return { url, storageKey, byteSize: data.byteLength, checksum, pageCount };
}

async function prepareProduct(
  product: RankedProduct,
  rank: number,
  snapshotDir: string,
  storageDir: string,
  manualCache: Map<string, Promise<ManualFile>>,
): Promise<PreparedProduct> {
  const { filenameArticle, itemNumber } = articleFromUrl(product.url);
  const snapshotPath = await findSnapshot(snapshotDir, filenameArticle);
  const snapshot = await fs.readFile(snapshotPath);
  if (snapshot.length === 0) throw new Error(`Empty Firecrawl snapshot for ${itemNumber}`);
  const snapshotChecksum = sha256(snapshot);
  const snapshotExtension = snapshotPath.endsWith(".json") ? "json" : "md";
  const snapshotStorageKey = `scrapes/ikea-se/${snapshotChecksum}.${snapshotExtension}`;
  const snapshotOutputPath = path.join(storageDir, snapshotStorageKey);
  await fs.mkdir(path.dirname(snapshotOutputPath), { recursive: true });
  await fs.writeFile(snapshotOutputPath, snapshot);

  const manualUrls = manualUrlsFromSnapshot(snapshot.toString("utf8"));
  const manuals: ManualFile[] = [];
  const manualFailures: { url: string; error: string }[] = [];
  for (const url of manualUrls) {
    let promise = manualCache.get(url);
    if (!promise) {
      promise = verifyAndStorePdf(url, storageDir);
      manualCache.set(url, promise);
    }
    try {
      manuals.push(await promise);
    } catch (error) {
      manualFailures.push({ url, error: (error as Error).message });
    }
  }

  return {
    ...product,
    rank,
    itemNumber,
    category: product.description.split(",")[1]?.trim() || null,
    snapshotPath,
    snapshot,
    snapshotMimeType: snapshotPath.endsWith(".json") ? "application/json" : "text/markdown",
    snapshotChecksum,
    snapshotStorageKey,
    manualUrls,
    manuals,
    manualFailures,
  };
}

async function databaseClient(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; run through specific exec api");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function upsertAsset(
  client: pg.Client,
  asset: {
    kind: "source_snapshot" | "manual_pdf";
    storageKey: string;
    sourceUrl: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO media_assets
       (kind, storage_key, source_url, mime_type, byte_size, checksum_sha256, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (storage_key) DO UPDATE SET
       source_url = EXCLUDED.source_url,
       mime_type = EXCLUDED.mime_type,
       byte_size = EXCLUDED.byte_size,
       checksum_sha256 = EXCLUDED.checksum_sha256,
       metadata = media_assets.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      asset.kind,
      asset.storageKey,
      asset.sourceUrl,
      asset.mimeType,
      asset.byteSize,
      asset.checksum,
      JSON.stringify(asset.metadata),
    ],
  );
  return result.rows[0].id;
}

async function importProduct(client: pg.Client, batchId: string, product: PreparedProduct): Promise<void> {
  const now = new Date().toISOString();
  const hasVerifiedManual = product.manuals.length > 0;
  const metadata = {
    source: "ikea_se_best_sellers",
    evidence_url: DISCOVERY_URL,
    firecrawl_discovery_scrape_id: DISCOVERY_SCRAPE_ID,
    firecrawl_snapshot_sha256: product.snapshotChecksum,
    source_page: product.sourcePage,
    source_position: product.sourcePosition,
    popularity_rank_basis: "IKEA Sweden best-sellers page order",
    manual_discovery_status: hasVerifiedManual ? "verified" : "not_found",
    discovered_manual_count: product.manualUrls.length,
    verified_manual_count: product.manuals.length,
    imported_at: now,
  };

  await client.query("BEGIN");
  try {
    const productResult = await client.query<{ id: string }>(
      `INSERT INTO products
         (ikea_item_number, name, normalized_name, category, description, market, language,
          product_url, popularity_rank, status, metadata, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, 'SE', 'sv', $6, $7, $8, $9::jsonb, NOW())
       ON CONFLICT (ikea_item_number) DO UPDATE SET
         name = EXCLUDED.name,
         normalized_name = EXCLUDED.normalized_name,
         category = EXCLUDED.category,
         description = EXCLUDED.description,
         market = EXCLUDED.market,
         language = EXCLUDED.language,
         product_url = EXCLUDED.product_url,
         popularity_rank = EXCLUDED.popularity_rank,
         status = CASE WHEN EXCLUDED.status = 'ready' THEN 'ready' ELSE products.status END,
         metadata = products.metadata || EXCLUDED.metadata,
         last_verified_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [
        product.itemNumber,
        product.name,
        normalizeText(product.description),
        product.category,
        product.description,
        product.url,
        product.rank,
        hasVerifiedManual ? "ready" : "queued",
        JSON.stringify(metadata),
      ],
    );
    const productId = productResult.rows[0].id;

    for (const [alias, aliasKind] of [
      [product.name, "product_name"],
      [product.description, "full_name"],
      [product.itemNumber, "item_number"],
    ] as const) {
      await client.query(
        `INSERT INTO product_aliases
           (product_id, alias, normalized_alias, alias_kind, locale)
         VALUES ($1, $2, $3, $4, 'sv')
         ON CONFLICT (product_id, normalized_alias) DO UPDATE SET
           alias = EXCLUDED.alias,
           alias_kind = EXCLUDED.alias_kind`,
        [productId, alias, normalizeText(alias), aliasKind],
      );
    }

    const snapshotAssetId = await upsertAsset(client, {
      kind: "source_snapshot",
      storageKey: product.snapshotStorageKey,
      sourceUrl: product.url,
      mimeType: product.snapshotMimeType,
      byteSize: product.snapshot.byteLength,
      checksum: product.snapshotChecksum,
      metadata: { provider: "firecrawl", discovery_scrape_id: DISCOVERY_SCRAPE_ID },
    });
    const snapshotDocument = await client.query<{ id: string }>(
      `INSERT INTO source_documents
         (kind, status, canonical_url, asset_id, title, locale, provider, checksum_sha256,
          metadata, fetched_at, last_verified_at)
       VALUES ('scrape_snapshot', 'ready', $1, $2, $3, 'sv', 'firecrawl', $4, $5::jsonb, NOW(), NOW())
       ON CONFLICT (canonical_url) DO UPDATE SET
         status = 'ready',
         asset_id = EXCLUDED.asset_id,
         title = EXCLUDED.title,
         provider = EXCLUDED.provider,
         checksum_sha256 = EXCLUDED.checksum_sha256,
         metadata = source_documents.metadata || EXCLUDED.metadata,
         fetched_at = NOW(),
         last_verified_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      [
        product.url,
        snapshotAssetId,
        `${product.description} — Firecrawl snapshot`,
        product.snapshotChecksum,
        JSON.stringify({ discovery_url: DISCOVERY_URL, popularity_rank: product.rank }),
      ],
    );
    await client.query(
      `INSERT INTO product_documents (product_id, document_id, relationship)
       VALUES ($1, $2, 'product_page')
       ON CONFLICT (product_id, document_id) DO UPDATE SET relationship = EXCLUDED.relationship`,
      [productId, snapshotDocument.rows[0].id],
    );

    for (const manual of product.manuals) {
      const assetId = await upsertAsset(client, {
        kind: "manual_pdf",
        storageKey: manual.storageKey,
        sourceUrl: manual.url,
        mimeType: "application/pdf",
        byteSize: manual.byteSize,
        checksum: manual.checksum,
        metadata: { validation: "pdf_magic_and_pdfinfo", provider: "ikea" },
      });
      const document = await client.query<{ id: string }>(
        `INSERT INTO source_documents
           (kind, status, canonical_url, asset_id, title, locale, provider, checksum_sha256,
            page_count, metadata, fetched_at, last_verified_at)
         VALUES ('manual', 'ready', $1, $2, $3, 'sv', 'ikea', $4, $5, $6::jsonb, NOW(), NOW())
         ON CONFLICT (canonical_url) DO UPDATE SET
           status = 'ready',
           asset_id = EXCLUDED.asset_id,
           title = EXCLUDED.title,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           page_count = EXCLUDED.page_count,
           metadata = source_documents.metadata || EXCLUDED.metadata,
           fetched_at = NOW(),
           last_verified_at = NOW(),
           updated_at = NOW()
         RETURNING id`,
        [
          manual.url,
          assetId,
          `${product.name} assembly instructions`,
          manual.checksum,
          manual.pageCount,
          JSON.stringify({
            discovered_by: "firecrawl",
            discovered_from: product.url,
            validation: "downloaded_pdf_magic_sha256_pdfinfo",
          }),
        ],
      );
      await client.query(
        `INSERT INTO product_documents (product_id, document_id, relationship)
         VALUES ($1, $2, 'assembly_manual')
         ON CONFLICT (product_id, document_id) DO UPDATE SET relationship = EXCLUDED.relationship`,
        [productId, document.rows[0].id],
      );
    }

    const failed = product.manualFailures.length > 0;
    await client.query(
      `INSERT INTO ingestion_jobs
         (kind, status, batch_id, product_id, provider, idempotency_key, input, output,
          error_message, started_at, completed_at)
       VALUES ('catalog_seed', $1, $2, $3, 'firecrawl', $4, $5::jsonb, $6::jsonb, $7, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO UPDATE SET
         status = EXCLUDED.status,
         batch_id = EXCLUDED.batch_id,
         product_id = EXCLUDED.product_id,
         input = EXCLUDED.input,
         output = EXCLUDED.output,
         error_message = EXCLUDED.error_message,
         completed_at = NOW(),
         updated_at = NOW()`,
      [
        failed ? "failed" : "succeeded",
        batchId,
        productId,
        `ikea-se-bestseller-firecrawl-2026-08-29:${product.itemNumber}`,
        JSON.stringify({ product_url: product.url, rank: product.rank }),
        JSON.stringify({
          snapshot_sha256: product.snapshotChecksum,
          manual_urls_discovered: product.manualUrls.length,
          manuals_verified: product.manuals.length,
          manual_failures: product.manualFailures,
        }),
        failed ? `${product.manualFailures.length} discovered manual(s) failed verification` : null,
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      candidates: { type: "string" },
      snapshots: { type: "string" },
      "storage-dir": { type: "string" },
      limit: { type: "string", default: "200" },
      report: { type: "string" },
    },
  });
  const candidateFile = path.resolve(
    values.candidates ?? ".context/ikea-best-sellers-products-firecrawl.json",
  );
  const snapshotDir = path.resolve(
    values.snapshots ?? ".context/firecrawl-products/.firecrawl",
  );
  const reportFile = path.resolve(values.report ?? ".context/ikea-import-report.json");
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) throw new Error("limit must be 1..200");
  const storageDir = path.resolve(
    values["storage-dir"] ??
      process.env.STORAGE_DIR ??
      ".specific/keys/default/data/volumes/api/storage",
  );

  const candidates = await readCandidates(candidateFile, limit);
  const manualCache = new Map<string, Promise<ManualFile>>();
  const concurrent = pLimit(4);
  const prepared = await Promise.all(
    candidates.map((product, index) =>
      concurrent(() => prepareProduct(product, index + 1, snapshotDir, storageDir, manualCache)),
    ),
  );

  const client = await databaseClient();
  let batchId = "";
  try {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM ingestion_batches WHERE name = $1 ORDER BY created_at DESC LIMIT 1",
      [IMPORT_NAME],
    );
    if (existing.rows[0]) {
      batchId = existing.rows[0].id;
      await client.query(
        "UPDATE ingestion_batches SET status='running', expected_items=$2, started_at=COALESCE(started_at,NOW()), completed_at=NULL WHERE id=$1",
        [batchId, limit],
      );
    } else {
      const batch = await client.query<{ id: string }>(
        `INSERT INTO ingestion_batches
           (name, status, provider, expected_items, metadata, started_at)
         VALUES ($1, 'running', 'firecrawl', $2, $3::jsonb, NOW())
         RETURNING id`,
        [
          IMPORT_NAME,
          limit,
          JSON.stringify({
            source_url: DISCOVERY_URL,
            discovery_scrape_id: DISCOVERY_SCRAPE_ID,
            selection: "first 200 products in IKEA Sweden best-sellers page order",
          }),
        ],
      );
      batchId = batch.rows[0].id;
    }

    for (const [index, product] of prepared.entries()) {
      await importProduct(client, batchId, product);
      if ((index + 1) % 10 === 0 || index + 1 === prepared.length) {
        console.log(`DATABASE_IMPORT ${index + 1}/${prepared.length}`);
      }
    }

    const manualProducts = prepared.filter((product) => product.manuals.length > 0).length;
    const verifiedManuals = new Set(prepared.flatMap((product) => product.manuals.map((manual) => manual.url))).size;
    const verificationFailures = prepared.flatMap((product) => product.manualFailures);
    const batchStatus = verificationFailures.length === 0 ? "succeeded" : "failed";
    const summary = {
      batchId,
      status: batchStatus,
      candidateProducts: prepared.length,
      productsWithVerifiedManuals: manualProducts,
      productsWithoutAssemblyManuals: prepared.length - manualProducts,
      uniqueVerifiedManuals: verifiedManuals,
      verificationFailures,
      sourceUrl: DISCOVERY_URL,
      firecrawlDiscoveryScrapeId: DISCOVERY_SCRAPE_ID,
      completedAt: new Date().toISOString(),
    };
    await client.query(
      `UPDATE ingestion_batches
       SET status=$2, metadata=metadata || $3::jsonb, completed_at=NOW()
       WHERE id=$1`,
      [batchId, batchStatus, JSON.stringify(summary)],
    );
    await fs.mkdir(path.dirname(reportFile), { recursive: true });
    await fs.writeFile(reportFile, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(summary));
    if (verificationFailures.length > 0) process.exitCode = 2;
  } catch (error) {
    if (batchId) {
      await client.query(
        `UPDATE ingestion_batches
         SET status='failed', metadata=metadata || $2::jsonb, completed_at=NOW()
         WHERE id=$1`,
        [batchId, JSON.stringify({ fatal_error: (error as Error).message })],
      );
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
