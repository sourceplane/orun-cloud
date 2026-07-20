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
});
