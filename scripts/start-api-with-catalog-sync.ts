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

const api = start(["server/src/index.ts"]);
api.once("spawn", () => {
  const sync = start(["scripts/import-ikea-cloud-seed.ts"]);
  sync.once("exit", (code) => {
    if (code === 0) console.log("[catalog-sync] verified IKEA manual sync complete");
    else console.error(`[catalog-sync] sync exited with code ${code ?? "unknown"}; it will retry on restart`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

api.once("exit", (code, signal) => {
  for (const child of children) child.kill("SIGTERM");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
