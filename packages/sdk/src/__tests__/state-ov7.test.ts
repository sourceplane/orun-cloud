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
});
