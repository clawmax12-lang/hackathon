import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../env.js";
import { maybeOne, one, query } from "../db.js";
import { pathFor, putFile, sha256, storeAsset } from "../storage.js";

const exec = promisify(execFile);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TRANERED_PITCH = {
  articleNumber: "10609002",
  manualUrl: "https://www.ikea.com/es/es/assembly_instructions/tranered-bandeja-reposabrazos-marron-oscuro__AA-2613017-4-2.pdf",
  productUrl: "https://www.ikea.com/es/es/p/tranered-bandeja-reposabrazos-marron-oscuro-10609002/",
} as const;

export interface DiscoveryResult {
  manual_urls: { url: string; label: string }[];
  product_url: string | null;
  product_image_url: string | null;
  product_name: string | null;
  item_number: string | null;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** Plain-fetch discovery: IKEA search API -> product page -> assembly_instructions links. */
async function discoverPlainFetch(productName: string, itemNumber: string | null): Promise<DiscoveryResult> {
  const q = encodeURIComponent(itemNumber ?? productName);
  const searchUrl = `https://sik.search.blue.cdtapps.com/${config.market}/${config.language}/search-result-page?types=PRODUCT&q=${q}`;
  const search = JSON.parse(await fetchText(searchUrl));
  const items: { product: { name: string; typeName?: string; itemNo: string; pipUrl: string } }[] =
    search?.searchResultPage?.products?.main?.items ?? [];
  if (items.length === 0) return { manual_urls: [], product_url: null, product_image_url: null, product_name: null, item_number: null };

  // Prefer exact item-number match, else first hit.
  const digits = (itemNumber ?? "").replace(/\D/g, "");
  const hit =
    items.find((i) => digits && i.product.itemNo.replace(/\D/g, "") === digits)?.product ?? items[0].product;

  const html = await fetchText(hit.pipUrl);
  const pdfs = [...new Set(html.match(/https:\/\/www\.ikea\.com\/[^"'\s]*assembly_instructions\/[^"'\s]*\.pdf/g) ?? [])];
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
  return {
    manual_urls: pdfs.map((url) => ({ url, label: path.basename(url) })),
    product_url: hit.pipUrl,
    product_image_url: og,
    product_name: [hit.name, hit.typeName].filter(Boolean).join(" "),
    item_number: hit.itemNo,
  };
}

/** Firecrawl-backed discovery once FIRECRAWL_API_KEY exists; same shape. */
async function discoverFirecrawl(productName: string, itemNumber: string | null): Promise<DiscoveryResult> {
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.firecrawlApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `site:ikea.com/${config.market}/ ${productName} ${itemNumber ?? ""}`.trim(),
      limit: 3,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`firecrawl search -> ${res.status}`);
  const data = (await res.json()) as { data?: { web?: { url?: string }[] } & { url?: string }[] };
  const first = data?.data?.web?.[0]?.url ?? (data?.data as { url?: string }[] | undefined)?.[0]?.url;
  if (!first) return { manual_urls: [], product_url: null, product_image_url: null, product_name: null, item_number: null };
  const html = await fetchText(first);
  const pdfs = [...new Set(html.match(/https:\/\/www\.ikea\.com\/[^"'\s]*assembly_instructions\/[^"'\s]*\.pdf/g) ?? [])];
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
  return {
    manual_urls: pdfs.map((url) => ({ url, label: path.basename(url) })),
    product_url: first,
    product_image_url: og,
    product_name: productName,
    item_number: itemNumber,
  };
}

export async function discoverManual(productName: string, itemNumber: string | null): Promise<DiscoveryResult> {
  // Pitch-critical golden path: never depend on search results or scrape the
  // product page when the label already gives us TRANERED's exact article no.
  if ((itemNumber ?? "").replace(/\D/g, "") === TRANERED_PITCH.articleNumber) {
    return {
      manual_urls: [{ url: TRANERED_PITCH.manualUrl, label: "TRANERED assembly manual · 8 pages" }],
      product_url: TRANERED_PITCH.productUrl,
      product_image_url: null,
      product_name: "TRANERED armstödsbricka",
      item_number: TRANERED_PITCH.articleNumber,
    };
  }
  if (config.firecrawlApiKey) {
    try {
      const r = await discoverFirecrawl(productName, itemNumber);
      if (r.manual_urls.length > 0) return r;
    } catch {
      /* fall through to plain fetch */
    }
  }
  return discoverPlainFetch(productName, itemNumber);
}

export interface VerifiedManual {
  document_id: string;
  page_count: number;
  ok: boolean;
  failure_reason: string | null;
}

async function downloadPdf(url: string): Promise<Buffer> {
  if (url.startsWith("file://")) {
    return fs.readFile(url.slice("file://".length));
  }
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(40000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Render manual pages to PNG at two resolutions; returns page count rendered. */
export async function renderManualPages(documentId: string, pdfStorageKey: string): Promise<number> {
  const pdfPath = pathFor(pdfStorageKey);
  for (const [variant, dpi] of [
    ["video", "200"],
    ["vision", "110"],
  ] as const) {
    const outDir = pathFor(`pages/${documentId}/${variant}`);
    await fs.mkdir(outDir, { recursive: true });
    await exec("pdftoppm", ["-png", "-r", dpi, pdfPath, path.join(outDir, "p")], { timeout: 120000 });
  }
  const files = await fs.readdir(pathFor(`pages/${documentId}/video`));
  return files.filter((f) => f.endsWith(".png")).length;
}

export async function listPageFiles(documentId: string, variant: "video" | "vision"): Promise<string[]> {
  const dir = pathFor(`pages/${documentId}/${variant}`);
  const files = await fs.readdir(dir);
  return files
    .filter((f) => f.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(dir, f));
}

/**
 * Download, verify (%PDF magic + pdfinfo page count), checksum, store, and
 * upsert source_documents/product_documents — repairing any fabricated
 * seed rows via ON CONFLICT (canonical_url).
 */
export async function fetchAndVerifyManualPdf(url: string, productId: string): Promise<VerifiedManual> {
  let data: Buffer;
  try {
    data = await downloadPdf(url);
  } catch (err) {
    return { document_id: "", page_count: 0, ok: false, failure_reason: `download failed: ${(err as Error).message}` };
  }
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { document_id: "", page_count: 0, ok: false, failure_reason: "not a PDF (magic bytes mismatch)" };
  }

  const checksum = sha256(data);
  const storageKey = `manuals/${checksum}.pdf`;
  await putFile(storageKey, data);

  let pageCount = 0;
  try {
    const { stdout } = await exec("pdfinfo", [pathFor(storageKey)], { timeout: 30000 });
    pageCount = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
  } catch {
    return { document_id: "", page_count: 0, ok: false, failure_reason: "pdfinfo could not parse the file" };
  }
  if (pageCount < 1) return { document_id: "", page_count: 0, ok: false, failure_reason: "PDF has no pages" };

  const assetId = await storeAsset({
    kind: "manual_pdf",
    storageKey,
    data,
    sourceUrl: url.startsWith("file://") ? null : url,
  });

  const canonical = url.startsWith("file://") ? `local://sample/${checksum}` : url;
  const doc = await one<{ id: string }>(
    `INSERT INTO source_documents (kind, status, canonical_url, asset_id, title, locale, provider, checksum_sha256, page_count, fetched_at, last_verified_at)
     VALUES ('manual', 'ready', $1, $2, $3, $4, 'monterra', $5, $6, now(), now())
     ON CONFLICT (canonical_url) DO UPDATE
       SET status = 'ready', asset_id = EXCLUDED.asset_id, checksum_sha256 = EXCLUDED.checksum_sha256,
           page_count = EXCLUDED.page_count, fetched_at = now(), last_verified_at = now(), updated_at = now()
     RETURNING id`,
    [canonical, assetId, path.basename(url), config.language, checksum, pageCount],
  );

  await query(
    `INSERT INTO product_documents (product_id, document_id, relationship)
     VALUES ($1, $2, 'assembly_manual')
     ON CONFLICT DO NOTHING`,
    [productId, doc.id],
  );

  await renderManualPages(doc.id, storageKey);
  return { document_id: doc.id, page_count: pageCount, ok: true, failure_reason: null };
}

export async function getManualDocument(documentId: string) {
  return maybeOne<{ id: string; canonical_url: string; page_count: number | null; storage_key: string | null; checksum_sha256: string | null }>(
    `SELECT sd.id, sd.canonical_url, sd.page_count, ma.storage_key, sd.checksum_sha256
       FROM source_documents sd LEFT JOIN media_assets ma ON ma.id = sd.asset_id
      WHERE sd.id = $1`,
    [documentId],
  );
}
