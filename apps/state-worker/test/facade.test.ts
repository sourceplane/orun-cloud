import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import {
  coordinatorClaimOP2,
  coordinatorCompleteOP2,
  coordinatorHeartbeatOP2,
  runIsDoBacked,
} from "../src/coordination-route.js";

// OP2↔DO facade conformance (BM6 cutover). Drives the OP2 compatibility helpers
// against the *real* RunCoordinator DO (miniflare): they must reproduce OP2
// semantics — runnerId-as-holder, the {claimed} outcome, 409 lease_lost on
// takeover, and terminal-sticky idempotent re-complete — while deriving the DO's
// leaseEpoch (which OP2 clients never see) from the shard.

let mf: Miniflare;
let env: Env;

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
  const ns = await mf.getDurableObjectNamespace("COORDINATOR");
  env = { COORDINATION_BACKEND: "do", COORDINATOR: ns } as unknown as Env;
});

afterAll(async () => {
  await mf?.dispose();
});

async function initRun(run: string, plan: unknown) {
  const ns = (env as unknown as { COORDINATOR: { idFromName: (n: string) => unknown; get: (id: unknown) => { fetch: (u: string, i: RequestInit) => Promise<Response> } } }).COORDINATOR;
  const stub = ns.get(ns.idFromName(run));
  await stub.fetch("https://do/init", { method: "POST", body: JSON.stringify({ runId: run, plan, planDigest: "sha256:p", sourceHash: "sha256:s" }) });
}

const LINEAR = { jobs: { a: { deps: [] as string[] }, b: { deps: ["a"] } } };

describe("OP2 facade over the real DO", () => {
  it("claim → heartbeat → complete with OP2 holder semantics", async () => {
    const run = "facade-1";
    await initRun(run, LINEAR);

    // Claim a; the OP2 envelope is {claimed, leaseExpiresAt, attempt}.
    const claim = await coordinatorClaimOP2(env, run, "a", "r1");
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "claimed") {
      expect(claim.attempt).toBe(1);
      expect(claim.leaseExpiresAt).not.toBe("");
    }

    // A different runner loses → already_claimed (OP2 vocabulary).
    const loser = await coordinatorClaimOP2(env, run, "a", "r2");
    expect(loser).toEqual({ kind: "refused", reason: "already_claimed" });

    // b is gated until a completes.
    expect(await coordinatorClaimOP2(env, run, "b", "r1")).toEqual({ kind: "refused", reason: "deps_not_ready" });

    // Heartbeat by the holder renews; by a non-holder it's lease_lost (no leaseEpoch needed from the client).
    expect((await coordinatorHeartbeatOP2(env, run, "a", "r1")).kind).toBe("ok");
    expect(await coordinatorHeartbeatOP2(env, run, "a", "r2")).toEqual({ kind: "lease_lost" });

    // A non-holder cannot complete a live job.
    expect(await coordinatorCompleteOP2(env, run, "a", "r2", "succeeded", null)).toEqual({ kind: "lease_lost" });

    // The holder completes; a re-complete is idempotent (terminal-sticky).
    expect(await coordinatorCompleteOP2(env, run, "a", "r1", "succeeded", null)).toEqual({ kind: "ok" });
    expect(await coordinatorCompleteOP2(env, run, "a", "r1", "succeeded", null)).toEqual({ kind: "ok" });

    // a done → b now claimable.
    expect((await coordinatorClaimOP2(env, run, "b", "r1")).kind).toBe("claimed");
  });

  it("backend stickiness: a run is DO-backed only once its shard is initialized", async () => {
    // Never-initialized run → not DO-backed → verbs fall back to OP2 (no in-flight
    // breakage when the flag flips on for runs created before the flip).
    expect(await runIsDoBacked(env, "never-seeded-run")).toBe(false);
    // Seed it → now DO-backed.
    await initRun("sticky-1", LINEAR);
    expect(await runIsDoBacked(env, "sticky-1")).toBe(true);
  });

  it("a failed completion is terminal and blocks dependents", async () => {
    const run = "facade-2";
    await initRun(run, LINEAR);
    await coordinatorClaimOP2(env, run, "a", "r1");
    expect(await coordinatorCompleteOP2(env, run, "a", "r1", "failed", "boom")).toEqual({ kind: "ok" });
    // b's dep failed → never ready.
    expect(await coordinatorClaimOP2(env, run, "b", "r1")).toEqual({ kind: "refused", reason: "deps_not_ready" });
  });
});
