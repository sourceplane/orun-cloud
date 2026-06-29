// WS3: the `workspaces` namespace aliases `organizations` over the public
// `/v1/workspaces` surface. Same ids, same client; `organizations` is retained.

import { describe, expect, it, vi } from "vitest";

import { OrunCloud, WorkspacesClient } from "../index.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(body: unknown): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn, calls };
}

function envelope<T>(data: T): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

function client(fetchImpl: typeof fetch): OrunCloud {
  return new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("WorkspacesClient", () => {
  it("is exposed on the client and is a distinct WorkspacesClient", () => {
    const { fetch } = captureFetch(envelope({ organizations: [] }));
    const c = client(fetch);
    expect(c.workspaces).toBeInstanceOf(WorkspacesClient);
    expect(c.organizations).toBeDefined(); // legacy spelling retained
  });

  it("list hits the /v1/workspaces surface", async () => {
    const { fetch, calls } = captureFetch(envelope({ organizations: [] }));
    await client(fetch).workspaces.list();
    expect(calls[0]!.url).toBe("https://api.test/v1/workspaces");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("get hits the workspace-scoped path", async () => {
    const { fetch, calls } = captureFetch(envelope({ organization: {} }));
    await client(fetch).workspaces.get("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/workspaces/org_1");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("create posts to /v1/workspaces and propagates the idempotency-key", async () => {
    const { fetch, calls } = captureFetch(envelope({ organization: {}, membership: {} }));
    await client(fetch).workspaces.create({ name: "Acme" }, { idempotencyKey: "ikey_ws_1" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(calls[0]!.url).toBe("https://api.test/v1/workspaces");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers.get("idempotency-key")).toBe("ikey_ws_1");
  });
});
