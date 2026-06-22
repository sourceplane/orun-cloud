import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import type { ActorContext } from "../src/router.js";
import type { Uuid } from "@saas/db/ids";
import {
  handleNativeCancel,
  handleNativeClaim,
  handleNativeComplete,
  handleNativeFrontier,
  handleNativeHeartbeat,
  handleNativeLog,
} from "../src/coordination-native.js";
import { objectKey } from "../src/object-store.js";
import { orgPublicId, projectPublicId } from "../src/ids.js";

// Native v2 coordination wire (BM4 — coordination-api.md §2/§3) against the
// *real* RunCoordinator DO (miniflare). Verifies the §3 verbs/reads the handlers
// expose: conditional-append claim with deps gating + exactly-one-winner, lease
// renew/loss (409), terminal complete, the frontier read, the event-log read,
// and — the BM5 fix — that every appended event carries the VERIFIED actor, not
// `system:coordinator`. Authz is exercised via a workflow actor (bound scope ==
// request scope ⇒ allowed; mismatch ⇒ resource-hiding 404), which needs no
// membership/policy worker.

let mf: Miniflare;
let env: Env;

const ORG = "00000000-0000-0000-0000-0000000000a1" as Uuid;
const PROJ = "00000000-0000-0000-0000-0000000000b2" as Uuid;

/** A workflow actor whose bound scope matches (ORG, PROJ) — authorizeRun grants. */
const ACTOR: ActorContext = {
  subjectId: "wf-runner-1",
  subjectType: "workflow",
  boundOrgId: ORG,
  boundProjectId: PROJ,
} as ActorContext;

const LINEAR = { jobs: { a: { deps: [] as string[] }, b: { deps: ["a"] } } };

function post(body: unknown): Request {
  return new Request("https://x/", { method: "POST", body: JSON.stringify(body) });
}

async function initRun(run: string, plan: unknown) {
  const ns = (env as unknown as { COORDINATOR: { idFromName: (n: string) => unknown; get: (id: unknown) => { fetch: (u: string, i: RequestInit) => Promise<Response> } } }).COORDINATOR;
  const stub = ns.get(ns.idFromName(run));
  await stub.fetch("https://do/init", { method: "POST", body: JSON.stringify({ runId: run, plan, planDigest: "sha256:p", sourceHash: "sha256:s" }) });
}

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
    r2Buckets: ["ORUN_STATE"],
  });
  await mf.ready;
  const ns = await mf.getDurableObjectNamespace("COORDINATOR");
  const bucket = await mf.getR2Bucket("ORUN_STATE");
  env = { COORDINATION_BACKEND: "do", COORDINATOR: ns, ORUN_STATE: bucket } as unknown as Env;
});

afterAll(async () => {
  await mf?.dispose();
});

describe("native v2 coordination wire over the real DO", () => {
  it("claim → heartbeat → complete with §3 semantics, deps gating, and verified-actor stamping", async () => {
    const run = "native-1";
    await initRun(run, LINEAR);

    // Claim a — native §3 envelope (claimed + leaseEpoch + tunables).
    const claimRes = await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run, "a");
    expect(claimRes.status).toBe(200);
    const claim = (await claimRes.json()) as { claimed: boolean; leaseEpoch: number; attempt: number; leaseSeconds: number };
    expect(claim.claimed).toBe(true);
    expect(claim.attempt).toBe(1);
    expect(claim.leaseSeconds).toBeGreaterThan(0);
    const leaseEpoch = claim.leaseEpoch;

    // A second runner loses (exactly-one-winner) — native reason job_held.
    const loser = (await (await handleNativeClaim(post({ runnerId: "r2" }), env, "req", ACTOR, ORG, PROJ, run, "a")).json()) as { claimed: boolean; reason: string };
    expect(loser).toEqual({ claimed: false, reason: "job_held" });

    // b is dep-gated on a.
    const gated = (await (await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run, "b")).json()) as { claimed: boolean; reason: string };
    expect(gated).toEqual({ claimed: false, reason: "deps_not_ready" });

    // Heartbeat by the holder renews; by a non-holder it is lease_lost (409).
    const hb = await handleNativeHeartbeat(post({ runnerId: "r1", leaseEpoch }), env, "req", ACTOR, ORG, PROJ, run, "a");
    expect(hb.status).toBe(200);
    const hbLost = await handleNativeHeartbeat(post({ runnerId: "r2", leaseEpoch }), env, "req", ACTOR, ORG, PROJ, run, "a");
    expect(hbLost.status).toBe(409);

    // Complete a; b becomes claimable.
    const done = await handleNativeComplete(post({ runnerId: "r1", leaseEpoch, outcome: "succeeded" }), env, "req", ACTOR, ORG, PROJ, run, "a");
    expect(done.status).toBe(200);
    const claimB = (await (await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run, "b")).json()) as { claimed: boolean };
    expect(claimB.claimed).toBe(true);

    // BM5: the JobClaimed event for `a` carries the verified actor, not system:coordinator.
    const logRes = await handleNativeLog(new Request("https://x/log?from=0"), env, "req", ACTOR, ORG, PROJ, run);
    const { events } = (await logRes.json()) as { events: Array<{ kind: string; jobId?: string; actor: { id: string; type: string } }> };
    const claimedEvt = events.find((e) => e.kind.includes("claimed") && e.jobId === "a");
    expect(claimedEvt).toBeDefined();
    expect(claimedEvt!.actor).toEqual({ id: "wf-runner-1", type: "workflow" });
  });

  it("rejects a memo claim whose result object is missing (412 object_missing)", async () => {
    const run = "native-memo-miss";
    await initRun(run, { jobs: { h: { deps: [] as string[] } } });
    const digest = "sha256:" + "b".repeat(64); // never PUT — phantom
    const res = await handleNativeClaim(
      post({ runnerId: "r1", hermetic: true, memoResultDigest: digest }),
      env, "req", ACTOR, ORG, PROJ, run, "h",
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("object_missing");
    // The phantom hit never appended a JobMemoized — the job is still claimable.
    const claim = (await (await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run, "h")).json()) as { claimed: boolean };
    expect(claim.claimed).toBe(true);
  });

  it("honors a memo claim when the result object exists (cached → skip exec)", async () => {
    const run = "native-memo-hit";
    await initRun(run, { jobs: { h: { deps: [] as string[] } } });
    const digest = "sha256:" + "c".repeat(64);
    // Seed the CAS so the existence check passes (head only needs the key present).
    await (env as unknown as { ORUN_STATE: R2Bucket }).ORUN_STATE.put(
      objectKey(orgPublicId(ORG), projectPublicId(PROJ), digest),
      "result-bytes",
    );
    const res = await handleNativeClaim(
      post({ runnerId: "r1", hermetic: true, memoResultDigest: digest }),
      env, "req", ACTOR, ORG, PROJ, run, "h",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: false, cached: true, result: { digest } });
  });

  it("memoizes across runs: a recorded jobInputHash is server-resolved on a later claim", async () => {
    const plan = { jobs: { h: { deps: [] as string[] } } };
    const jobInputHash = "sha256:" + "d".repeat(64);
    const resultDigest = "sha256:" + "e".repeat(64);
    // Seed the result object so existence verification of the resolved digest passes.
    await (env as unknown as { ORUN_STATE: R2Bucket }).ORUN_STATE.put(
      objectKey(orgPublicId(ORG), projectPublicId(PROJ), resultDigest), "result-bytes");

    // Run 1: execute h and complete it with its input hash + result → indexes it.
    const run1 = "native-memo-run1";
    await initRun(run1, plan);
    const c1 = (await (await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run1, "h")).json()) as { leaseEpoch: number };
    const done = await handleNativeComplete(
      post({ runnerId: "r1", leaseEpoch: c1.leaseEpoch, outcome: "succeeded", resultDigest, jobInputHash }),
      env, "req", ACTOR, ORG, PROJ, run1, "h",
    );
    expect(done.status).toBe(200);

    // Run 2: the same hermetic job (same input hash) is served from cache — the
    // server resolved the digest from its index; the client sent only the key,
    // never a digest.
    const run2 = "native-memo-run2";
    await initRun(run2, plan);
    const c2 = await handleNativeClaim(post({ runnerId: "r2", hermetic: true, jobInputHash }), env, "req", ACTOR, ORG, PROJ, run2, "h");
    expect(c2.status).toBe(200);
    expect(await c2.json()).toMatchObject({ claimed: false, cached: true, result: { digest: resultDigest } });
  });

  it("re-executes when the input hash has no index entry", async () => {
    const run = "native-memo-none";
    await initRun(run, { jobs: { h: { deps: [] as string[] } } });
    const c = await handleNativeClaim(
      post({ runnerId: "r1", hermetic: true, jobInputHash: "sha256:" + "f".repeat(64) }),
      env, "req", ACTOR, ORG, PROJ, run, "h",
    );
    expect(c.status).toBe(200);
    expect((await c.json() as { claimed: boolean }).claimed).toBe(true); // no memo → normal claim
  });

  it("frontier reflects the runnable set and advances as jobs complete", async () => {
    const run = "native-2";
    await initRun(run, LINEAR);

    const f0 = (await (await handleNativeFrontier(env, "req", ACTOR, ORG, PROJ, run)).json()) as { jobs: string[] };
    expect(f0.jobs).toEqual(["a"]);

    const claim = (await (await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run, "a")).json()) as { leaseEpoch: number };
    await handleNativeComplete(post({ runnerId: "r1", leaseEpoch: claim.leaseEpoch, outcome: "succeeded" }), env, "req", ACTOR, ORG, PROJ, run, "a");

    const f1 = (await (await handleNativeFrontier(env, "req", ACTOR, ORG, PROJ, run)).json()) as { jobs: string[] };
    expect(f1.jobs).toEqual(["b"]);
  });

  it("cancel terminates the run", async () => {
    const run = "native-3";
    await initRun(run, LINEAR);
    await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, run, "a");
    const cancel = await handleNativeCancel(env, "req", ACTOR, ORG, PROJ, run);
    expect(cancel.status).toBe(200);
    // A canceled run exposes no runnable frontier.
    const f = (await (await handleNativeFrontier(env, "req", ACTOR, ORG, PROJ, run)).json()) as { jobs: string[] };
    expect(f.jobs).toEqual([]);
  });

  it("hides cross-tenant and non-DO-backed runs as 404 (after deny-by-default authz)", async () => {
    const run = "native-4";
    await initRun(run, LINEAR);

    // Workflow actor bound to a DIFFERENT org → authorizeRun denies → 404.
    const wrongOrg: ActorContext = { subjectId: "wf-x", subjectType: "workflow", boundOrgId: "00000000-0000-0000-0000-0000000000ff" as Uuid, boundProjectId: PROJ } as ActorContext;
    const denied = await handleNativeClaim(post({ runnerId: "r1" }), env, "req", wrongOrg, ORG, PROJ, run, "a");
    expect(denied.status).toBe(404);

    // Authorized actor, but a run with no DO shard → native surface is absent → 404.
    const noShard = await handleNativeClaim(post({ runnerId: "r1" }), env, "req", ACTOR, ORG, PROJ, "never-seeded", "a");
    expect(noShard.status).toBe(404);
  });

  it("rejects a claim with no runnerId (422 validation)", async () => {
    const run = "native-5";
    await initRun(run, LINEAR);
    const bad = await handleNativeClaim(post({}), env, "req", ACTOR, ORG, PROJ, run, "a");
    expect(bad.status).toBe(422);
  });
});
