import { spawn, type ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();

function start(args: string[]): ChildProcess {
  const child = spawn("npx", ["tsx", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

function waitFor(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function seedCatalog(): Promise<void> {
  const seedCode = await waitFor(start(["scripts/seed-ikea-cloud-metadata.ts"]));
  if (seedCode !== 0) {
    console.error(`[catalog-seed] metadata seed failed with code ${seedCode ?? "unknown"}`);
    return;
  }

  console.log("[catalog-seed] 200-product metadata seed complete; seeding hero");
  const heroCode = await waitFor(start(["scripts/seed-hero-product.ts"]));
  if (heroCode !== 0) {
    console.error(`[hero-seed] failed with code ${heroCode ?? "unknown"}; API remains available`);
    return;
  }

  console.log("[hero-seed] TRANERED manual cache ready; seeding hand-reviewed guide");
  const guideCode = await waitFor(start(["scripts/seed-hero-guide.ts"]));
  if (guideCode !== 0) {
    console.error(`[hero-guide] failed with code ${guideCode ?? "unknown"}; API remains available`);
    return;
  }

  console.log("[hero-guide] TRANERED guide ready; hydrating verified catalog");
  const syncCode = await waitFor(start(["scripts/import-ikea-cloud-seed.ts"]));
  if (syncCode === 0) console.log("[catalog-sync] verified IKEA manual sync complete");
  else console.error(`[catalog-sync] sync exited with code ${syncCode ?? "unknown"}; it will retry on restart`);
}

// Health checks must not wait for PDF rendering or external providers. The API
// becomes available first; deterministic seed work then proceeds in-process.
const api = start(["server/src/index.ts"]);
api.once("spawn", () => void seedCatalog().catch((error) => console.error("[catalog-seed] unexpected failure; API remains available", error)));
api.once("exit", (code, signal) => {
  for (const child of children) child.kill("SIGTERM");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
