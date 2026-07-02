import { handleEffectiveAccess, handleOrgEffectiveAccess } from "@membership-worker/handlers/effective-access";
import { orgPublicId, teamPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization, RoleAssignment, Team } from "@saas/db/membership";
import { listEffectivePermissions, authorize } from "@saas/policy-engine";
import type { EffectivePermissionsRequest, AuthorizationRequest } from "@saas/contracts/policy";
import { teamRepoStubs } from "./team-repo-stubs.js";

const ACCOUNT = "00000000-0000-0000-0000-0000000000a1";
const TEAM_UUID = "00000000-0000-0000-0000-0000000000b1";
const TEAM_PUB = teamPublicId(TEAM_UUID);
const USER = "usr_teamonly";
const NOW = new Date("2026-02-01");

// Fake policy worker that runs the REAL engine over the effective-permissions body.
const policyFetcher = {
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (String(url).includes("/effective-permissions")) {
      const body = JSON.parse(init!.body as string) as EffectivePermissionsRequest;
      return Response.json({ data: listEffectivePermissions(body), meta: { requestId: "r", cursor: null } });
    }
    if (String(url).includes("/authorize")) {
      const body = JSON.parse(init!.body as string) as AuthorizationRequest;
      return Response.json({ data: authorize(body), meta: { requestId: "r", cursor: null } });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
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
function grant(orgId: string, subjectId: string, role: string, scopeKind: string): RoleAssignment {
  return { id: `ra-${role}`, orgId, subjectId, subjectType: "team", role, scopeKind, scopeRef: null, createdAt: NOW, revokedAt: null };
}

function makeRepo(cfg: {
  orgs: Record<string, Organization>;
  directRoles?: Record<string, RoleAssignment[]>;
  teamsFor?: Record<string, Team[]>;
  teamGrants?: Record<string, RoleAssignment[]>;
}): MembershipRepository {
  return {
    ...teamRepoStubs(),
    async getOrganizationById(id: string) {
      const o = cfg.orgs[id];
      return o ? { ok: true as const, value: o } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listRoleAssignments(orgId: string, subjectId: string) {
      return { ok: true as const, value: cfg.directRoles?.[`${orgId}|${subjectId}`] ?? [] };
    },
    async listTeamsForSubject(accountId: string, subjectId: string) {
      return { ok: true as const, value: cfg.teamsFor?.[`${accountId}|${subjectId}`] ?? [] };
    },
    async listRoleAssignmentsForSubjects(orgId: string, subjectIds: string[]) {
      const map = new Map<string, RoleAssignment[]>();
      for (const sid of subjectIds) map.set(sid, cfg.teamGrants?.[`${orgId}|${sid}`] ?? []);
      return { ok: true as const, value: map };
    },
  } as unknown as MembershipRepository;
}

function req(orgId: string, subjectId = USER, projectId?: string): Request {
  return new Request("http://mw/v1/internal/membership/effective-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: { type: "user", id: subjectId }, orgId, ...(projectId ? { projectId } : {}) }),
  });
}

type Perm = { action: string; allow: boolean; via?: { kind: string; teamId?: string } };

describe("effective-access (saas-teams TM6b2)", () => {
  it("attributes a team-derived permission to its team (via)", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      teamsFor: { [`${ACCOUNT}|${USER}`]: [team(TEAM_UUID, ACCOUNT)] },
      teamGrants: { [`${ACCOUNT}|${TEAM_PUB}`]: [grant(ACCOUNT, TEAM_PUB, "builder", "organization")] },
    });
    const res = await handleEffectiveAccess(req(ACCOUNT), env(), "r1", { repo });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { permissions: Perm[] } };
    const read = json.data.permissions.find((p) => p.action === "organization.read");
    expect(read?.allow).toBe(true);
    expect(read?.via).toEqual({ kind: "team", teamId: TEAM_PUB });
    // builder does NOT have organization.settings.update
    const settings = json.data.permissions.find((p) => p.action === "organization.settings.update");
    expect(settings?.allow).toBe(false);
    expect(settings?.via).toBeUndefined();
  });

  it("attributes a direct permission to a direct grant (via.kind = direct)", async () => {
    const directOwner: RoleAssignment = { id: "ra-o", orgId: ACCOUNT, subjectId: USER, subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: NOW, revokedAt: null };
    const repo = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      directRoles: { [`${ACCOUNT}|${USER}`]: [directOwner] },
    });
    const res = await handleEffectiveAccess(req(ACCOUNT), env(), "r2", { repo });
    const json = (await res.json()) as { data: { permissions: Perm[] } };
    const read = json.data.permissions.find((p) => p.action === "organization.read");
    expect(read?.allow).toBe(true);
    expect(read?.via).toEqual({ kind: "direct" });
  });

  it("returns all-denied (no via) for an actor with no grants", async () => {
    const repo = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) } });
    const res = await handleEffectiveAccess(req(ACCOUNT), env(), "r3", { repo });
    const json = (await res.json()) as { data: { permissions: Perm[] } };
    expect(json.data.permissions.length).toBeGreaterThan(0);
    expect(json.data.permissions.every((p) => p.allow === false && p.via === undefined)).toBe(true);
  });

  it("validates subject + orgId", async () => {
    const repo = makeRepo({ orgs: { [ACCOUNT]: org(ACCOUNT, null) } });
    const bad = new Request("http://mw/v1/internal/membership/effective-access", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: ACCOUNT }),
    });
    const res = await handleEffectiveAccess(bad, env(), "r4", { repo });
    expect(res.status).toBe(422);
  });
});

const OTHER = "usr_other";
function urlFor(orgUuid: string, q: Record<string, string> = {}): URL {
  const u = new URL(`http://mw/v1/organizations/${orgPublicId(orgUuid)}/effective-access`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u;
}
function ownerDirect(subjectId: string): RoleAssignment {
  return { id: "ra-o", orgId: ACCOUNT, subjectId, subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: NOW, revokedAt: null };
}
const actorPolicy = { subjectId: USER, subjectType: "user" };

describe("handleOrgEffectiveAccess (public, TM6b3)", () => {
  it("returns the CALLER's own effective access by default", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      teamsFor: { [`${ACCOUNT}|${USER}`]: [team(TEAM_UUID, ACCOUNT)] },
      teamGrants: { [`${ACCOUNT}|${TEAM_PUB}`]: [grant(ACCOUNT, TEAM_PUB, "builder", "organization")] },
    });
    const res = await handleOrgEffectiveAccess(env(), "r1", actorPolicy, orgPublicId(ACCOUNT), urlFor(ACCOUNT), { repo });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { permissions: Perm[] } };
    const read = json.data.permissions.find((p) => p.action === "organization.read");
    expect(read?.allow).toBe(true);
    expect(read?.via).toEqual({ kind: "team", teamId: TEAM_PUB });
  });

  it("an admin can view ANOTHER subject's access (?subjectId=)", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      directRoles: { [`${ACCOUNT}|${USER}`]: [ownerDirect(USER)] }, // caller is owner → has member.list
      teamsFor: { [`${ACCOUNT}|${OTHER}`]: [team(TEAM_UUID, ACCOUNT)] },
      teamGrants: { [`${ACCOUNT}|${TEAM_PUB}`]: [grant(ACCOUNT, TEAM_PUB, "builder", "organization")] },
    });
    const res = await handleOrgEffectiveAccess(env(), "r2", actorPolicy, orgPublicId(ACCOUNT), urlFor(ACCOUNT, { subjectId: OTHER }), { repo });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { permissions: Perm[] } };
    // OTHER's builder-via-team grant, not the caller's owner.
    const read = json.data.permissions.find((p) => p.action === "organization.read");
    expect(read?.via).toEqual({ kind: "team", teamId: TEAM_PUB });
  });

  it("a non-admin CANNOT view another subject's access (404)", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT]: org(ACCOUNT, null) },
      directRoles: { [`${ACCOUNT}|${USER}`]: [] }, // caller has no role → no member.list
    });
    const res = await handleOrgEffectiveAccess(env(), "r3", actorPolicy, orgPublicId(ACCOUNT), urlFor(ACCOUNT, { subjectId: OTHER }), { repo });
    expect(res.status).toBe(404);
  });
});
