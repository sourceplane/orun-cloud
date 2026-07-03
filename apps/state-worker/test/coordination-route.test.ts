import { COORDINATION_EVENT_TYPES as K, reduce, type CoordinationEvent } from "@saas/contracts/coordination";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import {
  __resetProjectorReadyCache,
  ensureRunShard,
  initCoordinator,
  planFromJobs,
  projectCoordinatorRun,
  proxyCoordinatorLog,
  proxyCoordinatorVerb,
  useDoCoordination,
} from "../src/coordination-route.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeEnv(
  backend: string | undefined,
  respond: (call: Call) => Response,
  withBinding = true,
): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
  };
  const ns = { idFromName: (n: string) => ({ name: n }), get: () => stub };
  const env = {
    COORDINATION_BACKEND: backend,
    ...(withBinding ? { COORDINATOR: ns } : {}),
  } as unknown as Env;
  return { env, calls };
}

describe("useDoCoordination — flag + binding gate", () => {
  const ok = (call: Call) => new Response("{}", { status: 200 });
  it("true only when backend=do AND the binding is present", () => {
    expect(useDoCoordination(fakeEnv("do", ok).env)).toBe(true);
    expect(useDoCoordination(fakeEnv("op2", ok).env)).toBe(false);
    expect(useDoCoordination(fakeEnv(undefined, ok).env)).toBe(false);
    expect(useDoCoordination(fakeEnv("do", ok, false).env)).toBe(false); // fail closed
  });
});

describe("planFromJobs — DAG mapping", () => {
  it("maps jobs to { id: { deps } }, defaulting deps to []", () => {
    expect(
      planFromJobs([
        { jobId: "a" },
        { jobId: "b", deps: ["a"] },
        { jobId: "c", deps: ["a", "b"], component: "svc" },
      ]),
    ).toEqual({ jobs: { a: { deps: [] }, b: { deps: ["a"] }, c: { deps: ["a", "b"] } } });
  });
});

describe("proxyCoordinatorVerb — forwards to the run shard and proxies the response", () => {
  it("posts /claim with the body and re-emits status + JSON verbatim", async () => {
    const { env, calls } = fakeEnv("do", () =>
      new Response(JSON.stringify({ claimed: false, cached: true, result: { digest: "sha256:x" } }), { status: 200 }),
    );
    const res = await proxyCoordinatorVerb(env, "run-1", "claim", { jobId: "a", runnerId: "r1" });
    expect(calls[0]!.url).toBe("https://coordinator/claim");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ jobId: "a", runnerId: "r1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: false, cached: true, result: { digest: "sha256:x" } });
  });

  it("propagates a 409 (lease_lost) from the DO", async () => {
    const { env } = fakeEnv("do", () => new Response(JSON.stringify({ error: "lease_lost" }), { status: 409 }));
    const res = await proxyCoordinatorVerb(env, "run-1", "heartbeat", { jobId: "a", runnerId: "r2", leaseEpoch: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "lease_lost" });
  });
});

describe("initCoordinator — idempotent run shard init", () => {
  it("posts /init carrying runId + plan + digests", async () => {
    const { env, calls } = fakeEnv("do", () => new Response(JSON.stringify({ runId: "run-1", head: { seq: 1 } }), { status: 200 }));
    await initCoordinator(env, "run-1", {
      plan: planFromJobs([{ jobId: "a" }]),
      planDigest: "sha256:p",
      sourceHash: "sha256:s",
      environment: "prod",
    });
    expect(calls[0]!.url).toBe("https://coordinator/init");
    expect(calls[0]!.body).toMatchObject({ runId: "run-1", planDigest: "sha256:p", plan: { jobs: { a: { deps: [] } } } });
  });
});

// ── ensureRunShard — lazy self-heal of a run whose shard was never seeded ──
// An executor that serves the run + run_jobs a lazy seed needs. `readiness`
// controls the projectorReady probe (throw ⇒ not ready); `runFound` controls
// whether getRunByUlid returns a row.
function seedExecutor(opts: { readiness: boolean; runFound: boolean }): {
  exec: SqlExecutor;
  calls: () => number;
} {
  let n = 0;
  const now = new Date().toISOString();
  const exec: SqlExecutor = {
    async execute(text: string) {
      n += 1;
      if (/SELECT last_seq/.test(text)) {
        if (!opts.readiness) throw new Error("state.runs.last_seq missing");
        return { rows: [] as never[], rowCount: 0 };
      }
      if (/run_ulid/.test(text)) {
        if (!opts.runFound) return { rows: [] as never[], rowCount: 0 };
        return {
          rows: [
            {
              id: "00000000-0000-0000-0000-0000000000c3",
              org_id: "o",
              project_id: "p",
              environment: "prod",
              run_ulid: "01JRUN",
              plan_digest: "sha256:" + "p".repeat(64),
              source: "ci",
              status: "pending",
              git_commit: null,
              git_dirty: false,
              labels: null,
              created_at: now,
              updated_at: now,
            },
          ] as never[],
          rowCount: 1,
        };
      }
      if (/run_jobs/.test(text)) {
        return {
          rows: [
            { id: "j1", org_id: "o", project_id: "p", run_id: "00000000-0000-0000-0000-0000000000c3", job_id: "a", deps: "[]", component: null, status: "queued", attempt: 0, created_at: now, updated_at: now },
            { id: "j2", org_id: "o", project_id: "p", run_id: "00000000-0000-0000-0000-0000000000c3", job_id: "b", deps: '["a"]', component: null, status: "queued", attempt: 0, created_at: now, updated_at: now },
          ] as never[],
          rowCount: 2,
        };
      }
      return { rows: [] as never[], rowCount: 0 };
    },
  } as unknown as SqlExecutor;
  return { exec, calls: () => n };
}

describe("ensureRunShard — self-heal an unseeded run", () => {
  beforeEach(() => __resetProjectorReadyCache());
  const O = "o" as Uuid;
  const P = "p" as Uuid;

  // /state reports the shard as unseeded (fold.runId !== runUlid) so the seed path
  // runs; /init acknowledges. Records whether /init was posted with which plan.
  function unseededEnv() {
    return fakeEnv("do", (call) => {
      if (call.url.endsWith("/state")) return new Response(JSON.stringify({ runId: "" }), { status: 200 });
      if (call.url.endsWith("/init")) return new Response(JSON.stringify({ runId: "01JRUN", head: { seq: 1 } }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
  }

  it("rebuilds the shard from persisted run + run_jobs, then reports backed", async () => {
    const { env, calls } = unseededEnv();
    const { exec } = seedExecutor({ readiness: true, runFound: true });
    const ok = await ensureRunShard(env, O, P, "01JRUN", exec);
    expect(ok).toBe(true);
    const init = calls.find((c) => c.url.endsWith("/init"));
    expect(init).toBeDefined();
    // Plan reconstructed from the two run_jobs rows (a, b→deps[a]).
    expect(init!.body).toMatchObject({ runId: "01JRUN", plan: { jobs: { a: { deps: [] }, b: { deps: ["a"] } } } });
  });

  it("returns true WITHOUT touching the DB when the shard is already seeded", async () => {
    // /state reports the run as backed → short-circuit before any DB read.
    const { env, calls } = fakeEnv("do", () => new Response(JSON.stringify({ runId: "01JRUN" }), { status: 200 }));
    const { exec, calls: dbCalls } = seedExecutor({ readiness: true, runFound: true });
    const ok = await ensureRunShard(env, O, P, "01JRUN", exec);
    expect(ok).toBe(true);
    expect(dbCalls()).toBe(0); // no DB touch on the common path
    expect(calls.some((c) => c.url.endsWith("/init"))).toBe(false); // no re-seed
  });

  it("does NOT seed (404s) when the projector is not ready — avoids split-brain", async () => {
    const { env, calls } = unseededEnv();
    const { exec } = seedExecutor({ readiness: false, runFound: true });
    const ok = await ensureRunShard(env, O, P, "01JRUN", exec);
    expect(ok).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/init"))).toBe(false);
  });

  it("returns false when the run does not exist in Postgres", async () => {
    const { env } = unseededEnv();
    const { exec } = seedExecutor({ readiness: true, runFound: false });
    expect(await ensureRunShard(env, O, P, "01JRUN", exec)).toBe(false);
  });

  it("returns false when the DO backend is disabled", async () => {
    const { env } = fakeEnv("op2", () => new Response("{}", { status: 200 }));
    const { exec } = seedExecutor({ readiness: true, runFound: true });
    expect(await ensureRunShard(env, O, P, "01JRUN", exec)).toBe(false);
  });
});

function ev(seq: number, kind: string, jobId: string | undefined, payload: unknown): CoordinationEvent {
  return { seq, kind, runId: "r1", jobId, actor: { id: "u", type: "user" }, at: "t", idempotencyKey: `${seq}`, v: 1, payload } as CoordinationEvent;
}

function fakeExecutor(): { exec: SqlExecutor; calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  const exec: SqlExecutor = {
    async execute(text, params = []) {
      calls.push({ text, params });
      if (/SELECT last_seq/.test(text)) return { rows: [{ last_seq: 0 }] as never[], rowCount: 1 };
      if (/UPDATE state\.runs/.test(text)) return { rows: [{ id: "run-row" }] as never[], rowCount: 1 };
      return { rows: [] as never[], rowCount: 0 };
    },
  };
  return { exec, calls };
}

describe("projectCoordinatorRun — fold the shard → apply projection", () => {
  it("reads /state, folds, and issues the seq-guarded read-model writes", async () => {
    const fold = reduce(
      [
        ev(1, K.RUN_CREATED, undefined, { planDigest: "sha256:p", sourceHash: "sha256:s", environment: null }),
        ev(2, K.JOB_CLAIMED, "a", { runnerId: "r1", leaseEpoch: 1, leaseExpiresAt: "2026-12-01T00:00:00Z", attempt: 1 }),
      ],
      { jobs: { a: { deps: [] }, b: { deps: ["a"] } } },
    );
    const { env } = fakeEnv("do", (call) =>
      call.url.endsWith("/state")
        ? new Response(JSON.stringify(fold), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    const { exec, calls } = fakeExecutor();

    await projectCoordinatorRun(env, exec, { orgId: "o" as Uuid, projectId: "p" as Uuid }, "r1");

    expect(calls.some((c) => /SELECT last_seq/.test(c.text))).toBe(true);
    const runUpdate = calls.find((c) => /UPDATE state\.runs/.test(c.text));
    expect(runUpdate).toBeDefined();
    // params: [orgId, projectId, runId, status, lastSeq]
    expect(runUpdate!.params[3]).toBe("running");
    expect(runUpdate!.params[4]).toBe(2);
    // job 'a' projected as claimed
    const jobUpdate = calls.find((c) => /UPDATE state\.run_jobs/.test(c.text));
    expect(jobUpdate!.params[3]).toBe("claimed");
  });

  it("no-ops when the shard has no state (unreachable / uninitialized)", async () => {
    const { env } = fakeEnv("do", () => new Response("nope", { status: 404 }));
    const { exec, calls } = fakeExecutor();
    await projectCoordinatorRun(env, exec, { orgId: "o" as Uuid, projectId: "p" as Uuid }, "r1");
    expect(calls.length).toBe(0); // never touched Postgres
  });
});

describe("proxyCoordinatorLog — event-log read", () => {
  it("GETs /log?from=N and proxies the events", async () => {
    const { env, calls } = fakeEnv("do", () => new Response(JSON.stringify({ events: [{ seq: 3 }] }), { status: 200 }));
    const res = await proxyCoordinatorLog(env, "run-1", 2);
    expect(calls[0]!.url).toBe("https://coordinator/log?from=2");
    expect(calls[0]!.method).toBe("GET");
    expect(await res.json()).toEqual({ events: [{ seq: 3 }] });
  });
});
