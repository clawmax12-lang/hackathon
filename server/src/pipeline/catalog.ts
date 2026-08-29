import { digitsOnly, maybeOne, normalizeText, one, query } from "../db.js";

export interface CatalogCandidate {
  product_id: string;
  name: string;
  item_number: string;
  category: string | null;
  product_url: string | null;
  score: number;
  manual: {
    document_id: string;
    canonical_url: string;
    verified: boolean;
    page_count: number | null;
  } | null;
}

/** Latest linked manual for a product; verified = the PDF bytes are actually on disk in storage. */
async function manualFor(productId: string): Promise<CatalogCandidate["manual"]> {
  return (
    (await maybeOne<NonNullable<CatalogCandidate["manual"]>>(
      `SELECT sd.id AS document_id, sd.canonical_url,
              (ma.storage_key IS NOT NULL AND ma.storage_key <> '') AS verified,
              sd.page_count
         FROM product_documents pd
         JOIN source_documents sd ON sd.id = pd.document_id
         LEFT JOIN media_assets ma ON ma.id = sd.asset_id
        WHERE pd.product_id = $1 AND sd.kind = 'manual'
        ORDER BY (ma.storage_key IS NOT NULL AND ma.storage_key <> '') DESC, sd.updated_at DESC
        LIMIT 1`,
      [productId],
    )) ?? null
  );
}

export async function lookupCatalog(input: {
  name_query: string | null;
  item_numbers: string[];
  variant: string | null;
}): Promise<{ candidates: CatalogCandidate[] }> {
  const seen = new Map<string, CatalogCandidate>();

  const add = async (rows: { id: string; name: string; ikea_item_number: string; category: string | null; product_url: string | null }[], score: number) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.set(r.id, {
        product_id: r.id,
        name: r.name,
        item_number: r.ikea_item_number,
        category: r.category,
        product_url: r.product_url,
        score,
        manual: await manualFor(r.id),
      });
    }
  };

  // 1. exact item number (raw + digits-only, matched against digits of stored values)
  for (const raw of input.item_numbers) {
    const digits = digitsOnly(raw);
    if (digits.length < 6) continue;
    await add(
      await query(
        `SELECT id, name, ikea_item_number, category, product_url FROM products
          WHERE regexp_replace(ikea_item_number, '\\D', '', 'g') = $1
          UNION
         SELECT p.id, p.name, p.ikea_item_number, p.category, p.product_url
           FROM product_aliases a JOIN products p ON p.id = a.product_id
          WHERE regexp_replace(a.normalized_alias, '\\D', '', 'g') = $1 AND a.alias_kind = 'item_number'
          LIMIT 5`,
        [digits],
      ),
      0.98,
    );
  }

  // 2. alias / fuzzy name via pg_trgm
  if (input.name_query) {
    const norm = normalizeText([input.name_query, input.variant ?? ""].join(" "));
    if (norm) {
      const rows = await query<{
        id: string;
        name: string;
        ikea_item_number: string;
        category: string | null;
        product_url: string | null;
        sim: number;
      }>(
        `SELECT id, name, ikea_item_number, category, product_url,
                similarity(normalized_name, $1) AS sim
           FROM products
          WHERE similarity(normalized_name, $1) > 0.18 OR normalized_name ILIKE '%' || $2 || '%'
          ORDER BY sim DESC LIMIT 6`,
        [norm, norm.split(" ")[0] ?? norm],
      );
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.set(r.id, {
            product_id: r.id,
            name: r.name,
            item_number: r.ikea_item_number,
            category: r.category,
            product_url: r.product_url,
            score: Math.min(0.92, Math.max(0.3, r.sim)),
            manual: await manualFor(r.id),
          });
        }
      }
    }
  }

  const candidates = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  return { candidates };
}

/** Fallback-scrape writes; converges with the catalog seeder via upsert on ikea_item_number. */
export async function registerProductFromWeb(input: {
  name: string;
  item_number: string;
  product_url: string;
  category: string | null;
  description: string | null;
}): Promise<{ product_id: string }> {
  const row = await one<{ id: string }>(
    `INSERT INTO products (ikea_item_number, name, normalized_name, category, description, market, language, product_url, status, metadata)
     VALUES ($1, $2, $3, $4, $5, 'SE', 'sv', $6, 'ready', '{"source":"fallback_scrape"}')
     ON CONFLICT (ikea_item_number) DO UPDATE
       SET product_url = EXCLUDED.product_url,
           status = 'ready',
           updated_at = now()
     RETURNING id`,
    [digitsOnly(input.item_number) || input.item_number, input.name, normalizeText(input.name), input.category, input.description, input.product_url],
  );
  await query(
    `INSERT INTO product_aliases (product_id, alias, normalized_alias, alias_kind, locale)
     VALUES ($1, $2, $3, 'product_name', 'sv')
     ON CONFLICT (product_id, normalized_alias) DO NOTHING`,
    [row.id, input.name, normalizeText(input.name)],
  );
  return { product_id: row.id };
}

export async function getProduct(productId: string) {
  return maybeOne<{ id: string; name: string; ikea_item_number: string; category: string | null; product_url: string | null }>(
    "SELECT id, name, ikea_item_number, category, product_url FROM products WHERE id = $1",
    [productId],
  );
}
