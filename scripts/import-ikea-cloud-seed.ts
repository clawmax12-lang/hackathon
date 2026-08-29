import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import pg from "pg";

const MANIFEST_PATH = path.resolve("data/ikea-se-bestsellers-verified.json");
const BATCH_NAME = "IKEA Sweden Best Sellers Top 200 — verified cloud seed v1";
const USER_AGENT = "Monterra-IKEA-manual-seeder/1.0";

interface SeedManual {
  url: string;
  checksumSha256: string;
  byteSize: number;
  pageCount: number;
}

interface SeedProduct {
  itemNumber: string;
  name: string;
  normalizedName: string;
  category: string | null;
  description: string;
  market: string;
  language: string;
  productUrl: string;
  popularityRank: number;
  metadata: Record<string, unknown>;
  manuals: SeedManual[];
}

interface SeedManifest {
  version: number;
  source: string;
  sourceUrl: string;
  productCount: number;
  productsWithManuals: number;
  uniqueManualCount: number;
  products: SeedProduct[];
}

interface StoredManual extends SeedManual {
  storageKey: string;
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateManual(manual: SeedManual): void {
  const url = new URL(manual.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.ikea.com" ||
    !url.pathname.includes("/assembly_instructions/") ||
    !url.pathname.toLowerCase().endsWith(".pdf")
  ) {
    throw new Error(`Rejected non-official manual URL: ${manual.url}`);
  }
  if (!/^[a-f0-9]{64}$/.test(manual.checksumSha256)) throw new Error(`Invalid checksum: ${manual.url}`);
  if (!Number.isInteger(manual.byteSize) || manual.byteSize <= 0) throw new Error(`Invalid byte size: ${manual.url}`);
  if (!Number.isInteger(manual.pageCount) || manual.pageCount <= 0) throw new Error(`Invalid page count: ${manual.url}`);
}

async function readManifest(): Promise<SeedManifest> {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")) as SeedManifest;
  if (manifest.version !== 1 || manifest.productCount !== 200 || manifest.products.length !== 200) {
    throw new Error("Cloud seed manifest must contain exactly 200 version-1 products");
  }
  const ranks = new Set(manifest.products.map((product) => product.popularityRank));
  const items = new Set(manifest.products.map((product) => product.itemNumber));
  if (ranks.size !== 200 || Math.min(...ranks) !== 1 || Math.max(...ranks) !== 200) {
    throw new Error("Cloud seed manifest must contain unique ranks 1..200");
  }
  if (items.size !== 200) throw new Error("Cloud seed manifest contains duplicate item numbers");
  for (const product of manifest.products) {
    const url = new URL(product.productUrl);
    if (url.hostname !== "www.ikea.com" || !url.pathname.startsWith("/se/sv/p/")) {
      throw new Error(`Rejected non-IKEA Sweden product URL: ${product.productUrl}`);
    }
    for (const manual of product.manuals) validateManual(manual);
  }
  const uniqueManuals = new Set(manifest.products.flatMap((product) => product.manuals.map((manual) => manual.url)));
  const productsWithManuals = manifest.products.filter((product) => product.manuals.length > 0).length;
  if (uniqueManuals.size !== manifest.uniqueManualCount || productsWithManuals !== manifest.productsWithManuals) {
    throw new Error("Cloud seed manifest summary does not match its products");
  }
  return manifest;
}

async function download(url: string): Promise<Buffer> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error as Error;
      if (attempt < 4) await sleep(attempt * 2_000);
    }
  }
  throw lastError ?? new Error(`Download failed: ${url}`);
}

async function ensureManual(manual: SeedManual, storageDir: string): Promise<StoredManual> {
  const storageKey = `manuals/${manual.checksumSha256}.pdf`;
  const absolutePath = path.join(storageDir, storageKey);
  let data: Buffer | undefined;
  try {
    const existing = await fs.readFile(absolutePath);
    if (
      existing.length === manual.byteSize &&
      sha256(existing) === manual.checksumSha256 &&
      existing.subarray(0, 5).toString("latin1") === "%PDF-"
    ) {
      data = existing;
    }
  } catch {
    // A missing first-deploy file is expected.
  }
  if (!data) {
    data = await download(manual.url);
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`PDF magic mismatch: ${manual.url}`);
    if (data.length !== manual.byteSize) throw new Error(`Byte-size mismatch: ${manual.url}`);
    if (sha256(data) !== manual.checksumSha256) throw new Error(`Checksum mismatch: ${manual.url}`);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, data);
  }
  return { ...manual, storageKey };
}

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function upsertManualAsset(client: pg.Client, manual: StoredManual): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO media_assets
       (kind, storage_key, source_url, mime_type, byte_size, checksum_sha256, metadata)
     VALUES ('manual_pdf', $1, $2, 'application/pdf', $3, $4, $5::jsonb)
     ON CONFLICT (storage_key) DO UPDATE SET
       source_url=EXCLUDED.source_url,
       mime_type=EXCLUDED.mime_type,
       byte_size=EXCLUDED.byte_size,
       checksum_sha256=EXCLUDED.checksum_sha256,
       metadata=media_assets.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      manual.storageKey,
      manual.url,
      manual.byteSize,
      manual.checksumSha256,
      JSON.stringify({ validation: "manifest_sha256_byte_size_pdf_magic", provider: "ikea" }),
    ],
  );
  return result.rows[0].id;
}

async function importProduct(
  client: pg.Client,
  batchId: string,
  manifest: SeedManifest,
  product: SeedProduct,
  manuals: Map<string, StoredManual>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    const hasManual = product.manuals.length > 0;
    const productResult = await client.query<{ id: string }>(
      `INSERT INTO products
         (ikea_item_number, name, normalized_name, category, description, market, language,
          product_url, popularity_rank, status, metadata, last_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
       ON CONFLICT (ikea_item_number) DO UPDATE SET
         name=EXCLUDED.name,
         normalized_name=EXCLUDED.normalized_name,
         category=EXCLUDED.category,
         description=EXCLUDED.description,
         market=EXCLUDED.market,
         language=EXCLUDED.language,
         product_url=EXCLUDED.product_url,
         popularity_rank=EXCLUDED.popularity_rank,
         status=EXCLUDED.status,
         metadata=products.metadata || EXCLUDED.metadata,
         last_verified_at=NOW(),
         updated_at=NOW()
       RETURNING id`,
      [
        product.itemNumber,
        product.name,
        product.normalizedName,
        product.category,
        product.description,
        product.market,
        product.language,
        product.productUrl,
        product.popularityRank,
        hasManual ? "ready" : "queued",
        JSON.stringify({ ...product.metadata, cloud_seed_version: manifest.version }),
      ],
    );
    const productId = productResult.rows[0].id;

    for (const [alias, aliasKind] of [
      [product.name, "product_name"],
      [product.description, "full_name"],
      [product.itemNumber, "item_number"],
    ] as const) {
      await client.query(
        `INSERT INTO product_aliases (product_id, alias, normalized_alias, alias_kind, locale)
         VALUES ($1,$2,$3,$4,'sv')
         ON CONFLICT (product_id, normalized_alias) DO UPDATE SET
           alias=EXCLUDED.alias, alias_kind=EXCLUDED.alias_kind`,
        [productId, alias, normalizeText(alias), aliasKind],
      );
    }

    const productPage = await client.query<{ id: string }>(
      `INSERT INTO source_documents
         (kind,status,canonical_url,title,locale,provider,checksum_sha256,metadata,fetched_at,last_verified_at)
       VALUES ('product_page','ready',$1,$2,'sv','firecrawl',$3,$4::jsonb,NOW(),NOW())
       ON CONFLICT (canonical_url) DO UPDATE SET
         status='ready', title=EXCLUDED.title, provider=EXCLUDED.provider,
         checksum_sha256=EXCLUDED.checksum_sha256,
         metadata=source_documents.metadata || EXCLUDED.metadata,
         last_verified_at=NOW(), updated_at=NOW()
       RETURNING id`,
      [
        product.productUrl,
        `${product.description} — verified product page`,
        String(product.metadata.firecrawl_snapshot_sha256 ?? ""),
        JSON.stringify({ discovery_url: manifest.sourceUrl, popularity_rank: product.popularityRank }),
      ],
    );
    await client.query(
      `INSERT INTO product_documents (product_id,document_id,relationship)
       VALUES ($1,$2,'product_page')
       ON CONFLICT (product_id,document_id) DO UPDATE SET relationship='product_page'`,
      [productId, productPage.rows[0].id],
    );

    for (const seedManual of product.manuals) {
      const manual = manuals.get(seedManual.url);
      if (!manual) throw new Error(`Prepared manual missing: ${seedManual.url}`);
      const assetId = await upsertManualAsset(client, manual);
      const document = await client.query<{ id: string }>(
        `INSERT INTO source_documents
           (kind,status,canonical_url,asset_id,title,locale,provider,checksum_sha256,page_count,
            metadata,fetched_at,last_verified_at)
         VALUES ('manual','ready',$1,$2,$3,'sv','ikea',$4,$5,$6::jsonb,NOW(),NOW())
         ON CONFLICT (canonical_url) DO UPDATE SET
           status='ready', asset_id=EXCLUDED.asset_id, title=EXCLUDED.title,
           checksum_sha256=EXCLUDED.checksum_sha256, page_count=EXCLUDED.page_count,
           metadata=source_documents.metadata || EXCLUDED.metadata,
           last_verified_at=NOW(), updated_at=NOW()
         RETURNING id`,
        [
          manual.url,
          assetId,
          `${product.name} assembly instructions`,
          manual.checksumSha256,
          manual.pageCount,
          JSON.stringify({ validation: "verified_manifest_and_redownloaded_sha256", cloud_seed_version: manifest.version }),
        ],
      );
      await client.query(
        `INSERT INTO product_documents (product_id,document_id,relationship)
         VALUES ($1,$2,'assembly_manual')
         ON CONFLICT (product_id,document_id) DO UPDATE SET relationship='assembly_manual'`,
        [productId, document.rows[0].id],
      );
    }

    await client.query(
      `INSERT INTO ingestion_jobs
         (kind,status,batch_id,product_id,provider,idempotency_key,input,output,started_at,completed_at)
       VALUES ('catalog_seed','succeeded',$1,$2,'verified_manifest',$3,$4::jsonb,$5::jsonb,NOW(),NOW())
       ON CONFLICT (idempotency_key) DO UPDATE SET
         status='succeeded', batch_id=EXCLUDED.batch_id, product_id=EXCLUDED.product_id,
         input=EXCLUDED.input, output=EXCLUDED.output, error_message=NULL,
         completed_at=NOW(), updated_at=NOW()`,
      [
        batchId,
        productId,
        `ikea-se-bestseller-cloud-seed-v1:${product.itemNumber}`,
        JSON.stringify({ product_url: product.productUrl, rank: product.popularityRank }),
        JSON.stringify({ manuals_verified: product.manuals.length }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function verifyDatabase(
  client: pg.Client,
  batchId: string,
  manifest: SeedManifest,
): Promise<void> {
  const products = (await client.query<{
    total: number;
    ranks: number;
    ready: number;
    queued: number;
  }>(
    `SELECT count(*)::int AS total,
            count(DISTINCT popularity_rank)::int AS ranks,
            count(*) FILTER (WHERE status='ready')::int AS ready,
            count(*) FILTER (WHERE status='queued')::int AS queued
     FROM products WHERE metadata->>'source'=$1`,
    [manifest.source],
  )).rows[0];
  const documents = (await client.query<{ products_with_manuals: number; unique_manuals: number; invalid_manuals: number }>(
    `SELECT
       count(DISTINCT p.id) FILTER (WHERE pd.relationship='assembly_manual')::int AS products_with_manuals,
       count(DISTINCT sd.id) FILTER (WHERE pd.relationship='assembly_manual')::int AS unique_manuals,
       count(DISTINCT sd.id) FILTER (
         WHERE pd.relationship='assembly_manual' AND (
           sd.status<>'ready' OR sd.page_count IS NULL OR sd.page_count<=0 OR
           sd.checksum_sha256 IS NULL OR ma.storage_key IS NULL OR ma.byte_size IS NULL OR
           ma.checksum_sha256 IS NULL OR ma.mime_type<>'application/pdf'
         )
       )::int AS invalid_manuals
     FROM products p
     LEFT JOIN product_documents pd ON pd.product_id=p.id
     LEFT JOIN source_documents sd ON sd.id=pd.document_id
     LEFT JOIN media_assets ma ON ma.id=sd.asset_id
     WHERE p.metadata->>'source'=$1`,
    [manifest.source],
  )).rows[0];
  const jobs = (await client.query<{ total: number; succeeded: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='succeeded')::int AS succeeded
     FROM ingestion_jobs WHERE batch_id=$1`,
    [batchId],
  )).rows[0];

  const expectedQueued = manifest.productCount - manifest.productsWithManuals;
  if (
    products.total !== manifest.productCount ||
    products.ranks !== manifest.productCount ||
    products.ready !== manifest.productsWithManuals ||
    products.queued !== expectedQueued ||
    documents.products_with_manuals !== manifest.productsWithManuals ||
    documents.unique_manuals !== manifest.uniqueManualCount ||
    documents.invalid_manuals !== 0 ||
    jobs.total !== manifest.productCount ||
    jobs.succeeded !== manifest.productCount
  ) {
    throw new Error(`Cloud seed postcondition failed: ${JSON.stringify({ products, documents, jobs })}`);
  }
}

async function main(): Promise<void> {
  const manifest = await readManifest();
  const storageDir = path.resolve(process.env.STORAGE_DIR ?? ".specific/keys/default/data/volumes/api/storage");
  const client = await connect();
  let batchId = "";
  let lockAcquired = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      ["monterra:ikea-cloud-seed-v1"],
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      console.log("[catalog-sync] another verified manual sync already holds the database lock");
      return;
    }

    const uniqueManuals = new Map<string, SeedManual>();
    for (const manual of manifest.products.flatMap((product) => product.manuals)) {
      uniqueManuals.set(manual.url, manual);
    }
    const preparedManuals = new Map<string, StoredManual>();
    const limit = pLimit(4);
    let completedManuals = 0;
    await Promise.all(
      [...uniqueManuals.values()].map((manual) =>
        limit(async () => {
          preparedManuals.set(manual.url, await ensureManual(manual, storageDir));
          completedManuals += 1;
          console.log(`MANUAL_SYNC ${completedManuals}/${uniqueManuals.size}`);
        }),
      ),
    );

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM ingestion_batches WHERE name=$1 ORDER BY created_at DESC LIMIT 1",
      [BATCH_NAME],
    );
    if (existing.rows[0]) {
      batchId = existing.rows[0].id;
      await client.query(
        `UPDATE ingestion_batches SET status='running', expected_items=200, completed_at=NULL,
           metadata=metadata || $2::jsonb WHERE id=$1`,
        [batchId, JSON.stringify({ source_url: manifest.sourceUrl, seed_version: manifest.version })],
      );
    } else {
      const batch = await client.query<{ id: string }>(
        `INSERT INTO ingestion_batches (name,status,provider,expected_items,metadata,started_at)
         VALUES ($1,'running','verified_manifest',200,$2::jsonb,NOW())
         RETURNING id`,
        [BATCH_NAME, JSON.stringify({ source_url: manifest.sourceUrl, seed_version: manifest.version })],
      );
      batchId = batch.rows[0].id;
    }

    for (const [index, product] of manifest.products.entries()) {
      await importProduct(client, batchId, manifest, product, preparedManuals);
      if ((index + 1) % 25 === 0) console.log(`CLOUD_SEED ${index + 1}/200`);
    }
    await verifyDatabase(client, batchId, manifest);
    await client.query(
      `UPDATE ingestion_batches SET status='succeeded', completed_at=NOW(),
         metadata=metadata || $2::jsonb WHERE id=$1`,
      [
        batchId,
        JSON.stringify({
          products: manifest.productCount,
          products_with_manuals: manifest.productsWithManuals,
          unique_manuals: manifest.uniqueManualCount,
        }),
      ],
    );
    console.log(
      JSON.stringify({
        status: "succeeded",
        products: manifest.productCount,
        productsWithManuals: manifest.productsWithManuals,
        uniqueManuals: manifest.uniqueManualCount,
      }),
    );
  } catch (error) {
    if (batchId) {
      await client.query(
        "UPDATE ingestion_batches SET status='failed', completed_at=NOW(), metadata=metadata || $2::jsonb WHERE id=$1",
        [batchId, JSON.stringify({ error: (error as Error).message })],
      );
    }
    throw error;
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["monterra:ikea-cloud-seed-v1"]).catch(() => undefined);
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
