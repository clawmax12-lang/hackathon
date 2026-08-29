import fs from "node:fs/promises";
import path from "node:path";
import { maybeOne, query } from "../server/src/db.js";
import { registerProductFromWeb } from "../server/src/pipeline/catalog.js";
import { fetchAndVerifyManualPdf } from "../server/src/pipeline/manual.js";
import { config } from "../server/src/env.js";

const HERO = {
  manufacturer: "IKEA",
  name: "TRANERED",
  variant: "armstödsbricka, mörkbrun",
  articleNumber: "10609002",
  productUrl: "https://www.ikea.com/es/es/p/tranered-bandeja-reposabrazos-marron-oscuro-10609002/",
  manualUrl: "https://www.ikea.com/es/es/assembly_instructions/tranered-bandeja-reposabrazos-marron-oscuro__AA-2613017-4-2.pdf",
  expectedPages: 8,
  expectedChecksum: "d70d40e98bfe20301e11de36a49d49566fd41abd2b209b88a79c7f730eb1289c",
};

async function pagesAreCached(documentId: string): Promise<boolean> {
  for (const variant of ["vision", "video"] as const) {
    try {
      const files = await fs.readdir(path.join(config.storageDir, "pages", documentId, variant));
      if (files.filter((file) => file.endsWith(".png")).length !== HERO.expectedPages) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  const { product_id: productId } = await registerProductFromWeb({
    name: HERO.name,
    item_number: HERO.articleNumber,
    product_url: HERO.productUrl,
    category: "Armstödsbricka",
    description: `${HERO.name}, ${HERO.variant}`,
  });

  await query(
    `UPDATE products
        SET normalized_name='tranered armstodsbricka morkbrun',
            description=$2,
            manufacturer=$4,
            variant=$5,
            article_no=$6,
            metadata=metadata || $3::jsonb,
            updated_at=NOW()
      WHERE id=$1`,
    [
      productId,
      `${HERO.name}, ${HERO.variant}`,
      JSON.stringify({
        source: "hero_golden_test",
        manufacturer: HERO.manufacturer,
        variant: HERO.variant,
        article_number_display: "106.090.02",
        golden_test: true,
      }),
      HERO.manufacturer,
      HERO.variant,
      HERO.articleNumber,
    ],
  );

  for (const [alias, normalized, kind] of [
    ["TRANERED armstödsbricka mörkbrun", "tranered armstodsbricka morkbrun", "full_name"],
    ["106.090.02", HERO.articleNumber, "item_number"],
  ] as const) {
    await query(
      `INSERT INTO product_aliases (product_id,alias,normalized_alias,alias_kind,locale)
       VALUES ($1,$2,$3,$4,'sv')
       ON CONFLICT (product_id,normalized_alias) DO UPDATE SET alias=EXCLUDED.alias, alias_kind=EXCLUDED.alias_kind`,
      [productId, alias, normalized, kind],
    );
  }

  const cached = await maybeOne<{ document_id: string; checksum_sha256: string | null; page_count: number | null }>(
    `SELECT sd.id AS document_id, sd.checksum_sha256, sd.page_count
       FROM product_documents pd
       JOIN source_documents sd ON sd.id=pd.document_id
       JOIN media_assets ma ON ma.id=sd.asset_id
      WHERE pd.product_id=$1 AND sd.kind='manual' AND sd.canonical_url=$2 AND ma.storage_key IS NOT NULL
      LIMIT 1`,
    [productId, HERO.manualUrl],
  );

  if (
    cached?.checksum_sha256 === HERO.expectedChecksum &&
    cached.page_count === HERO.expectedPages &&
    await pagesAreCached(cached.document_id)
  ) {
    console.log(JSON.stringify({ hero: HERO.name, articleNumber: HERO.articleNumber, pageCount: cached.page_count, cache: "ready" }));
    return;
  }

  const manual = await fetchAndVerifyManualPdf(HERO.manualUrl, productId);
  if (!manual.ok || manual.page_count !== HERO.expectedPages) {
    throw new Error(`Hero manual verification failed: ${JSON.stringify(manual)}`);
  }
  const verified = await maybeOne<{ checksum_sha256: string | null }>(
    "SELECT checksum_sha256 FROM source_documents WHERE id=$1",
    [manual.document_id],
  );
  if (verified?.checksum_sha256 !== HERO.expectedChecksum) {
    throw new Error(`Hero manual checksum changed: ${verified?.checksum_sha256 ?? "missing"}`);
  }
  console.log(JSON.stringify({ hero: HERO.name, articleNumber: HERO.articleNumber, pageCount: manual.page_count, cache: "seeded" }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
