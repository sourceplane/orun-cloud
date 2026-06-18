// OV9.2 — the cron driver for the stale-environment archival sweep. Verifies it
// calls the projects-worker internal archive-stale route and reports the count,
// stays dormant without the binding, and never throws on an upstream failure.

import { runEnvArchiveSweep } from "@state-worker/env-archive-sweep";
import type { Env } from "@state-worker/env";

function fetcher(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
  calls: { count: number; urls: string[] },
): Fetcher {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      calls.count += 1;
      calls.urls.push(String(input));
      return Promise.resolve(handler(input, init));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

describe("runEnvArchiveSweep", () => {
  it("calls the internal archive-stale route and returns the archived count", async () => {
    const calls = { count: 0, urls: [] as string[] };
    const env = {
      PROJECTS_WORKER: fetcher(
        () => Response.json({ data: { archived: 3, retentionDays: 90, environmentIds: ["env_a", "env_b", "env_c"] } }),
        calls,
      ),
    } as unknown as Env;
    const out = await runEnvArchiveSweep(env);
    expect(out).toEqual({ archived: 3 });
    expect(calls.count).toBe(1);
    expect(calls.urls[0]).toContain("/v1/internal/projects/environments/archive-stale");
  });

  it("is dormant (null, no call) without the projects-worker binding", async () => {
    const out = await runEnvArchiveSweep({} as unknown as Env);
    expect(out).toBeNull();
  });

  it("returns null on an upstream error without throwing", async () => {
    const calls = { count: 0, urls: [] as string[] };
    const env = {
      PROJECTS_WORKER: fetcher(() => new Response(null, { status: 503 }), calls),
    } as unknown as Env;
    const out = await runEnvArchiveSweep(env);
    expect(out).toBeNull();
  });

  it("returns archived=0 when the body reports none", async () => {
    const calls = { count: 0, urls: [] as string[] };
    const env = {
      PROJECTS_WORKER: fetcher(() => Response.json({ data: { archived: 0, environmentIds: [] } }), calls),
    } as unknown as Env;
    const out = await runEnvArchiveSweep(env);
    expect(out).toEqual({ archived: 0 });
  });
});
