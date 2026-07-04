import { handleCreateTeam, handleListTeams, handleMyTeams, handleGetTeam, handleDeleteTeam, handleUpdateTeam, handleAddTeamMember, handleRemoveTeamMember, handleUpdateTeamMemberRole, handleListTeamMembers, handleListTeamGrants } from "@membership-worker/handlers/teams";
import { orgPublicId, teamPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization, RoleAssignment, Team, TeamMember, CreateTeamInput, CreateTeamMemberInput } from "@saas/db/membership";
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
  return { id, accountOrgId, name: "Platform", slugLower: "platform", handle: null, description: null, avatarRef: null, status: "active", createdAt: NOW, updatedAt: NOW };
}
function accountRole(role: string): RoleAssignment {
  return { id: "ra", orgId: ACCOUNT, subjectId: ACTOR, subjectType: "user", role, scopeKind: "account", scopeRef: null, createdAt: NOW, revokedAt: null };
}
function orgRole(orgId: string, role: string): RoleAssignment {
  return { id: "ra", orgId, subjectId: ACTOR, subjectType: "user", role, scopeKind: "organization", scopeRef: null, createdAt: NOW, revokedAt: null };
}

function member(subjectId: string, subjectType = "user", teamRole = "team_member"): TeamMember {
  return { teamId: TEAM_UUID, subjectId, subjectType, teamRole, status: "active", createdAt: NOW };
}

function makeRepo(cfg: {
  orgs: Record<string, Organization>;
  roles?: Record<string, RoleAssignment[]>;   // `${orgId}|${subjectId}`
  teams?: Record<string, Team>;
  teamsList?: Team[];
  members?: TeamMember[];
  grants?: RoleAssignment[];
  createConflict?: boolean;
  updateConflict?: boolean;
  removeMissing?: boolean;
  actorTeamRole?: string;   // teams-foundation TF2 — actor's team_role for the team-admin fallback
  myTeamsList?: Team[];     // teams-ownership TO3 — the caller's teams
  roleChanges?: Array<{ subjectId: string; teamRole: string }>;
}): { repo: MembershipRepository; created: CreateTeamInput[]; updated: Array<Record<string, unknown>>; revokedTeams: string[]; addedMembers: CreateTeamMemberInput[]; removedMembers: string[]; roleChanges: Array<{ subjectId: string; teamRole: string }> } {
  const created: CreateTeamInput[] = [];
  const updated: Array<Record<string, unknown>> = [];
  const revokedTeams: string[] = [];
  const roleChanges: Array<{ subjectId: string; teamRole: string }> = [];
  const addedMembers: CreateTeamMemberInput[] = [];
  const removedMembers: string[] = [];
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
    async updateTeam(id: string, input: { name?: string; slugLower?: string; handle?: string; description?: string; avatarRef?: string }) {
      if (cfg.updateConflict) return { ok: false as const, error: { kind: "conflict" as const, entity: "team" } };
      updated.push({ id, ...input });
      const base = team(id, ACCOUNT);
      return {
        ok: true as const,
        value: {
          ...base,
          name: input.name ?? base.name,
          slugLower: input.slugLower ?? base.slugLower,
          handle: input.handle ?? base.handle,
          description: input.description ?? base.description,
          avatarRef: input.avatarRef ?? base.avatarRef,
        },
      };
    },
    async deleteTeam(id: string) {
      return { ok: true as const, value: { ...team(id, ACCOUNT), status: "deleted" } };
    },
    async revokeAllTeamGrants(teamPub: string) {
      revokedTeams.push(teamPub);
      return { ok: true as const, value: [] };
    },
    async addTeamMember(input: CreateTeamMemberInput) {
      addedMembers.push(input);
      return { ok: true as const, value: member(input.subjectId, input.subjectType) };
    },
    async removeTeamMember(_teamId: string, subjectId: string) {
      if (cfg.removeMissing) return { ok: false as const, error: { kind: "not_found" as const } };
      removedMembers.push(subjectId);
      return { ok: true as const, value: { ...member(subjectId), status: "removed" } };
    },
    async listTeamMembers() {
      return { ok: true as const, value: cfg.members ?? [] };
    },
    async getTeamMember(_teamId: string, subjectId: string) {
      if (cfg.actorTeamRole && subjectId === ACTOR) {
        return { ok: true as const, value: member(ACTOR, "user", cfg.actorTeamRole) };
      }
      return { ok: false as const, error: { kind: "not_found" as const } };
    },
    async updateTeamMemberRole(_teamId: string, subjectId: string, teamRole: string) {
      roleChanges.push({ subjectId, teamRole });
      return { ok: true as const, value: member(subjectId, "user", teamRole) };
    },
    async listTeamGrants() {
      return { ok: true as const, value: cfg.grants ?? [] };
    },
    async listTeamsForSubject() {
      return { ok: true as const, value: cfg.myTeamsList ?? [] };
    },
  } as unknown as MembershipRepository;
  return { repo, created, updated, revokedTeams, addedMembers, removedMembers, roleChanges };
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

  // teams-foundation TF1 — handle + profile.
  it("persists a handle + description (lower-cased) when supplied", async () => {
    const { repo, created } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] } });
    const res = await handleCreateTeam(
      req(ACCOUNT, { name: "Platform", handle: "Platform-Eng", description: "Owns the platform" }),
      env(), "r", actor, orgPublicId(ACCOUNT), { repo },
    );
    expect(res.status).toBe(201);
    expect(created[0]!.handle).toBe("platform-eng");
    expect(created[0]!.description).toBe("Owns the platform");
  });

  it("rejects an invalid handle (422) and does not create", async () => {
    const { repo, created } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] } });
    const res = await handleCreateTeam(req(ACCOUNT, { name: "Platform", handle: "-nope_bad" }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(422);
    expect(created).toHaveLength(0);
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

describe("teams: grants read (teams-hub TH3a)", () => {
  const grant = (orgId: string, role: string, scopeKind: string, scopeRef: string | null = null): RoleAssignment => ({
    id: `ra-${orgId}-${role}`, orgId, subjectId: teamPublicId(TEAM_UUID), subjectType: "team",
    role, scopeKind, scopeRef, createdAt: NOW, revokedAt: null,
  });

  it("lists the team's active grants across orgs, each tagged with its target org", async () => {
    const { repo } = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] },
      teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) },
      grants: [grant(ACCOUNT, "account_admin", "account"), grant(CHILD, "builder", "organization")],
    });
    const res = await handleListTeamGrants(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { grants: Array<Record<string, unknown>> } };
    expect(json.data.grants).toHaveLength(2);
    expect(json.data.grants[0]).toMatchObject({ role: "account_admin", scopeKind: "account", orgId: orgPublicId(ACCOUNT) });
    expect(json.data.grants[1]).toMatchObject({ role: "builder", scopeKind: "organization", orgId: orgPublicId(CHILD) });
  });

  it("404s a team from another account", async () => {
    const { repo } = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] },
      teams: { [TEAM_UUID]: team(TEAM_UUID, OTHER_ACCOUNT) },
      grants: [grant(ACCOUNT, "account_admin", "account")],
    });
    const res = await handleListTeamGrants(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(404);
  });

  it("denies an actor with no role on the account (404)", async () => {
    const { repo } = makeRepo({
      orgs: { [CHILD]: org(CHILD, ACCOUNT), [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${CHILD}|${ACTOR}`]: [orgRole(CHILD, "admin")], [`${ACCOUNT}|${ACTOR}`]: [] },
      teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) },
      grants: [grant(ACCOUNT, "account_admin", "account")],
    });
    const res = await handleListTeamGrants(env(), "r", actor, orgPublicId(CHILD), teamPublicId(TEAM_UUID), { repo });
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

const admins = { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] };
function memReq(orgUuid: string, teamUuid: string, body: unknown, method = "POST"): Request {
  return new Request(`http://mw/v1/organizations/${orgPublicId(orgUuid)}/teams/${teamPublicId(teamUuid)}/members`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("teams: update (saas-teams TM4b2)", () => {
  it("an account_admin renames a team + emits team.updated", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const { events, eventsRepo } = makeEvents();
    const request = new Request(`http://mw/v1/organizations/${orgPublicId(ACCOUNT)}/teams/${teamPublicId(TEAM_UUID)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Platform Team", slug: "Platform Team" }),
    });
    const res = await handleUpdateTeam(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo, eventsRepo, now: () => NOW });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { team: { name: string; slug: string } } };
    expect(json.data.team.name).toBe("Platform Team");
    expect(json.data.team.slug).toBe("platform-team");
    expect(events.map((e) => e.type)).toContain("team.updated");
  });

  it("rejects an empty patch (422)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const request = new Request(`http://mw/x`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const res = await handleUpdateTeam(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(422);
  });

  it("a non-admin cannot update (404)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [orgRole(ACCOUNT, "viewer")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const request = new Request(`http://mw/x`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "X" }) });
    const res = await handleUpdateTeam(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(404);
  });

  // teams-foundation TF1 — a profile-only patch (handle/description) is allowed.
  it("renames the handle alone (lower-cased) without name/slug", async () => {
    const { repo, updated } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const request = new Request(`http://mw/x`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "Payments" }) });
    const res = await handleUpdateTeam(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.handle).toBe("payments");
    const json = await res.json() as { data: { team: { handle: string } } };
    expect(json.data.team.handle).toBe("payments");
  });

  it("rejects an invalid handle on update (422)", async () => {
    const { repo, updated } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const request = new Request(`http://mw/x`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "Has Space" }) });
    const res = await handleUpdateTeam(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(422);
    expect(updated).toHaveLength(0);
  });
});

describe("teams: members (saas-teams TM4b2)", () => {
  it("an account_admin adds a member + emits team.member.added", async () => {
    const { repo, addedMembers } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const { events, eventsRepo } = makeEvents();
    const res = await handleAddTeamMember(memReq(ACCOUNT, TEAM_UUID, { subjectId: "usr_new" }), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo, eventsRepo });
    expect(res.status).toBe(201);
    expect(addedMembers[0]!.subjectId).toBe("usr_new");
    expect(addedMembers[0]!.subjectType).toBe("user");
    expect(events.map((e) => e.type)).toContain("team.member.added");
  });

  it("accepts a service_principal member", async () => {
    const { repo, addedMembers } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleAddTeamMember(memReq(ACCOUNT, TEAM_UUID, { subjectId: "sp_ci", subjectType: "service_principal" }), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(201);
    expect(addedMembers[0]!.subjectType).toBe("service_principal");
  });

  it("rejects an invalid subjectType (422)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleAddTeamMember(memReq(ACCOUNT, TEAM_UUID, { subjectId: "x", subjectType: "robot" }), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(422);
  });

  it("a member add on a cross-account team 404s", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, OTHER_ACCOUNT) } });
    const res = await handleAddTeamMember(memReq(ACCOUNT, TEAM_UUID, { subjectId: "usr_new" }), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(404);
  });

  it("removes a member + emits team.member.removed", async () => {
    const { repo, removedMembers } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const { events, eventsRepo } = makeEvents();
    const res = await handleRemoveTeamMember(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), "usr_new", { repo, eventsRepo });
    expect(res.status).toBe(200);
    expect(removedMembers).toEqual(["usr_new"]);
    expect(events.map((e) => e.type)).toContain("team.member.removed");
  });

  it("removing a non-member 404s", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) }, removeMissing: true });
    const res = await handleRemoveTeamMember(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), "ghost", { repo });
    expect(res.status).toBe(404);
  });

  it("lists members for an account admin", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) }, members: [member("usr_a"), member("sp_b", "service_principal")] });
    const res = await handleListTeamMembers(env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { members: unknown[] } };
    expect(json.data.members).toHaveLength(2);
  });
});

// teams-foundation TF2 — team-management roles: team_admin self-management,
// distinct from account-admin authority.
describe("teams: team-management roles (teams-foundation TF2)", () => {
  const memberBody = (subjectId: string, teamRole?: string) =>
    new Request(`http://mw/v1/organizations/${orgPublicId(ACCOUNT)}/teams/${teamPublicId(TEAM_UUID)}/members`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectId, ...(teamRole ? { teamRole } : {}) }),
    });

  it("an account_admin adds a member as team_admin (role persisted)", async () => {
    const { repo, addedMembers } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleAddTeamMember(memberBody("usr_new", "team_admin"), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(201);
    expect(addedMembers[0]!.teamRole).toBe("team_admin");
  });

  it("rejects an invalid teamRole on add (422)", async () => {
    const { repo, addedMembers } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleAddTeamMember(memberBody("usr_new", "owner"), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(422);
    expect(addedMembers).toHaveLength(0);
  });

  it("a team_admin (no account role) can add a member", async () => {
    const { repo, addedMembers } = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${ACCOUNT}|${ACTOR}`]: [] },   // NOT an account admin
      teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) },
      actorTeamRole: "team_admin",
    });
    const res = await handleAddTeamMember(memberBody("usr_new"), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(201);
    expect(addedMembers).toHaveLength(1);
  });

  it("a plain team_member cannot add a member (404)", async () => {
    const { repo, addedMembers } = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${ACCOUNT}|${ACTOR}`]: [] },
      teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) },
      actorTeamRole: "team_member",
    });
    const res = await handleAddTeamMember(memberBody("usr_new"), env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), { repo });
    expect(res.status).toBe(404);
    expect(addedMembers).toHaveLength(0);
  });

  it("a team_admin promotes another member + emits team.member.role_changed", async () => {
    const { repo, roleChanges } = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      roles: { [`${ACCOUNT}|${ACTOR}`]: [] },
      teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) },
      actorTeamRole: "team_admin",
    });
    const { events, eventsRepo } = makeEvents();
    const request = new Request(`http://mw/v1/organizations/${orgPublicId(ACCOUNT)}/teams/${teamPublicId(TEAM_UUID)}/members/usr_x`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamRole: "team_admin" }),
    });
    const res = await handleUpdateTeamMemberRole(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), "usr_x", { repo, eventsRepo, now: () => NOW });
    expect(res.status).toBe(200);
    expect(roleChanges).toEqual([{ subjectId: "usr_x", teamRole: "team_admin" }]);
    expect(events.map((e) => e.type)).toContain("team.member.role_changed");
  });

  it("rejects an invalid teamRole on role change (422)", async () => {
    const { repo, roleChanges } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const request = new Request(`http://mw/x`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamRole: "nope" }) });
    const res = await handleUpdateTeamMemberRole(request, env(), "r", actor, orgPublicId(ACCOUNT), teamPublicId(TEAM_UUID), "usr_x", { repo });
    expect(res.status).toBe(422);
    expect(roleChanges).toHaveLength(0);
  });
});

// teams-ownership TO3 — the "My Teams" lens.
describe("teams: my-teams (teams-ownership TO3)", () => {
  it("returns the caller's own team memberships", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, myTeamsList: [team(TEAM_UUID, ACCOUNT)] });
    const res = await handleMyTeams(env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { teams: Array<{ id: string }> } };
    expect(json.data.teams).toHaveLength(1);
    expect(json.data.teams[0]!.id).toBe(teamPublicId(TEAM_UUID));
  });

  it("404s an unknown org", async () => {
    const { repo } = makeRepo({ orgs: {}, myTeamsList: [] });
    const res = await handleMyTeams(env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(404);
  });
});
