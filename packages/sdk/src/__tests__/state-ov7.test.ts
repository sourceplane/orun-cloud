// Tests for the OV7 StateClient additions: the org-global catalog browser and
// the project runs list. Coverage: URL shape, encodeURIComponent on dynamic
// segments, and that optional filters appear in the query string only when
// provided (the transport omits undefined) — so an unfiltered call is a clean
// path with no stray params.

import { describe, expect, it, vi } from "vitest";

import { OrunCloud } from "../index.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function envelope<T>(data: T): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

function client(fetchImpl: typeof fetch): OrunCloud {
  return new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("StateClient — org-global catalog (OV7)", () => {
  it("lists the org-scoped catalog with no query params when unfiltered", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ entities: [], nextCursor: null })));
    await client(fetch).state.listOrgCatalogEntities("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/catalog/entities");
  });

  it("includes only the provided filters in the query string", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ entities: [], nextCursor: null })));
    await client(fetch).state.listOrgCatalogEntities("org_1", {
      project: "prj_2",
      kind: "Component",
      q: "api",
      limit: 25,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/organizations/org_1/catalog/entities");
    expect(url.searchParams.get("project")).toBe("prj_2");
    expect(url.searchParams.get("kind")).toBe("Component");
    expect(url.searchParams.get("q")).toBe("api");
    expect(url.searchParams.get("limit")).toBe("25");
    // Omitted filters must not appear.
    expect(url.searchParams.has("environment")).toBe(false);
    expect(url.searchParams.has("owner")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("encodeURIComponent-escapes the org id", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ entities: [], nextCursor: null })));
    await client(fetch).state.listOrgCatalogEntities("org/with slash");
    expect(calls[0]!.url).toContain("/v1/organizations/org%2Fwith%20slash/catalog/entities");
  });
});

describe("StateClient — state storage footprint (OV9)", () => {
  it("GETs the org-scoped state usage endpoint", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ usage: { objects: { count: 1, bytes: 2 }, logs: { count: 3, bytes: 4 } } })),
    );
    const out = await client(fetch).state.getStateStorage("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/state/usage");
    expect(out.usage.objects.bytes).toBe(2);
  });

  it("encodeURIComponent-escapes the org id", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ usage: { objects: { count: 0, bytes: 0 }, logs: { count: 0, bytes: 0 } } })),
    );
    await client(fetch).state.getStateStorage("org/with slash");
    expect(calls[0]!.url).toContain("/v1/organizations/org%2Fwith%20slash/state/usage");
  });
});

describe("StateClient — object GC report (OV9)", () => {
  it("GETs the project-scoped, report-only gc endpoint", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({ report: { totalObjects: 4, totalBytes: 4696, reachableObjects: 3, unreachableObjects: 1, reclaimableBytes: 4096, capped: false } }),
      ),
    );
    const out = await client(fetch).state.getGcReport("org_1", "prj_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects/prj_1/state/gc/report");
    expect(out.report.reclaimableBytes).toBe(4096);
  });

  it("encodeURIComponent-escapes the path segments", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ report: { totalObjects: 0, totalBytes: 0, reachableObjects: 0, unreachableObjects: 0, reclaimableBytes: 0, capped: false } })),
    );
    await client(fetch).state.getGcReport("org/x", "prj/y");
    expect(calls[0]!.url).toContain("/v1/organizations/org%2Fx/projects/prj%2Fy/state/gc/report");
  });
});

describe("StateClient — object GC collect (OV9)", () => {
  const okResult = {
    result: { totalObjects: 1, reachableObjects: 0, unreachableObjects: 1, candidateObjects: 1, candidateBytes: 9, deletedObjects: 0, deletedBytes: 0, dryRun: true, capped: false, graceDays: 7 },
  };

  it("POSTs the collect endpoint with the body", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope(okResult)));
    const out = await client(fetch).state.collectGc("org_1", "prj_1", { dryRun: false, graceDays: 14 });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects/prj_1/state/gc/collect");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ dryRun: false, graceDays: 14 });
    expect(out.result.dryRun).toBe(true);
  });

  it("defaults to an empty body (dry-run preview) and escapes the path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope(okResult)));
    await client(fetch).state.collectGc("org/x", "prj/y");
    expect(calls[0]!.url).toContain("/v1/organizations/org%2Fx/projects/prj%2Fy/state/gc/collect");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });
});

describe("StateClient — project runs (OV7)", () => {
  it("lists the project-scoped runs path with status/environment filters", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ runs: [], nextCursor: null })));
    await client(fetch).state.listRuns("org_1", "prj_2", { status: "failed", environment: "prod" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/organizations/org_1/projects/prj_2/state/runs");
    expect(url.searchParams.get("status")).toBe("failed");
    expect(url.searchParams.get("environment")).toBe("prod");
  });

  it("lists runs with no params when unfiltered", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ runs: [], nextCursor: null })));
    await client(fetch).state.listRuns("org_1", "prj_2");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects/prj_2/state/runs");
  });

  it("gets one run by id", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ run: { runId: "01J0" } })));
    await client(fetch).state.getRun("org_1", "prj_2", "01J0");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects/prj_2/state/runs/01J0");
  });

  it("lists a run's jobs", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ jobs: [] })));
    await client(fetch).state.listRunJobs("org_1", "prj_2", "01J0");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects/prj_2/state/runs/01J0/jobs");
  });

  it("reads a job's logs from a seq cursor", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ content: "", nextSeq: 0, complete: false })));
    await client(fetch).state.readRunJobLogs("org_1", "prj_2", "01J0", "build", 12);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/organizations/org_1/projects/prj_2/state/runs/01J0/logs/build");
    expect(url.searchParams.get("fromSeq")).toBe("12");
  });
});
