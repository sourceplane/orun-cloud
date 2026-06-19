import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Coordination conformance suite (BM4/BM7 done-criterion). Drives the *real*
// RunCoordinator Durable Object through a complete diamond-DAG run lifecycle in
// the Workers runtime (miniflare): deps-gated exactly-one-winner claims, a
// memoized skip, complete-with-result, and the derived run terminal status. This
// is the acceptance gate the cutover depends on; the same scenarios should later
// run against the OSS plain-Postgres server (BM7) to prove the contract is
// implementable off-DO.

let mf: Miniflare;

beforeAll(async () => {
  const res = await build({
    entryPoints: [new URL("./coordinator-entry.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    conditions: ["workerd", "worker", "import", "default"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers"],
  });
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: res.outputFiles[0]!.text }],
    compatibilityDate: "2025-05-01",
    durableObjects: { COORDINATOR: "RunCoordinator" },
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
});

async function call(run: string, op: string, method: "GET" | "POST", body?: unknown) {
  const res = await mf.dispatchFetch(`http://x/runs/${run}${op}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// a → {b, c} → d (diamond): b and c both depend on a; d on both b and c.
const DIAMOND = { jobs: { a: { deps: [] as string[] }, b: { deps: ["a"] }, c: { deps: ["a"] }, d: { deps: ["b", "c"] } } };

async function phase(run: string, jobId: string): Promise<string> {
  const st = await call(run, "/state", "GET");
  return (st.json as { jobs: Record<string, { phase: string }> }).jobs[jobId]!.phase;
}
async function frontier(run: string): Promise<string[]> {
  const st = await call(run, "/state", "GET");
  return (st.json as { frontier: string[] }).frontier;
}

describe("coordination conformance — full diamond DAG on the real DO", () => {
  it("runs a→{b,c}→d end-to-end with deps gating and exactly-one-winner", async () => {
    const run = "conf-1";
    expect((await call(run, "/init", "POST", { runId: run, plan: DIAMOND, planDigest: "sha256:p", sourceHash: "sha256:s" })).status).toBe(200);

    // Only the root is runnable.
    expect(await frontier(run)).toEqual(["a"]);

    // Claim a; a competing runner loses (exactly-one-winner).
    const ca = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1" });
    expect(ca.json.claimed).toBe(true);
    expect((await call(run, "/claim", "POST", { jobId: "a", runnerId: "r2" })).json).toMatchObject({ claimed: false, reason: "job_held" });

    // Downstream is gated until a succeeds.
    expect((await call(run, "/claim", "POST", { jobId: "b", runnerId: "r1" })).json).toMatchObject({ claimed: false, reason: "deps_not_ready" });

    await call(run, "/complete", "POST", { jobId: "a", runnerId: "r1", leaseEpoch: ca.json.leaseEpoch, outcome: "succeeded", resultDigest: "sha256:ra" });
    expect(await phase(run, "a")).toBe("succeeded");
    expect(await frontier(run)).toEqual(["b", "c"]);

    // Fan out: b and c to different runners in parallel.
    const cb = await call(run, "/claim", "POST", { jobId: "b", runnerId: "r1" });
    const cc = await call(run, "/claim", "POST", { jobId: "c", runnerId: "r2" });
    expect(cb.json.claimed && cc.json.claimed).toBe(true);

    // d stays gated until BOTH b and c are done.
    await call(run, "/complete", "POST", { jobId: "b", runnerId: "r1", leaseEpoch: cb.json.leaseEpoch, outcome: "succeeded", resultDigest: "sha256:rb" });
    expect(await frontier(run)).toEqual([]); // c still running, d not ready
    await call(run, "/complete", "POST", { jobId: "c", runnerId: "r2", leaseEpoch: cc.json.leaseEpoch, outcome: "succeeded", resultDigest: "sha256:rc" });
    expect(await frontier(run)).toEqual(["d"]);

    // Join and finish.
    const cd = await call(run, "/claim", "POST", { jobId: "d", runnerId: "r1" });
    await call(run, "/complete", "POST", { jobId: "d", runnerId: "r1", leaseEpoch: cd.json.leaseEpoch, outcome: "succeeded", resultDigest: "sha256:rd" });

    const st = await call(run, "/state", "GET");
    expect((st.json as { phase: string }).phase).toBe("succeeded");
  });

  it("a memoized hit skips execution and unblocks downstream", async () => {
    const run = "conf-2";
    await call(run, "/init", "POST", { runId: run, plan: DIAMOND, planDigest: "sha256:p", sourceHash: "sha256:s" });
    // a is a memo hit (hermetic + precomputed digest): claim returns cached, no execution.
    const cached = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1", hermetic: true, memoResultDigest: "sha256:memo-a" });
    expect(cached.json).toMatchObject({ claimed: false, cached: true, result: { digest: "sha256:memo-a" } });
    expect(await phase(run, "a")).toBe("memoized");
    // memoized counts as satisfied — b and c unblock.
    expect(await frontier(run)).toEqual(["b", "c"]);
  });

  it("a failed job blocks its dependents and fails the run", async () => {
    const run = "conf-3";
    await call(run, "/init", "POST", { runId: run, plan: DIAMOND, planDigest: "sha256:p", sourceHash: "sha256:s" });
    const ca = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1" });
    await call(run, "/complete", "POST", { jobId: "a", runnerId: "r1", leaseEpoch: ca.json.leaseEpoch, outcome: "failed", errorText: "boom" });
    expect(await phase(run, "a")).toBe("failed");
    const st = await call(run, "/state", "GET");
    expect((st.json as { phase: string }).phase).toBe("failed");
    // b/c can never become ready (their dep failed).
    expect(await frontier(run)).toEqual([]);
  });
});
