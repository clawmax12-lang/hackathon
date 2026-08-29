import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import pLimit from "p-limit";

const exec = promisify(execFile);
const MCP_URL = "https://mcp.firecrawl.dev/v2/mcp-oauth";

interface RankedProduct {
  url: string;
}

interface FirecrawlLinks {
  links?: string[];
  metadata?: {
    sourceURL?: string;
    statusCode?: number;
    scrapeId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function articleFromUrl(url: string): string {
  const article = new URL(url).pathname.match(/-(s?\d{8})\/?$/i)?.[1];
  if (!article) throw new Error(`No article number in ${url}`);
  return article.toLowerCase();
}

function outputName(urlValue: string): string {
  const url = new URL(urlValue);
  return [url.hostname.replace(/^www\./, ""), ...url.pathname.split("/").filter(Boolean)]
    .join("-")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .toLowerCase() + ".json";
}

async function hasSnapshot(snapshotDir: string, article: string): Promise<boolean> {
  const names = await fs.readdir(snapshotDir);
  return names.some((name) => {
    const lower = name.toLowerCase();
    return lower.endsWith(`-${article}.md`) || lower.endsWith(`-${article}.json`);
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const processError = error as Error & { stdout?: string; stderr?: string };
  return [error.message, processError.stdout, processError.stderr].filter(Boolean).join("\n");
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function scrape(url: string): Promise<FirecrawlLinks> {
  const toolArgs = JSON.stringify({
    url,
    formats: ["links"],
    onlyMainContent: true,
    location: { country: "SE", languages: ["sv"] },
  });
  const { stdout } = await exec(
    "npx",
    [
      "-y",
      "@modelcontextprotocol/inspector@latest",
      "--cli",
      "--transport",
      "http",
      "--server-url",
      MCP_URL,
      "--use-stored-auth",
      "--stored-auth-only",
      "--method",
      "tools/call",
      "--tool-name",
      "firecrawl_scrape",
      "--tool-args-json",
      toolArgs,
      "--format",
      "json",
    ],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const envelope = JSON.parse(stdout) as {
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (envelope.error?.message) throw new Error(envelope.error.message);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Firecrawl MCP returned no text result");
  const parsed = JSON.parse(text) as FirecrawlLinks;
  if (envelope.result?.isError || (parsed as { error?: string }).error) {
    throw new Error((parsed as { error?: string }).error ?? text);
  }
  if (parsed.metadata?.sourceURL !== url) {
    throw new Error(`Firecrawl source URL mismatch: ${parsed.metadata?.sourceURL ?? "missing"}`);
  }
  if (parsed.metadata?.statusCode !== 200) {
    throw new Error(`Firecrawl HTTP status ${parsed.metadata?.statusCode ?? "missing"}`);
  }
  return {
    sourceURL: url,
    scrapeId: parsed.metadata.scrapeId,
    statusCode: parsed.metadata.statusCode,
    ...parsed,
  };
}

async function scrapeWithRetry(url: string): Promise<FirecrawlLinks> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await scrape(url);
    } catch (error) {
      lastError = errorText(error);
      if (/auth_required|no_stored_token|unauthorized|401/i.test(lastError)) throw error;
      if (attempt === 6) break;
      const delay = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      console.log(`FIRECRAWL_RETRY attempt=${attempt} delay_ms=${delay} url=${url}`);
      await sleep(delay);
    }
  }
  throw new Error(lastError);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      candidates: { type: "string" },
      snapshots: { type: "string" },
      concurrency: { type: "string", default: "4" },
    },
  });
  const candidateFile = path.resolve(
    values.candidates ?? ".context/ikea-best-sellers-products-firecrawl.json",
  );
  const snapshotDir = path.resolve(
    values.snapshots ?? ".context/firecrawl-products/.firecrawl",
  );
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error("concurrency must be 1..5");
  }

  const wrapper = JSON.parse(await fs.readFile(candidateFile, "utf8")) as { result: string };
  const ranked = JSON.parse(wrapper.result) as { products: RankedProduct[] };
  const products = ranked.products.slice(0, 200);
  const missing: RankedProduct[] = [];
  for (const product of products) {
    if (!(await hasSnapshot(snapshotDir, articleFromUrl(product.url)))) missing.push(product);
  }
  console.log(`FIRECRAWL_MCP_START missing=${missing.length} concurrency=${concurrency}`);

  const limiter = pLimit(concurrency);
  let succeeded = 0;
  const failures: { url: string; error: string }[] = [];
  await Promise.all(
    missing.map((product) =>
      limiter(async () => {
        try {
          const result = await scrapeWithRetry(product.url);
          await fs.writeFile(
            path.join(snapshotDir, outputName(product.url)),
            JSON.stringify(result, null, 2) + "\n",
            { mode: 0o600 },
          );
          succeeded += 1;
          console.log(`FIRECRAWL_MCP_PROGRESS ${succeeded + failures.length}/${missing.length}`);
        } catch (error) {
          failures.push({ url: product.url, error: errorText(error) });
          console.error(`FIRECRAWL_MCP_FAILED url=${product.url}`);
        }
      }),
    ),
  );
  const summary = { requested: missing.length, succeeded, failed: failures.length, failures };
  console.log(JSON.stringify(summary));
  if (failures.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
