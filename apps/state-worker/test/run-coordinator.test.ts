import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reduce, type CoordinationEvent } from "@saas/contracts/coordination";

// Integration test for the RunCoordinator Durable Object against the real
// Workers runtime (miniflare): durable storage + the pure deciders + exactly-one
// -winner serialization. We bundle the test entry with esbuild and load it into
// miniflare with a DO binding.

let mf: Miniflare;

async function bundle(): Promise<string> {
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
  return res.outputFiles[0]!.text;
}

beforeAll(async () => {
  const script = await bundle();
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: "2025-05-01",
    durableObjects: { COORDINATOR: "RunCoordinator" },
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
});

async function call(runId: string, op: string, method: "GET" | "POST", body?: unknown) {
  const res = await mf.dispatchFetch(`http://x/runs/${runId}${op}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const PLAN = { jobs: { a: { deps: [] as string[] }, b: { deps: ["a"] } } };

describe("RunCoordinator (miniflare integration)", () => {
  it("inits, claims, gates deps, and runs to a folded read of state", async () => {
    const run = "r-int-1";
    const init = await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:p", sourceHash: "sha256:s" });
    expect(init.status).toBe(200);

    // a is in the frontier and can be claimed.
    const c1 = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1" });
    expect(c1.json.claimed).toBe(true);
    const leaseEpoch = c1.json.leaseEpoch as number;

    // A second runner cannot claim the held job.
    const c2 = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r2" });
    expect(c2.json).toMatchObject({ claimed: false, reason: "job_held" });

    // b is blocked until a succeeds.
    const cb = await call(run, "/claim", "POST", { jobId: "b", runnerId: "r1" });
    expect(cb.json).toMatchObject({ claimed: false, reason: "deps_not_ready" });

    // The holder completes a; b becomes claimable. §3: complete → { seq }.
    const done = await call(run, "/complete", "POST", { jobId: "a", runnerId: "r1", leaseEpoch, outcome: "succeeded", resultDigest: "sha256:ra" });
    expect(typeof done.json.seq).toBe("number");

    const st = await call(run, "/state", "GET");
    expect((st.json as { jobs: Record<string, { phase: string }> }).jobs.a!.phase).toBe("succeeded");
    expect((st.json as { frontier: string[] }).frontier).toEqual(["b"]);

    const cb2 = await call(run, "/claim", "POST", { jobId: "b", runnerId: "r1" });
    expect(cb2.json.claimed).toBe(true);
  });

  it("rejects a foreign heartbeat with 409 lease_lost", async () => {
    const run = "r-int-2";
    await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:p", sourceHash: "sha256:s" });
    const c = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1" });
    const leaseEpoch = c.json.leaseEpoch as number;

    const ok = await call(run, "/heartbeat", "POST", { jobId: "a", runnerId: "r1", leaseEpoch });
    expect(ok.status).toBe(200);

    const lost = await call(run, "/heartbeat", "POST", { jobId: "a", runnerId: "r2", leaseEpoch });
    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({ error: "lease_lost" });
  });

  it("emits the coordination-api §3 response envelopes", async () => {
    const run = "r-int-4";
    await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:p", sourceHash: "sha256:s" });

    // claimed → { claimed:true, leaseEpoch, leaseExpiresAt, seq }
    const claimed = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1" });
    expect(claimed.json).toMatchObject({ claimed: true });
    expect(typeof claimed.json.seq).toBe("number");
    expect(typeof claimed.json.leaseExpiresAt).toBe("string");

    // complete a, then a re-claim of a terminal job → reason run_terminal (not "terminal")
    const leaseEpoch = claimed.json.leaseEpoch as number;
    await call(run, "/complete", "POST", { jobId: "a", runnerId: "r1", leaseEpoch, outcome: "succeeded", resultDigest: "sha256:ra" });
    const terminal = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r9" });
    expect(terminal.json).toMatchObject({ claimed: false, reason: "run_terminal" });

    // cancel → { seq }
    const canceled = await call(run, "/cancel", "POST", {});
    expect(typeof canceled.json.seq).toBe("number");
  });

  it("a memoized claim returns { cached:true, result:{ digest } } (§3)", async () => {
    const run = "r-int-5";
    // single hermetic job memo plan
    const memoPlan = { jobs: { h: { deps: [] as string[] } } };
    await call(run, "/init", "POST", { runId: run, plan: memoPlan, planDigest: "sha256:p", sourceHash: "sha256:s" });
    const cached = await call(run, "/claim", "POST", { jobId: "h", runnerId: "r1", hermetic: true, memoResultDigest: "sha256:memo" });
    expect(cached.json).toMatchObject({ claimed: false, cached: true, result: { digest: "sha256:memo" } });
  });

  it("keeps the incrementally-folded state consistent across a snapshot boundary", async () => {
    const run = "r-int-snap";
    await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:p", sourceHash: "sha256:s" });
    const c = await call(run, "/claim", "POST", { jobId: "a", runnerId: "r1" });
    const leaseEpoch = c.json.leaseEpoch as number;

    // Drive well past SNAPSHOT_EVERY (64) so the DO checkpoints and keeps
    // advancing the in-memory fold incrementally rather than re-folding the log.
    for (let i = 0; i < 80; i++) {
      const hb = await call(run, "/heartbeat", "POST", { jobId: "a", runnerId: "r1", leaseEpoch });
      expect(hb.status).toBe(200);
    }

    // The authoritative live state must equal a from-scratch fold of the full log.
    const st = await call(run, "/state", "GET");
    const logRes = await call(run, "/log", "GET");
    const events = (logRes.json as { events: CoordinationEvent[] }).events;
    expect(events.length).toBe(82); // RunCreated + JobClaimed + 80 LeaseRenewed
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // contiguous, ordered
    expect(st.json).toEqual(reduce(events, PLAN));
    expect((st.json as { jobs: Record<string, { phase: string }> }).jobs.a!.phase).toBe("claimed");

    // `/log?from=` returns only the strictly-later events (per-event key slice).
    const tail = await call(run, "/log?from=80", "GET");
    const tailEvents = (tail.json as { events: CoordinationEvent[] }).events;
    expect(tailEvents.map((e) => e.seq)).toEqual([81, 82]);
  });

  it("init is idempotent for the same plan and conflicts on a different plan", async () => {
    const run = "r-int-3";
    const a = await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:p", sourceHash: "sha256:s" });
    expect(a.status).toBe(200);
    const again = await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:p", sourceHash: "sha256:s" });
    expect(again.status).toBe(200);
    const conflict = await call(run, "/init", "POST", { runId: run, plan: PLAN, planDigest: "sha256:DIFFERENT", sourceHash: "sha256:s" });
    expect(conflict.status).toBe(409);
  });
});
