// Dispatch resource client (saas-dispatch DX0): the Situation fold is one
// GET, org-scoped; the client adds nothing (authorization is per-viewer,
// downstream).

import { describe, expect, it, vi } from "vitest";

import { OrunCloud } from "../index.js";

describe("dispatch resource", () => {
  it("reads the situation fold with org scoping", async () => {
    const calls: string[] = [];
    const f: typeof fetch = vi.fn(async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: { ready: [], inFlight: [], waitingOnMe: [], counts: {}, budget: {}, cursor: "w0.0", sections: {} },
          meta: { requestId: "req_t", cursor: null },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const c = new OrunCloud({ baseUrl: "https://api.test", fetch: f });
    const situation = await c.dispatch.situation("org_x");
    expect(calls[0]).toContain("/v1/organizations/org_x/dispatch/situation");
    expect(situation.cursor).toBe("w0.0");
  });

  it("hands off through the ONE dispatch door (DX2 Ready card)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: { id: "as_1", state: "requested" }, meta: { requestId: "r", cursor: null } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const c = new OrunCloud({ baseUrl: "https://api.test", fetch: f });
    await c.agents.dispatchTask("org_x", { taskKey: "ORN-1" });
    expect(calls[0]!.url).toContain("/v1/organizations/org_x/agents/dispatch");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ taskKey: "ORN-1" });
  });
});
