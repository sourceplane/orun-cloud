import { handleGrantTeamRole } from "@membership-worker/handlers/grant-team-role";
import { handleRevokeTeamRole } from "@membership-worker/handlers/revoke-team-role";
import { orgPublicId, teamPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type {
  MembershipRepository,
  Organization,
  RoleAssignment,
  Team,
  CreateRoleAssignmentInput,
} from "@saas/db/membership";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";

const ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000a1";
const CHILD_UUID = "00000000-0000-0000-0000-0000000000c1";
const TEAM_UUID = "00000000-0000-0000-0000-0000000000t1".replace(/t/g, "b"); // valid hex
const OTHER_ACCOUNT = "00000000-0000-0000-0000-0000000000f9";
const ACTOR_ID = "usr_actor1";
const TEAM_PUB = teamPublicId(TEAM_UUID);

// Real policy engine over the request body, so the grant gate is genuinely exercised.
const policyFetcher = {
  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(init!.body as string) as AuthorizationRequest;
    return Response.json({ data: authorize(body), meta: { requestId: "r", cursor: null } });
  },
} as unknown as Fetcher;

function createFakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
    POLICY_WORKER: policyFetcher,
  };
}

function org(id: string, parentOrgId: string | null): Organization {
  return {
    id, name: "n", slug: "s", slugLower: "s", publicRef: "ws_TESTREF1",
    status: "active", parentOrgId,
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  };
}

function team(accountOrgId: string): Team {
  return {
    id: TEAM_UUID, accountOrgId, name: "Platform", slugLower: "platform",
    status: "active", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  };
}

function role(orgUuid: string, subjectId: string, r: string, scopeKind: string): RoleAssignment {
  return {
    id: "ra-x", orgId: orgUuid, subjectId, subjectType: "user", role: r,
    scopeKind, scopeRef: null, createdAt: new Date("2026-01-01"), revokedAt: null,
  };
}

type Repo = Pick<
  MembershipRepository,
  "getOrganizationById" | "getTeamById" | "listRoleAssignments" | "createRoleAssignment" | "revokeTeamGrant"
>;

function makeRepo(opts: {
  orgs: Record<string, Organization>;
  teams?: Record<string, Team>;
  roles: Record<string, RoleAssignment[]>;
}): { repo: Repo; created: CreateRoleAssignmentInput[]; revoked: unknown[] } {
  const created: CreateRoleAssignmentInput[] = [];
  const revoked: unknown[] = [];
  const repo: Repo = {
    async getOrganizationById(id: string) {
      const found = opts.orgs[id];
      return found ? { ok: true as const, value: found } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async getTeamById(id: string) {
      const found = opts.teams?.[id];
      return found ? { ok: true as const, value: found } : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listRoleAssignments(orgId: string, subjectId: string) {
      const all = opts.roles[orgId] ?? [];
      return { ok: true as const, value: all.filter((r) => r.subjectId === subjectId) };
    },
    async createRoleAssignment(input: CreateRoleAssignmentInput) {
      created.push(input);
      return {
        ok: true as const,
        value: { id: input.id, orgId: input.orgId, subjectId: input.subjectId, subjectType: input.subjectType,
          role: input.role, scopeKind: input.scopeKind, scopeRef: input.scopeRef ?? null, createdAt: input.createdAt, revokedAt: null },
      };
    },
    async revokeTeamGrant(orgId, teamPub, r, scopeKind, scopeRef) {
      const key = { orgId, teamPub, r, scopeKind, scopeRef };
      const match = revoked.length === 0; // first call matches; used to assert not_found path via empty
      revoked.push(key);
      return match
        ? { ok: true as const, value: role(orgId as string, teamPub, r, scopeKind) }
        : { ok: false as const, error: { kind: "not_found" as const } };
    },
  };
  return { repo, created, revoked };
}

function grantReq(orgUuid: string, body: unknown, method = "POST"): Request {
  return new Request(`http://mw/v1/organizations/${orgPublicId(orgUuid)}/team-roles`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

const actor = { subjectId: ACTOR_ID, subjectType: "user" };

describe("grant-team-role (saas-teams TM2)", () => {
  it("an account_admin grants a team an account role (written on the account org, scope=account)", async () => {
    const { repo, created } = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [ACCOUNT_UUID]: [role(ACCOUNT_UUID, ACTOR_ID, "account_admin", "account")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(ACCOUNT_UUID, { teamId: TEAM_PUB, role: "account_admin", scopeKind: "account" }),
      createFakeEnv(), "r1", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0]!.subjectType).toBe("team");
    expect(created[0]!.subjectId).toBe(TEAM_PUB);
    expect(created[0]!.orgId).toBe(ACCOUNT_UUID);
    expect(created[0]!.scopeKind).toBe("account");
  });

  it("an org admin grants a team an org role on the workspace (scope=organization)", async () => {
    const { repo, created } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "builder", scopeKind: "organization" }),
      createFakeEnv(), "r2", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(201);
    expect(created[0]!.orgId).toBe(CHILD_UUID);
    expect(created[0]!.scopeKind).toBe("organization");
    expect(created[0]!.role).toBe("builder");
  });

  it("an org admin grants a team a project role with scopeRef (scope=project)", async () => {
    const { repo, created } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "project_builder", scopeKind: "project", scopeRef: "proj_1" }),
      createFakeEnv(), "r3", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(201);
    expect(created[0]!.scopeKind).toBe("project");
    expect(created[0]!.scopeRef).toBe("proj_1");
  });

  it("a workspace-only admin CANNOT grant a team an account role", async () => {
    const { repo, created } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID), [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")], [ACCOUNT_UUID]: [] },
    });
    const res = await handleGrantTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "account_admin", scopeKind: "account" }),
      createFakeEnv(), "r4", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it("rejects a role that does not match the scope (422)", async () => {
    const { repo } = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [ACCOUNT_UUID]: [role(ACCOUNT_UUID, ACTOR_ID, "account_admin", "account")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(ACCOUNT_UUID, { teamId: TEAM_PUB, role: "builder", scopeKind: "account" }),
      createFakeEnv(), "r5", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(422);
  });

  it("rejects a project grant missing scopeRef (422)", async () => {
    const { repo } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "project_builder", scopeKind: "project" }),
      createFakeEnv(), "r6", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(422);
  });

  it("rejects granting a team that belongs to another account (404)", async () => {
    const { repo, created } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(OTHER_ACCOUNT) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "builder", scopeKind: "organization" }),
      createFakeEnv(), "r7", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it("rejects a malformed team id (422)", async () => {
    const { repo } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")] },
    });
    const res = await handleGrantTeamRole(
      grantReq(CHILD_UUID, { teamId: "not-a-team", role: "builder", scopeKind: "organization" }),
      createFakeEnv(), "r8", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(422);
  });
});

describe("revoke-team-role (saas-teams TM2)", () => {
  it("an org admin revokes an org-scope team grant (200)", async () => {
    const { repo } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "admin", "organization")] },
    });
    const res = await handleRevokeTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "builder", scopeKind: "organization" }, "DELETE"),
      createFakeEnv(), "r9", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(200);
  });

  it("a non-admin cannot revoke (404)", async () => {
    const { repo } = makeRepo({
      orgs: { [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID) },
      teams: { [TEAM_UUID]: team(ACCOUNT_UUID) },
      roles: { [CHILD_UUID]: [role(CHILD_UUID, ACTOR_ID, "viewer", "organization")] },
    });
    const res = await handleRevokeTeamRole(
      grantReq(CHILD_UUID, { teamId: TEAM_PUB, role: "builder", scopeKind: "organization" }, "DELETE"),
      createFakeEnv(), "r10", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404);
  });
});
