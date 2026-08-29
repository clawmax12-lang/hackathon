import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const IMPORT_NAME = "IKEA Sweden Best Sellers Top 200 — Firecrawl 2026-08-29";
const SOURCE = "ikea_se_best_sellers";
const STORAGE_DIR = path.resolve(
  process.env.STORAGE_DIR ?? ".specific/keys/default/data/volumes/api/storage",
);

interface AssetRow {
  id: string;
  kind: "manual_pdf" | "source_snapshot";
  storage_key: string | null;
  byte_size: string | null;
  checksum_sha256: string | null;
  mime_type: string | null;
  source_url: string | null;
  page_count: number | null;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; run through specific exec api");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function main(): Promise<void> {
  const client = await connect();
  const failures: string[] = [];
  try {
    const batchResult = await client.query<{
      id: string;
      status: string;
      expected_items: number;
    }>(
      "SELECT id, status::text, expected_items FROM ingestion_batches WHERE name=$1 ORDER BY created_at DESC LIMIT 1",
      [IMPORT_NAME],
    );
    const batch = batchResult.rows[0];
    if (!batch) throw new Error(`Missing ingestion batch: ${IMPORT_NAME}`);
    if (batch.status !== "succeeded") failures.push(`batch status is ${batch.status}`);
    if (batch.expected_items !== 200) failures.push(`batch expected_items is ${batch.expected_items}`);

    const productStats = (await client.query<{
      products: number;
      ranks: number;
      min_rank: number;
      max_rank: number;
      ready: number;
      queued: number;
    }>(
      `SELECT count(*)::int AS products,
              count(DISTINCT popularity_rank)::int AS ranks,
              min(popularity_rank)::int AS min_rank,
              max(popularity_rank)::int AS max_rank,
              count(*) FILTER (WHERE status='ready')::int AS ready,
              count(*) FILTER (WHERE status='queued')::int AS queued
       FROM products WHERE metadata->>'source'=$1`,
      [SOURCE],
    )).rows[0];
    if (productStats.products !== 200) failures.push(`product count is ${productStats.products}`);
    if (productStats.ranks !== 200 || productStats.min_rank !== 1 || productStats.max_rank !== 200) {
      failures.push(
        `rank coverage is distinct=${productStats.ranks}, min=${productStats.min_rank}, max=${productStats.max_rank}`,
      );
    }

    const relationshipStats = (await client.query<{
      products_with_manuals: number;
      manual_links: number;
      unique_manuals: number;
      snapshot_products: number;
    }>(
      `SELECT
         count(DISTINCT p.id) FILTER (WHERE pd.relationship='assembly_manual')::int AS products_with_manuals,
         count(*) FILTER (WHERE pd.relationship='assembly_manual')::int AS manual_links,
         count(DISTINCT pd.document_id) FILTER (WHERE pd.relationship='assembly_manual')::int AS unique_manuals,
         count(DISTINCT p.id) FILTER (WHERE pd.relationship='product_page')::int AS snapshot_products
       FROM products p
       LEFT JOIN product_documents pd ON pd.product_id=p.id
       WHERE p.metadata->>'source'=$1`,
      [SOURCE],
    )).rows[0];

    const stateMismatches = (await client.query<{ ready_without_manual: number; queued_with_manual: number }>(
      `SELECT
         count(*) FILTER (
           WHERE p.status='ready' AND NOT EXISTS (
             SELECT 1 FROM product_documents pd WHERE pd.product_id=p.id AND pd.relationship='assembly_manual'
           )
         )::int AS ready_without_manual,
         count(*) FILTER (
           WHERE p.status='queued' AND EXISTS (
             SELECT 1 FROM product_documents pd WHERE pd.product_id=p.id AND pd.relationship='assembly_manual'
           )
         )::int AS queued_with_manual
       FROM products p WHERE p.metadata->>'source'=$1`,
      [SOURCE],
    )).rows[0];
    if (relationshipStats.snapshot_products !== 200) {
      failures.push(`products with Firecrawl snapshot is ${relationshipStats.snapshot_products}`);
    }
    if (stateMismatches.ready_without_manual > 0) {
      failures.push(`${stateMismatches.ready_without_manual} ready products have no verified manual`);
    }
    if (stateMismatches.queued_with_manual > 0) {
      failures.push(`${stateMismatches.queued_with_manual} queued products have a verified manual`);
    }

    const jobStats = (await client.query<{ jobs: number; succeeded: number; failed: number }>(
      `SELECT count(*)::int AS jobs,
              count(*) FILTER (WHERE status='succeeded')::int AS succeeded,
              count(*) FILTER (WHERE status='failed')::int AS failed
       FROM ingestion_jobs WHERE batch_id=$1`,
      [batch.id],
    )).rows[0];
    if (jobStats.jobs !== 200 || jobStats.succeeded !== 200 || jobStats.failed !== 0) {
      failures.push(
        `jobs are total=${jobStats.jobs}, succeeded=${jobStats.succeeded}, failed=${jobStats.failed}`,
      );
    }

    const assets = (await client.query<AssetRow>(
      `SELECT DISTINCT ma.id, ma.kind::text, ma.storage_key, ma.byte_size::text,
              ma.checksum_sha256, ma.mime_type, ma.source_url, sd.page_count
       FROM products p
       JOIN product_documents pd ON pd.product_id=p.id
       JOIN source_documents sd ON sd.id=pd.document_id
       JOIN media_assets ma ON ma.id=sd.asset_id
       WHERE p.metadata->>'source'=$1
         AND pd.relationship IN ('product_page', 'assembly_manual')`,
      [SOURCE],
    )).rows;

    for (const asset of assets) {
      if (!asset.storage_key || !asset.byte_size || !asset.checksum_sha256 || !asset.source_url) {
        failures.push(`asset ${asset.id} is missing required metadata`);
        continue;
      }
      const absolutePath = path.join(STORAGE_DIR, asset.storage_key);
      let data: Buffer;
      try {
        data = await fs.readFile(absolutePath);
      } catch {
        failures.push(`asset file is missing: ${asset.storage_key}`);
        continue;
      }
      if (data.length !== Number(asset.byte_size)) failures.push(`byte size mismatch: ${asset.storage_key}`);
      if (sha256(data) !== asset.checksum_sha256) failures.push(`checksum mismatch: ${asset.storage_key}`);

      const url = new URL(asset.source_url);
      if (url.hostname !== "www.ikea.com") failures.push(`non-IKEA asset URL: ${asset.source_url}`);
      if (asset.kind === "manual_pdf") {
        if (asset.mime_type !== "application/pdf") failures.push(`manual MIME mismatch: ${asset.id}`);
        if (data.subarray(0, 5).toString("latin1") !== "%PDF-") failures.push(`PDF magic mismatch: ${asset.id}`);
        if (!url.pathname.includes("/assembly_instructions/") || !url.pathname.endsWith(".pdf")) {
          failures.push(`invalid assembly-manual URL: ${asset.source_url}`);
        }
        if (!asset.page_count || asset.page_count <= 0) failures.push(`invalid page count: ${asset.id}`);
      }
    }

    const summary = {
      batch: { id: batch.id, status: batch.status, expectedItems: batch.expected_items },
      products: productStats,
      documents: relationshipStats,
      jobs: jobStats,
      verifiedAssetFiles: assets.length,
      failures,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
