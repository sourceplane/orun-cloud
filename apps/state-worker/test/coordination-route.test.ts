import { describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import {
  initCoordinator,
  planFromJobs,
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

describe("proxyCoordinatorLog — event-log read", () => {
  it("GETs /log?from=N and proxies the events", async () => {
    const { env, calls } = fakeEnv("do", () => new Response(JSON.stringify({ events: [{ seq: 3 }] }), { status: 200 }));
    const res = await proxyCoordinatorLog(env, "run-1", 2);
    expect(calls[0]!.url).toBe("https://coordinator/log?from=2");
    expect(calls[0]!.method).toBe("GET");
    expect(await res.json()).toEqual({ events: [{ seq: 3 }] });
  });
});
