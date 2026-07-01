import { handleCreateTeam, handleListTeams, handleGetTeam, handleDeleteTeam } from "@membership-worker/handlers/teams";
import { orgPublicId, teamPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization, RoleAssignment, Team, CreateTeamInput } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";
import { teamRepoStubs } from "./team-repo-stubs.js";

const ACCOUNT = "00000000-0000-0000-0000-0000000000a1";
const CHILD = "00000000-0000-0000-0000-0000000000c1";
const TEAM_UUID = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ACCOUNT = "00000000-0000-0000-0000-0000000000f9";
const ACTOR = "usr_actor1";
const NOW = new Date("2026-02-01T00:00:00Z");

const policyFetcher = {
  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(init!.body as string) as AuthorizationRequest;
    return Response.json({ data: authorize(body), meta: { requestId: "r", cursor: null } });
  },
} as unknown as Fetcher;

function env(): Env {
  return { ENVIRONMENT: "test", PLATFORM_DB: {} as unknown as Hyperdrive, POLICY_WORKER: policyFetcher };
}

function org(id: string, parentOrgId: string | null): Organization {
  return { id, name: "n", slug: "s", slugLower: "s", publicRef: "ws_TESTREF1", status: "active", parentOrgId, createdAt: NOW, updatedAt: NOW };
}
function team(id: string, accountOrgId: string): Team {
  return { id, accountOrgId, name: "Platform", slugLower: "platform", status: "active", createdAt: NOW, updatedAt: NOW };
}
function accountRole(role: string): RoleAssignment {
  return { id: "ra", orgId: ACCOUNT, subjectId: ACTOR, subjectType: "user", role, scopeKind: "account", scopeRef: null, createdAt: NOW, revokedAt: null };
}
function orgRole(orgId: string, role: string): RoleAssignment {
  return { id: "ra", orgId, subjectId: ACTOR, subjectType: "user", role, scopeKind: "organization", scopeRef: null, createdAt: NOW, revokedAt: null };
}

function makeRepo(cfg: {
  orgs: Record<string, Organization>;
  roles?: Record<string, RoleAssignment[]>;   // `${orgId}|${subjectId}`
  teams?: Record<string, Team>;
  teamsList?: Team[];
  createConflict?: boolean;
}): { repo: MembershipRepository; created: CreateTeamInput[]; revokedTeams: string[] } {
  const created: CreateTeamInput[] = [];
  const revokedTeams: string[] = [];
  const repo = {
    ...teamRepoStubs(),
    async getOrganizationById(id: string) {
      const o = cfg.orgs[id];
      return o ? { ok: true as const, value: o } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listRoleAssignments(orgId: string, subjectId: string) {
      return { ok: true as const, value: cfg.roles?.[`${orgId}|${subjectId}`] ?? [] };
    },
    async createTeam(input: CreateTeamInput) {
      if (cfg.createConflict) return { ok: false as const, error: { kind: "conflict" as const, entity: "team" } };
      created.push(input);
      return { ok: true as const, value: team(input.id, input.accountOrgId) };
    },
    async listTeams() {
      return { ok: true as const, value: cfg.teamsList ?? [] };
    },
    async getTeamById(id: string) {
      const t = cfg.teams?.[id];
      return t ? { ok: true as const, value: t } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async deleteTeam(id: string) {
      return { ok: true as const, value: { ...team(id, ACCOUNT), status: "deleted" } };
    },
    async revokeAllTeamGrants(teamPub: string) {
      revokedTeams.push(teamPub);
      return { ok: true as const, value: [] };
    },
  } as unknown as MembershipRepository;
  return { repo, created, revokedTeams };
}

function makeEvents(): { events: Array<{ type: string }>; eventsRepo: Pick<EventsRepository, "appendEventWithAudit"> } {
  const events: Array<{ type: string }> = [];
  const eventsRepo = {
    async appendEventWithAudit(input: { event: { type: string } }) {
      events.push({ type: input.event.type });
      return { ok: true as const, value: { event: input.event, audit: {} } as never };
    },
  } as Pick<EventsRepository, "appendEventWithAudit">;
  return { events, eventsRepo };
}

const actor = { subjectId: ACTOR, subjectType: "user" };
function req(orgUuid: string, body: unknown, method = "POST"): Request {
  return new Request(`http://mw/v1/organizations/${orgPublicId(orgUuid)}/teams`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("teams: create (saas-teams TM4b)", () => {
  it("an account_admin creates a team on the account + emits team.created", async () => {
    const { repo, created } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] } });
    const { events, eventsRepo } = makeEvents();
    const res = await handleCreateTeam(req(ACCOUNT, { name: "Platform" }), env(), "r1", actor, orgPublicId(ACCOUNT), { repo, eventsRepo, now: () => NOW });
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0]!.accountOrgId).toBe(ACCOUNT);
    expect(created[0]!.slugLower).toBe("platform");
    expect(events.map((e) => e.type)).toContain("team.created");
  });

  it("derives a slug from the name when none is given", async () => {
    const { repo, created } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] } });
    const res = await handleCreateTeam(req(ACCOUNT, { name: "Platform Eng!" }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(201);
    expect(created[0]!.slugLower).toBe("platform-eng");
  });

  it("a workspace-only admin cannot create an account team", async () => {
    const { repo, created } = makeRepo({
      orgs: { [CHILD]: org(CHILD, ACCOUNT), [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${CHILD}|${ACTOR}`]: [orgRole(CHILD, "admin")], [`${ACCOUNT}|${ACTOR}`]: [] },
    });
    const res = await handleCreateTeam(req(CHILD, { name: "Platform" }), env(), "r", actor, orgPublicId(CHILD), { repo });
    expect(res.status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it("rejects a missing name (422)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] } });
    const res = await handleCreateTeam(req(ACCOUNT, {}), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(422);
  });

  it("maps a slug conflict to 409", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, createConflict: true });
    const res = await handleCreateTeam(req(ACCOUNT, { name: "Platform" }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(409);
  });
});

describe("teams: list / get (saas-teams TM4b)", () => {
  it("lists teams for an account admin", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teamsList: [team(TEAM_UUID, ACCOUNT)] });
    const res = await handleListTeams(env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { teams: unknown[] } };
    expect(json.data.teams).toHaveLength(1);
  });

  it("gets a team that belongs to the account", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleGetTeam(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(200);
  });

  it("404s a team from another account", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, OTHER_ACCOUNT) } });
    const res = await handleGetTeam(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(404);
  });
});

describe("teams: delete (saas-teams TM4b)", () => {
  it("an account_admin deletes a team, cascade-revokes grants, emits team.deleted", async () => {
    const { repo, revokedTeams } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const { events, eventsRepo } = makeEvents();
    const res = await handleDeleteTeam(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo, eventsRepo, now: () => NOW });
    expect(res.status).toBe(200);
    expect(revokedTeams).toEqual([teamPublicId(TEAM_UUID)]);
    expect(events.map((e) => e.type)).toContain("team.deleted");
  });

  it("a non-admin cannot delete a team (404)", async () => {
    const { repo, revokedTeams } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [orgRole(ACCOUNT, "viewer")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleDeleteTeam(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(404);
    expect(revokedTeams).toHaveLength(0);
  });
});
