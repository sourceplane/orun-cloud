import { handleListOwnerHandles, handleSetOwnerHandle, handleDeleteOwnerHandle, handleResolveOwners } from "@membership-worker/handlers/owner-handles";
import { orgPublicId, teamPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization, RoleAssignment, Team, TeamOwnerHandle, UpsertTeamOwnerHandleInput } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";
import { teamRepoStubs } from "./team-repo-stubs.js";

const ACCOUNT = "00000000-0000-0000-0000-0000000000a1";
const TEAM_UUID = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ACCOUNT = "00000000-0000-0000-0000-0000000000f9";
const ACTOR = "usr_actor1";
const TEAM_PUB = teamPublicId(TEAM_UUID);
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
  return { id, accountOrgId, name: "Platform", slugLower: "platform", handle: "platform", description: null, avatarRef: null, status: "active", createdAt: NOW, updatedAt: NOW };
}
function accountRole(role: string): RoleAssignment {
  return { id: "ra", orgId: ACCOUNT, subjectId: ACTOR, subjectType: "user", role, scopeKind: "account", scopeRef: null, createdAt: NOW, revokedAt: null };
}
function ownerHandle(h: string): TeamOwnerHandle {
  return { accountOrgId: ACCOUNT, ownerHandle: h, teamId: TEAM_PUB, createdAt: NOW, updatedAt: NOW };
}

function makeRepo(cfg: {
  orgs: Record<string, Organization>;
  roles?: Record<string, RoleAssignment[]>;
  teams?: Record<string, Team>;
  handles?: TeamOwnerHandle[];
  teamsList?: Team[];
  aliases?: TeamOwnerHandle[];
  deleteMissing?: boolean;
}): { repo: MembershipRepository; upserts: UpsertTeamOwnerHandleInput[]; deletes: string[] } {
  const upserts: UpsertTeamOwnerHandleInput[] = [];
  const deletes: string[] = [];
  const repo = {
    ...teamRepoStubs(),
    async getOrganizationById(id: string) {
      const o = cfg.orgs[id];
      return o ? { ok: true as const, value: o } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listRoleAssignments(orgId: string, subjectId: string) {
      return { ok: true as const, value: cfg.roles?.[`${orgId}|${subjectId}`] ?? [] };
    },
    async getTeamById(id: string) {
      const t = cfg.teams?.[id];
      return t ? { ok: true as const, value: t } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listTeamOwnerHandles() {
      return { ok: true as const, value: cfg.handles ?? [] };
    },
    async listTeams() {
      return { ok: true as const, value: cfg.teamsList ?? [] };
    },
    async resolveTeamOwnerHandles(_accountOrgId: string, keys: string[]) {
      const rows = (cfg.aliases ?? []).filter((a) => keys.includes(a.ownerHandle.toLowerCase()));
      return { ok: true as const, value: rows };
    },
    async upsertTeamOwnerHandle(input: UpsertTeamOwnerHandleInput) {
      upserts.push(input);
      return { ok: true as const, value: ownerHandle(input.ownerHandle) };
    },
    async deleteTeamOwnerHandle(_accountOrgId: string, handle: string) {
      if (cfg.deleteMissing) return { ok: false as const, error: { kind: "not_found" as const } };
      deletes.push(handle);
      return { ok: true as const, value: ownerHandle(handle) };
    },
  } as unknown as MembershipRepository;
  return { repo, upserts, deletes };
}

function makeEvents(): { events: string[]; eventsRepo: Pick<EventsRepository, "appendEventWithAudit"> } {
  const events: string[] = [];
  const eventsRepo = {
    async appendEventWithAudit(input: { event: { type: string } }) {
      events.push(input.event.type);
      return { ok: true as const, value: { event: input.event, audit: {} } as never };
    },
  } as Pick<EventsRepository, "appendEventWithAudit">;
  return { events, eventsRepo };
}

const actor = { subjectId: ACTOR, subjectType: "user" };
const admins = { [`${ACCOUNT}|${ACTOR}`]: [accountRole("account_admin")] };
function setReq(body: unknown): Request {
  return new Request(`http://mw/v1/organizations/${orgPublicId(ACCOUNT)}/owner-handles`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("owner-handles: list (teams-ownership TO1)", () => {
  it("an account_admin lists the aliases", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, handles: [ownerHandle("payments")] });
    const res = await handleListOwnerHandles(env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { ownerHandles: unknown[] } };
    expect(json.data.ownerHandles).toHaveLength(1);
  });
});

describe("owner-handles: set (teams-ownership TO1)", () => {
  it("an account_admin aliases an owner string to a live team + emits team.owner_handle.set", async () => {
    const { repo, upserts } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const { events, eventsRepo } = makeEvents();
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "legacy-payments", teamId: TEAM_PUB }), env(), "r", actor, orgPublicId(ACCOUNT), { repo, eventsRepo });
    expect(res.status).toBe(201);
    expect(upserts[0]!.ownerHandle).toBe("legacy-payments");
    expect(upserts[0]!.teamId).toBe(TEAM_PUB);
    expect(events).toContain("team.owner_handle.set");
  });

  it("strips a group:/team: prefix before storing (TO-B)", async () => {
    const { repo, upserts } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "group:Payments", teamId: TEAM_PUB }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(201);
    expect(upserts[0]!.ownerHandle).toBe("Payments");
  });

  it("a non-admin cannot set an alias (404)", async () => {
    const { repo, upserts } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [] }, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "payments", teamId: TEAM_PUB }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(404);
    expect(upserts).toHaveLength(0);
  });

  it("rejects aliasing to a team in another account (404)", async () => {
    const { repo, upserts } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, OTHER_ACCOUNT) } });
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "payments", teamId: TEAM_PUB }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(404);
    expect(upserts).toHaveLength(0);
  });

  it("rejects a soft-deleted team (404)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: { ...team(TEAM_UUID, ACCOUNT), status: "deleted" } } });
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "payments", teamId: TEAM_PUB }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed team id (422)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins });
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "payments", teamId: "nope" }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(422);
  });

  it("rejects an empty owner string (422)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, teams: { [TEAM_UUID]: team(TEAM_UUID, ACCOUNT) } });
    const res = await handleSetOwnerHandle(setReq({ ownerHandle: "  ", teamId: TEAM_PUB }), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(422);
  });
});

describe("resolve-owners (teams-ownership TO2)", () => {
  function resolveReq(owners: string[]): Request {
    return new Request(`http://mw/v1/organizations/${orgPublicId(ACCOUNT)}/resolve-owners`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owners }),
    });
  }
  type Res = { owner: string; state: string; teamId?: string; name?: string };
  async function resolve(repo: MembershipRepository, owners: string[]): Promise<Res[]> {
    const res = await handleResolveOwners(resolveReq(owners), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(200);
    return (await res.json() as { data: { resolutions: Res[] } }).data.resolutions;
  }

  it("resolves by handle (convention), by alias, and marks unmapped / unowned", async () => {
    const { repo } = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      roles: admins,
      teamsList: [team(TEAM_UUID, ACCOUNT)],                 // handle 'platform'
      aliases: [ownerHandle("legacy-platform")],            // alias → TEAM_PUB
    });
    const out = await resolve(repo, ["platform", "group:platform", "legacy-platform", "nobody", ""]);
    // by handle (bare + prefixed both normalize to 'platform')
    expect(out[0]).toMatchObject({ owner: "platform", state: "owned", teamId: TEAM_PUB, name: "Platform" });
    expect(out[1]).toMatchObject({ owner: "group:platform", state: "owned", teamId: TEAM_PUB });
    // by alias
    expect(out[2]).toMatchObject({ owner: "legacy-platform", state: "owned", teamId: TEAM_PUB });
    // declared but unmapped
    expect(out[3]).toMatchObject({ owner: "nobody", state: "unmapped" });
    // no owner
    expect(out[4]).toMatchObject({ owner: "", state: "unowned" });
  });

  it("a non-member cannot resolve (404)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: { [`${ACCOUNT}|${ACTOR}`]: [] }, teamsList: [team(TEAM_UUID, ACCOUNT)] });
    const res = await handleResolveOwners(resolveReq(["platform"]), env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(404);
  });

  it("rejects a non-array body (422)", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins });
    const req = new Request(`http://mw/v1/organizations/${orgPublicId(ACCOUNT)}/resolve-owners`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owners: "x" }),
    });
    const res = await handleResolveOwners(req, env(), "r", actor, orgPublicId(ACCOUNT), { repo });
    expect(res.status).toBe(422);
  });
});

describe("owner-handles: delete (teams-ownership TO1)", () => {
  it("an account_admin removes an alias + emits team.owner_handle.removed", async () => {
    const { repo, deletes } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins });
    const { events, eventsRepo } = makeEvents();
    const res = await handleDeleteOwnerHandle(env(), "r", actor, orgPublicId(ACCOUNT), "payments", { repo, eventsRepo });
    expect(res.status).toBe(200);
    expect(deletes).toEqual(["payments"]);
    expect(events).toContain("team.owner_handle.removed");
  });

  it("returns 404 when the alias is absent", async () => {
    const { repo } = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) }, roles: admins, deleteMissing: true });
    const res = await handleDeleteOwnerHandle(env(), "r", actor, orgPublicId(ACCOUNT), "ghost", { repo });
    expect(res.status).toBe(404);
  });
});
