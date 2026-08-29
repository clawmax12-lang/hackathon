import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const MANIFEST_PATH = path.resolve("data/ikea-se-bestsellers-verified.json");
const BATCH_NAME = "IKEA Sweden Best Sellers Top 200 — cloud metadata seed v1";

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

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function readManifest(): Promise<SeedManifest> {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")) as SeedManifest;
  if (manifest.version !== 1 || manifest.productCount !== 200 || manifest.products.length !== 200) {
    throw new Error("Metadata seed requires the verified 200-product v1 manifest");
  }
  const ranks = new Set(manifest.products.map((product) => product.popularityRank));
  const items = new Set(manifest.products.map((product) => product.itemNumber));
  if (ranks.size !== 200 || Math.min(...ranks) !== 1 || Math.max(...ranks) !== 200 || items.size !== 200) {
    throw new Error("Metadata seed manifest has invalid ranks or duplicate item numbers");
  }
  return manifest;
}

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function main(): Promise<void> {
  const manifest = await readManifest();
  const client = await connect();
  let batchId = "";
  try {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM ingestion_batches WHERE name=$1 ORDER BY created_at DESC LIMIT 1",
      [BATCH_NAME],
    );
    if (existing.rows[0]) {
      batchId = existing.rows[0].id;
      await client.query(
        "UPDATE ingestion_batches SET status='running', expected_items=200, completed_at=NULL WHERE id=$1",
        [batchId],
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ingestion_batches (name,status,provider,expected_items,metadata,started_at)
         VALUES ($1,'running','verified_manifest',200,$2::jsonb,NOW()) RETURNING id`,
        [
          BATCH_NAME,
          JSON.stringify({ source_url: manifest.sourceUrl, seed_version: manifest.version, phase: "metadata" }),
        ],
      );
      batchId = inserted.rows[0].id;
    }

    for (const [index, product] of manifest.products.entries()) {
      await client.query("BEGIN");
      try {
        const productResult = await client.query<{ id: string }>(
          `INSERT INTO products
             (ikea_item_number,name,normalized_name,category,description,market,language,
              product_url,popularity_rank,status,metadata,last_verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
           ON CONFLICT (ikea_item_number) DO UPDATE SET
             name=EXCLUDED.name, normalized_name=EXCLUDED.normalized_name,
             category=EXCLUDED.category, description=EXCLUDED.description,
             market=EXCLUDED.market, language=EXCLUDED.language,
             product_url=EXCLUDED.product_url, popularity_rank=EXCLUDED.popularity_rank,
             status=CASE WHEN products.status='ready' THEN 'ready'::catalog_status ELSE EXCLUDED.status END,
             metadata=products.metadata || EXCLUDED.metadata,
             last_verified_at=NOW(), updated_at=NOW()
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
            product.manuals.length > 0 ? "enriching" : "queued",
            JSON.stringify({ ...product.metadata, cloud_seed_version: manifest.version, cloud_file_status: "pending" }),
          ],
        );
        const productId = productResult.rows[0].id;

        for (const [alias, aliasKind] of [
          [product.name, "product_name"],
          [product.description, "full_name"],
          [product.itemNumber, "item_number"],
        ] as const) {
          await client.query(
            `INSERT INTO product_aliases (product_id,alias,normalized_alias,alias_kind,locale)
             VALUES ($1,$2,$3,$4,'sv')
             ON CONFLICT (product_id,normalized_alias) DO UPDATE SET
               alias=EXCLUDED.alias, alias_kind=EXCLUDED.alias_kind`,
            [productId, alias, normalizeText(alias), aliasKind],
          );
        }

        const productPage = await client.query<{ id: string }>(
          `INSERT INTO source_documents
             (kind,status,canonical_url,title,locale,provider,checksum_sha256,metadata,fetched_at,last_verified_at)
           VALUES ('product_page','ready',$1,$2,'sv','firecrawl',$3,$4::jsonb,NOW(),NOW())
           ON CONFLICT (canonical_url) DO UPDATE SET
             title=EXCLUDED.title, provider=EXCLUDED.provider,
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

        for (const manual of product.manuals) {
          const document = await client.query<{ id: string }>(
            `INSERT INTO source_documents
               (kind,status,canonical_url,title,locale,provider,checksum_sha256,page_count,metadata)
             VALUES ('manual','discovered',$1,$2,'sv','ikea',$3,$4,$5::jsonb)
             ON CONFLICT (canonical_url) DO UPDATE SET
               title=EXCLUDED.title, checksum_sha256=EXCLUDED.checksum_sha256,
               page_count=EXCLUDED.page_count,
               metadata=source_documents.metadata || EXCLUDED.metadata,
               updated_at=NOW()
             RETURNING id`,
            [
              manual.url,
              `${product.name} assembly instructions`,
              manual.checksumSha256,
              manual.pageCount,
              JSON.stringify({
                expected_byte_size: manual.byteSize,
                validation: "locally_verified_manifest_cloud_file_pending",
              }),
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
            `ikea-se-bestseller-cloud-metadata-v1:${product.itemNumber}`,
            JSON.stringify({ product_url: product.productUrl, rank: product.popularityRank }),
            JSON.stringify({ manual_candidates: product.manuals.length, files_pending: product.manuals.length }),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      if ((index + 1) % 50 === 0) console.log(`METADATA_SEED ${index + 1}/200`);
    }

    const stats = (await client.query<{ products: number; ranks: number; manual_products: number; jobs: number }>(
      `SELECT
         count(DISTINCT p.id)::int AS products,
         count(DISTINCT p.popularity_rank)::int AS ranks,
         count(DISTINCT p.id) FILTER (WHERE pd.relationship='assembly_manual')::int AS manual_products,
         (SELECT count(*)::int FROM ingestion_jobs WHERE batch_id=$2) AS jobs
       FROM products p
       LEFT JOIN product_documents pd ON pd.product_id=p.id
       WHERE p.metadata->>'source'=$1`,
      [manifest.source, batchId],
    )).rows[0];
    if (
      stats.products !== manifest.productCount ||
      stats.ranks !== manifest.productCount ||
      stats.manual_products !== manifest.productsWithManuals ||
      stats.jobs !== manifest.productCount
    ) {
      throw new Error(`Metadata seed postcondition failed: ${JSON.stringify(stats)}`);
    }
    await client.query(
      `UPDATE ingestion_batches SET status='succeeded', completed_at=NOW(),
         metadata=metadata || $2::jsonb WHERE id=$1`,
      [
        batchId,
        JSON.stringify({
          products: manifest.productCount,
          products_with_manual_candidates: manifest.productsWithManuals,
          unique_manual_candidates: manifest.uniqueManualCount,
          manual_files: "background_sync_pending",
        }),
      ],
    );
    console.log(JSON.stringify({ status: "succeeded", products: 200, manualFiles: "pending" }));
  } catch (error) {
    if (batchId) {
      await client.query(
        "UPDATE ingestion_batches SET status='failed', completed_at=NOW(), metadata=metadata || $2::jsonb WHERE id=$1",
        [batchId, JSON.stringify({ error: (error as Error).message })],
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
