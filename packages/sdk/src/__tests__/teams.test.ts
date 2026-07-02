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

describe("TeamsClient (saas-teams TM4c)", () => {
  it("listTeams → GET /teams", async () => {
    const { client: c, calls } = client({ teams: [] });
    const res = await c.teams.listTeams("org_1");
    expect(res).toEqual({ teams: [] });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("createTeam → POST /teams with body", async () => {
    const { client: c, calls } = client({ team: { id: "team_x" } });
    await c.teams.createTeam("org_1", { name: "Platform" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "Platform" });
  });

  it("updateTeam → PATCH /teams/:id", async () => {
    const { client: c, calls } = client({ team: { id: "team_x" } });
    await c.teams.updateTeam("org_1", "team_x", { name: "P2" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_x");
    expect(calls[0]!.init.method).toBe("PATCH");
  });

  it("deleteTeam → DELETE /teams/:id", async () => {
    const { client: c, calls } = client({ team: { id: "team_x" } });
    await c.teams.deleteTeam("org_1", "team_x");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_x");
  });

  it("addTeamMember → POST /teams/:id/members with body", async () => {
    const { client: c, calls } = client({ member: { subjectId: "usr_a" } });
    await c.teams.addTeamMember("org_1", "team_x", { subjectId: "usr_a" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_x/members");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ subjectId: "usr_a" });
  });

  it("removeTeamMember → DELETE /teams/:id/members/:subjectId", async () => {
    const { client: c, calls } = client({ member: { subjectId: "usr_a" } });
    await c.teams.removeTeamMember("org_1", "team_x", "usr_a");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_x/members/usr_a");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("listTeamMembers → GET /teams/:id/members", async () => {
    const { client: c, calls } = client({ members: [] });
    await c.teams.listTeamMembers("org_1", "team_x");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/teams/team_x/members");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("grantTeamRole → POST /team-roles with body", async () => {
    const { client: c, calls } = client({ grant: { teamId: "team_x", role: "builder", scopeKind: "organization", scopeRef: null } });
    await c.teams.grantTeamRole("org_1", { teamId: "team_x", role: "builder", scopeKind: "organization" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/team-roles");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string).teamId).toBe("team_x");
  });

  it("revokeTeamRole → DELETE /team-roles with body", async () => {
    const { client: c, calls } = client({ grant: { teamId: "team_x", role: "builder", scopeKind: "organization", scopeRef: null } });
    await c.teams.revokeTeamRole("org_1", { teamId: "team_x", role: "builder", scopeKind: "organization" });
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/team-roles");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(JSON.parse(calls[0]!.init.body as string).role).toBe("builder");
  });
});
