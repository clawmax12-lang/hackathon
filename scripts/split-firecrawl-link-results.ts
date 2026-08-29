import fs from "node:fs/promises";
import path from "node:path";

interface ScrapeResult {
  sourceURL: string;
  links?: string[];
  metadata?: Record<string, unknown>;
  scrapeId?: string;
  statusCode?: number;
  error?: string;
}

function outputName(sourceURL: string): string {
  const url = new URL(sourceURL);
  const slug = [url.hostname.replace(/^www\./, ""), ...url.pathname.split("/").filter(Boolean)]
    .join("-")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .toLowerCase();
  return `${slug}.json`;
}

async function main(): Promise<void> {
  const [input, outputDirectory] = process.argv.slice(2);
  if (!input || !outputDirectory) {
    throw new Error("Usage: tsx scripts/split-firecrawl-link-results.ts INPUT.json OUTPUT_DIR");
  }
  const parsed = JSON.parse(await fs.readFile(input, "utf8")) as {
    results?: ScrapeResult[];
  };
  if (!Array.isArray(parsed.results)) throw new Error("Input does not contain a results array");
  await fs.mkdir(outputDirectory, { recursive: true });
  let written = 0;
  for (const result of parsed.results) {
    if (!result.sourceURL || result.error || result.statusCode !== 200) continue;
    const filename = path.join(outputDirectory, outputName(result.sourceURL));
    await fs.writeFile(filename, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    written += 1;
  }
  console.log(JSON.stringify({ requested: parsed.results.length, written }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
