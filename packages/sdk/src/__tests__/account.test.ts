import { describe, expect, it, vi } from "vitest";
import { OrunCloud } from "../index.js";

interface CapturedCall { url: string; init: RequestInit }

function captureFetch(body: unknown): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: body, meta: { requestId: "req_1", cursor: null } }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fn, calls };
}

function client(body: unknown) {
  const { fetch, calls } = captureFetch(body);
  return { client: new OrunCloud({ baseUrl: "https://api.test", fetch }), calls };
}

describe("AccountClient (teams-hub TH1c)", () => {
  it("workspaces → GET /workspaces", async () => {
    const { client: c, calls } = client({ workspaces: [] });
    const res = await c.account.workspaces("org_1");
    expect(res).toEqual({ workspaces: [] });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/workspaces");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("members → GET /account-members (derived roster)", async () => {
    const roster = { members: [{ subjectId: "usr_a", subjectType: "user", origin: "both", accountRoles: ["account_admin"] }] };
    const { client: c, calls } = client(roster);
    const res = await c.account.members("org_1");
    expect(res).toEqual(roster);
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-members");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("roles → GET /account-roles", async () => {
    const { client: c, calls } = client({ assignments: [] });
    await c.account.roles("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-roles");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("grantRole → POST /account-roles with body", async () => {
    const { client: c, calls } = client({ assignment: { subjectId: "usr_a", role: "account_admin", scopeKind: "account" } });
    await c.account.grantRole("org_1", { subjectId: "usr_a", role: "account_admin" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-roles");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ subjectId: "usr_a", role: "account_admin" });
  });

  it("revokeRole → DELETE /account-roles with tuple body", async () => {
    const { client: c, calls } = client({ assignment: { subjectId: "usr_a", role: "account_admin", scopeKind: "account", revoked: true } });
    await c.account.revokeRole("org_1", { subjectId: "usr_a", role: "account_admin" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/account-roles");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ subjectId: "usr_a", role: "account_admin" });
  });
});
