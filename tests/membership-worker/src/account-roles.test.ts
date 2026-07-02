import { handleListAccountRoles } from "@membership-worker/handlers/list-account-roles";
import { handleRevokeAccountRole } from "@membership-worker/handlers/revoke-account-role";
import { orgPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization, RoleAssignment } from "@saas/db/membership";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";

const ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000a1";
const CHILD_UUID = "00000000-0000-0000-0000-0000000000c1";
const ACTOR_ID = "usr_actor1";
const HOLDER_ID = "usr_holder1";

// A Fetcher that runs the REAL policy engine, so the gates are genuinely
// exercised (a workspace-only admin must be denied on the account).
const policyFetcher = {
  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(init!.body as string) as AuthorizationRequest;
    const result = authorize(body);
    return Response.json({ data: result, meta: { requestId: "r", cursor: null } });
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
    id,
    name: "n",
    slug: "s",
    slugLower: "s",
    publicRef: "ws_TESTREF1",
    status: "active",
    parentOrgId,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function assignment(overrides: Partial<RoleAssignment>): RoleAssignment {
  return {
    id: "ra-1",
    orgId: ACCOUNT_UUID,
    subjectId: HOLDER_ID,
    subjectType: "user",
    role: "account_admin",
    scopeKind: "account",
    scopeRef: null,
    createdAt: new Date("2026-01-01"),
    revokedAt: null,
    ...overrides,
  };
}

type ListRepo = Pick<
  MembershipRepository,
  "getOrganizationById" | "listRoleAssignments" | "listAccountRoleAssignments"
>;
type RevokeRepo = Pick<
  MembershipRepository,
  "getOrganizationById" | "listRoleAssignments" | "revokeAccountRole"
>;

function makeRepo(opts: {
  orgs: Record<string, Organization>;
  actorRoles: Record<string, RoleAssignment[]>;
  accountAssignments?: RoleAssignment[];
}): ListRepo & RevokeRepo & { revoked: Array<{ subjectId: string; role: string; orgId: string }> } {
  const revoked: Array<{ subjectId: string; role: string; orgId: string }> = [];
  return {
    revoked,
    async getOrganizationById(id: string) {
      const found = opts.orgs[id];
      return found
        ? { ok: true as const, value: found }
        : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listRoleAssignments(orgId: string, subjectId: string) {
      const all = opts.actorRoles[orgId] ?? [];
      return { ok: true as const, value: all.filter((r) => r.subjectId === subjectId) };
    },
    async listAccountRoleAssignments(accountOrgId: string) {
      return {
        ok: true as const,
        value: (opts.accountAssignments ?? []).filter((a) => a.orgId === accountOrgId),
      };
    },
    async revokeAccountRole(accountOrgId: string, subjectId: string, role: string, revokedAt: Date) {
      const found = (opts.accountAssignments ?? []).find(
        (a) => a.orgId === accountOrgId && a.subjectId === subjectId && a.role === role && a.subjectType === "user",
      );
      if (!found) return { ok: false as const, error: { kind: "not_found" as const } };
      revoked.push({ subjectId, role, orgId: accountOrgId });
      return { ok: true as const, value: { ...found, revokedAt } };
    },
  };
}

const actor = { subjectId: ACTOR_ID, subjectType: "user" };

const actorIsAccountAdmin = {
  [ACCOUNT_UUID]: [assignment({ id: "ra-actor", subjectId: ACTOR_ID, role: "account_admin" })],
};

function revokeRequest(orgUuid: string, body: unknown): Request {
  return new Request(`http://membership-worker/v1/organizations/${orgPublicId(orgUuid)}/account-roles`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("list-account-roles (teams-hub TH1a)", () => {
  it("an account_admin sees the account's active account-scope assignments (users AND teams)", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      accountAssignments: [
        assignment({ id: "ra-u", subjectId: HOLDER_ID, role: "account_billing_admin" }),
        assignment({ id: "ra-t", subjectId: "team_0011223344556677889900aabbccddee", subjectType: "team", role: "account_admin" }),
      ],
    });
    const res = await handleListAccountRoles(createFakeEnv(), "req-1", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { assignments: Array<Record<string, unknown>> } };
    expect(body.data.assignments).toHaveLength(2);
    expect(body.data.assignments[0]).toMatchObject({
      subjectId: HOLDER_ID,
      subjectType: "user",
      role: "account_billing_admin",
    });
    expect(body.data.assignments[1]).toMatchObject({ subjectType: "team", role: "account_admin" });
  });

  it("targeting a child workspace resolves up to the account (same rows)", async () => {
    const repo = makeRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      actorRoles: actorIsAccountAdmin,
      accountAssignments: [assignment({ id: "ra-u", subjectId: HOLDER_ID })],
    });
    const res = await handleListAccountRoles(createFakeEnv(), "req-2", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { assignments: Array<Record<string, unknown>> } };
    expect(body.data.assignments).toHaveLength(1);
  });

  it("a workspace-only admin is denied (404, resource not disclosed)", async () => {
    const repo = makeRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      actorRoles: {
        [CHILD_UUID]: [assignment({ id: "ra-a", subjectId: ACTOR_ID, role: "admin", scopeKind: "organization", orgId: CHILD_UUID })],
        [ACCOUNT_UUID]: [],
      },
      accountAssignments: [assignment({})],
    });
    const res = await handleListAccountRoles(createFakeEnv(), "req-3", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404);
  });
});

describe("revoke-account-role (teams-hub TH1a)", () => {
  it("an account_admin revokes a user's account role on the account org", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      accountAssignments: [assignment({ subjectId: HOLDER_ID, role: "account_billing_admin" })],
    });
    const req = revokeRequest(ACCOUNT_UUID, { subjectId: HOLDER_ID, role: "account_billing_admin" });
    const res = await handleRevokeAccountRole(req, createFakeEnv(), "req-4", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(200);
    expect(repo.revoked).toEqual([
      { subjectId: HOLDER_ID, role: "account_billing_admin", orgId: ACCOUNT_UUID },
    ]);
    const body = (await res.json()) as { data: { assignment: Record<string, unknown> } };
    expect(body.data.assignment).toMatchObject({ subjectId: HOLDER_ID, revoked: true });
  });

  it("emits account.role.revoked when an events sink is provided", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      accountAssignments: [assignment({ subjectId: HOLDER_ID, role: "account_admin" })],
    });
    const events: Array<{ type: string }> = [];
    const eventsRepo = {
      async appendEventWithAudit(input: { event: { type: string } }) {
        events.push({ type: input.event.type });
        return { ok: true as const, value: { event: input.event, audit: {} } as never };
      },
    };
    const req = revokeRequest(ACCOUNT_UUID, { subjectId: HOLDER_ID, role: "account_admin" });
    const res = await handleRevokeAccountRole(req, createFakeEnv(), "req-5", actor, orgPublicId(ACCOUNT_UUID), { repo, eventsRepo });
    expect(res.status).toBe(200);
    expect(events.map((e) => e.type)).toContain("account.role.revoked");
  });

  it("404 when no active grant matches the (subject, role) tuple", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      accountAssignments: [],
    });
    const req = revokeRequest(ACCOUNT_UUID, { subjectId: HOLDER_ID, role: "account_admin" });
    const res = await handleRevokeAccountRole(req, createFakeEnv(), "req-6", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid (non-account) role", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      accountAssignments: [assignment({})],
    });
    const req = revokeRequest(ACCOUNT_UUID, { subjectId: HOLDER_ID, role: "admin" });
    const res = await handleRevokeAccountRole(req, createFakeEnv(), "req-7", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(422);
  });

  it("a workspace-only admin CANNOT revoke an account role", async () => {
    const repo = makeRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      actorRoles: {
        [CHILD_UUID]: [assignment({ id: "ra-a", subjectId: ACTOR_ID, role: "admin", scopeKind: "organization", orgId: CHILD_UUID })],
        [ACCOUNT_UUID]: [],
      },
      accountAssignments: [assignment({ subjectId: HOLDER_ID })],
    });
    const req = revokeRequest(CHILD_UUID, { subjectId: HOLDER_ID, role: "account_admin" });
    const res = await handleRevokeAccountRole(req, createFakeEnv(), "req-8", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404);
    expect(repo.revoked).toHaveLength(0);
  });
});
