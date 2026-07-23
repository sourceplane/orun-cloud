// IC9 orchestrator: build the console (plain `next build` — the perf suite
// drives `next start`, not the OpenNext worker), boot it on a private port,
// run the budget suite, tear down. Exit code = budget verdict.
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const consoleDir = resolve(here, "../../../apps/web-console-next");
const PORT = process.env.PERF_PORT ?? "3101";
const BASE = `http://localhost:${PORT}`;

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 1) Browser + console build (skippable locally: PERF_SKIP_BUILD=1 reuses .next).
sh("pnpm exec playwright install chromium", resolve(here, ".."));
if (!process.env.PERF_SKIP_BUILD) {
  sh("pnpm exec next build", consoleDir);
}

// 2) Serve.
const server = spawn("pnpm", ["exec", "next", "start", "-p", PORT], {
  cwd: consoleDir,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(d));
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    const res = await fetch(BASE);
    up = res.status < 500;
  } catch {
    await sleep(1000);
  }
}
if (!up) {
  server.kill("SIGKILL");
  console.error("perf-budgets: console server failed to start");
  process.exit(1);
}

// 3) Budgets.
let code = 0;
try {
  const { runBudgets } = await import("./budgets.mjs");
  code = await runBudgets(BASE);
} catch (err) {
  console.error("perf-budgets: suite crashed:", err);
  code = 1;
} finally {
  server.kill("SIGKILL");
}
process.exit(code);
