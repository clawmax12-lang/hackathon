import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const SOURCE = "ikea_se_best_sellers";
const DEFAULT_OUTPUT = "data/ikea-se-bestsellers-verified.json";

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

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; run through specific exec api");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function main(): Promise<void> {
  const output = path.resolve(process.argv[2] ?? DEFAULT_OUTPUT);
  const client = await connect();
  try {
    const result = await client.query<{
      ikea_item_number: string;
      name: string;
      normalized_name: string;
      category: string | null;
      description: string;
      market: string;
      language: string;
      product_url: string;
      popularity_rank: number;
      metadata: Record<string, unknown>;
      manuals: SeedManual[];
    }>(
      `SELECT p.ikea_item_number, p.name, p.normalized_name, p.category, p.description,
              p.market, p.language, p.product_url, p.popularity_rank, p.metadata,
              COALESCE(
                jsonb_agg(
                  DISTINCT jsonb_build_object(
                    'url', sd.canonical_url,
                    'checksumSha256', sd.checksum_sha256,
                    'byteSize', ma.byte_size,
                    'pageCount', sd.page_count
                  )
                ) FILTER (WHERE pd.relationship='assembly_manual'),
                '[]'::jsonb
              ) AS manuals
       FROM products p
       LEFT JOIN product_documents pd ON pd.product_id=p.id
       LEFT JOIN source_documents sd ON sd.id=pd.document_id
       LEFT JOIN media_assets ma ON ma.id=sd.asset_id
       WHERE p.metadata->>'source'=$1
       GROUP BY p.id, p.ikea_item_number, p.name, p.normalized_name, p.category,
                p.description, p.market, p.language, p.product_url, p.popularity_rank, p.metadata
       ORDER BY p.popularity_rank`,
      [SOURCE],
    );
    if (result.rows.length !== 200) throw new Error(`Expected 200 products, found ${result.rows.length}`);

    const products: SeedProduct[] = result.rows.map((row) => ({
      itemNumber: row.ikea_item_number,
      name: row.name,
      normalizedName: row.normalized_name,
      category: row.category,
      description: row.description,
      market: row.market,
      language: row.language,
      productUrl: row.product_url,
      popularityRank: row.popularity_rank,
      metadata: row.metadata,
      manuals: row.manuals.map((manual) => ({
        ...manual,
        byteSize: Number(manual.byteSize),
        pageCount: Number(manual.pageCount),
      })),
    }));
    const uniqueManuals = new Set(products.flatMap((product) => product.manuals.map((manual) => manual.url)));
    const manifest = {
      version: 1,
      source: SOURCE,
      sourceUrl: "https://www.ikea.com/se/sv/cat/best-sellers/",
      selection: "First 200 products in IKEA Sweden best-sellers page order",
      verification: "Official IKEA PDF downloaded; PDF magic, SHA-256, byte size, and page count verified",
      productCount: products.length,
      productsWithManuals: products.filter((product) => product.manuals.length > 0).length,
      uniqueManualCount: uniqueManuals.size,
      products,
    };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    console.log(JSON.stringify({ output, products: products.length, uniqueManuals: uniqueManuals.size }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
