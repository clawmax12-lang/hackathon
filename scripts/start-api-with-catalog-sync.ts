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

const metadataSeed = start(["scripts/seed-ikea-cloud-metadata.ts"]);
metadataSeed.once("exit", (seedCode) => {
  if (seedCode !== 0) {
    console.error(`[catalog-seed] metadata seed failed with code ${seedCode ?? "unknown"}`);
    process.exit(seedCode ?? 1);
    return;
  }

  console.log("[catalog-seed] 200-product metadata seed complete; seeding hero");
  const heroSeed = start(["scripts/seed-hero-product.ts"]);
  heroSeed.once("exit", (heroCode) => {
    if (heroCode !== 0) {
      console.error(`[hero-seed] failed with code ${heroCode ?? "unknown"}`);
      process.exit(heroCode ?? 1);
      return;
    }
    console.log("[hero-seed] TRANERED manual cache ready; seeding hand-reviewed guide");
    const heroGuide = start(["scripts/seed-hero-guide.ts"]);
    heroGuide.once("exit", (guideCode) => {
      if (guideCode !== 0) {
        console.error(`[hero-guide] failed with code ${guideCode ?? "unknown"}`);
        process.exit(guideCode ?? 1);
        return;
      }
      console.log("[hero-guide] TRANERED guide ready; starting API");
      const api = start(["server/src/index.ts"]);
      api.once("spawn", () => {
        const sync = start(["scripts/import-ikea-cloud-seed.ts"]);
        sync.once("exit", (code) => {
          if (code === 0) console.log("[catalog-sync] verified IKEA manual sync complete");
          else console.error(`[catalog-sync] sync exited with code ${code ?? "unknown"}; it will retry on restart`);
        });
      });
      api.once("exit", (code, signal) => {
        for (const child of children) child.kill("SIGTERM");
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 1);
      });
    });
  });
});
