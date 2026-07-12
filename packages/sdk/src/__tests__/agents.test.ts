// Agents resource client (saas-agents AG7): URL shapes for the session +
// provider surfaces, and the AG12 write-only-key invariant — the connect
// body carries the apiKey once and no method can read it back.

import { describe, expect, it, vi } from "vitest";

import { OrunCloud } from "../index.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(body: unknown): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: body, meta: { requestId: "req_t", cursor: null } }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn, calls };
}

function client(fetchImpl: typeof fetch): OrunCloud {
  return new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("agents resource", () => {
  it("hits the session routes with org scoping and state filter", async () => {
    const { fetch: f, calls } = captureFetch([]);
    const c = client(f);
    await c.agents.listSessions("org_x", "running");
    await c.agents.getSession("org_x", "as_1");
    await c.agents.provisionSession("org_x", "as_1");
    await c.agents.listSessionEvents("org_x", "as_1");

    expect(calls[0]!.url).toContain("/v1/organizations/org_x/agents/sessions");
    expect(calls[0]!.url).toContain("state=running");
    expect(calls[1]!.url).toContain("/agents/sessions/as_1");
    expect(calls[2]!.url).toContain("/agents/sessions/as_1/provision");
    expect(calls[2]!.init.method).toBe("POST");
    expect(calls[3]!.url).toContain("/agents/sessions/as_1/events");
  });

  it("reads the needs-you fold (saas-agents-fleet AF5)", async () => {
    const { fetch: f, calls } = captureFetch({ items: [], counts: {}, running: 0 });
    const c = client(f);
    await c.agents.attention("org_x");
    expect(calls[0]!.url).toContain("/v1/organizations/org_x/agents/attention");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("connects a provider with the key in the body exactly once, and disconnects with DELETE", async () => {
    const { fetch: f, calls } = captureFetch({ id: "apc_1", status: "verified" });
    const c = client(f);
    await c.agents.connectProvider("org_x", { provider: "anthropic", apiKey: "sk-ant-x" });
    await c.agents.verifyProvider("org_x", "apc_1");
    await c.agents.disconnectProvider("org_x", "apc_1");

    expect(calls[0]!.url).toContain("/v1/organizations/org_x/agents/providers");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ provider: "anthropic", apiKey: "sk-ant-x" });
    expect(calls[1]!.url).toContain("/agents/providers/apc_1/verify");
    expect(calls[2]!.init.method).toBe("DELETE");
    // No read-back surface exists: the client has no key getter.
    expect(Object.keys(Object.getPrototypeOf(c.agents)).every((k) => !/key/i.test(k))).toBe(true);
  });
});
