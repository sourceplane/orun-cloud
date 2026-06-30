import { handleAuthorizationContext } from "@membership-worker/handlers/authorization-context";
import { mapRoleAssignmentsToFacts } from "@membership-worker/membership-facts";
import type { MembershipRepository, RoleAssignment } from "@saas/db/membership";
import type { Env } from "@membership-worker/env";

function createFakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
    ...overrides,
  };
}

function createFakeRepo(roleAssignments: RoleAssignment[] = []): MembershipRepository {
  return {
    async listRoleAssignments() {
      return { ok: true, value: roleAssignments };
    },
    async bootstrapOrganization() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async createOrganization() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async getOrganizationById() { return { ok: false, error: { kind: "not_found" as const } }; },
    async getOrganizationsByIds() { return { ok: true, value: [] }; },
    async getOrganizationBySlug() { return { ok: false, error: { kind: "not_found" as const } }; },
    async getOrganizationByPublicRef() { return { ok: false, error: { kind: "not_found" as const } }; },
    async listOrganizationsForSubject() { return { ok: true, value: [] }; },
    async listOrganizationsWithRoleForSubject() { return { ok: true, value: [] }; },
    async listOrganizationsForSubjectPaged() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async createMember() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async getMemberById() { return { ok: false, error: { kind: "not_found" as const } }; },
    async listMembers() { return { ok: true, value: [] }; },
    async listMembersPaged() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async removeMember() { return { ok: false, error: { kind: "not_found" as const } }; },
    async createInvitation() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async getInvitationById() { return { ok: false, error: { kind: "not_found" as const } }; },
    async getInvitationByTokenHash() { return { ok: false, error: { kind: "not_found" as const } }; },
    async listInvitations() { return { ok: true, value: [] }; },
    async listInvitationsPaged() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async revokeInvitation() { return { ok: false, error: { kind: "not_found" as const } }; },
    async acceptInvitation() { return { ok: false, error: { kind: "not_found" as const } }; },
    async createRoleAssignment() { return { ok: false, error: { kind: "internal" as const, message: "not implemented" } }; },
    async revokeRoleAssignment() { return { ok: false, error: { kind: "not_found" as const } }; },
    async revokeAllRoleAssignments() { return { ok: true, value: [] }; },
    async countActiveOwners() { return { ok: true, value: 0 }; },
    async countBillableMembers() { return { ok: true, value: 0 }; },
    async listChildOrganizations() { return { ok: true as const, value: [] }; },
    async setOrganizationStatus() { return { ok: false as const, error: { kind: "not_found" as const } }; },
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://membership-worker/v1/internal/membership/authorization-context", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeInvalidJsonRequest(): Request {
  return new Request("http://membership-worker/v1/internal/membership/authorization-context", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
}

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const SUBJECT_ID = "usr_abc123";

describe("membership-worker: authorization-context internal route", () => {
  describe("successful requests", () => {
    it("returns organization-scoped membership facts", async () => {
      const roles: RoleAssignment[] = [
        {
          id: "ra-001",
          orgId: ORG_ID,
          subjectId: SUBJECT_ID,
          subjectType: "user",
          role: "admin",
          scopeKind: "organization",
          scopeRef: null,
          createdAt: new Date("2026-01-01"),
          revokedAt: null,
        },
      ];
      const repo = createFakeRepo(roles);
      const env = createFakeEnv();
      const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-1", { repo });
      expect(res.status).toBe(200);

      const json = await res.json() as { data: { memberships: unknown[] } };
      expect(json.data.memberships).toHaveLength(1);
      expect(json.data.memberships[0]).toEqual({
        kind: "role_assignment",
        role: "admin",
        scope: { kind: "organization", orgId: ORG_ID },
      });
    });

    it("returns project-scoped membership facts with scopeRef as projectId", async () => {
      const projectRef = "prj-uuid-123";
      const roles: RoleAssignment[] = [
        {
          id: "ra-002",
          orgId: ORG_ID,
          subjectId: SUBJECT_ID,
          subjectType: "user",
          role: "project_builder",
          scopeKind: "project",
          scopeRef: projectRef,
          createdAt: new Date("2026-01-01"),
          revokedAt: null,
        },
      ];
      const repo = createFakeRepo(roles);
      const env = createFakeEnv();
      const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-2", { repo });
      expect(res.status).toBe(200);

      const json = await res.json() as { data: { memberships: unknown[] } };
      expect(json.data.memberships).toHaveLength(1);
      expect(json.data.memberships[0]).toEqual({
        kind: "role_assignment",
        role: "project_builder",
        scope: { kind: "project", orgId: ORG_ID, projectId: projectRef },
      });
    });

    it("returns empty memberships when no role assignments exist", async () => {
      const repo = createFakeRepo([]);
      const env = createFakeEnv();
      const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-3", { repo });
      expect(res.status).toBe(200);

      const json = await res.json() as { data: { memberships: unknown[] } };
      expect(json.data.memberships).toHaveLength(0);
    });

    it("response does not include raw role-assignment IDs or member IDs", async () => {
      const roles: RoleAssignment[] = [
        {
          id: "ra-secret-id",
          orgId: ORG_ID,
          subjectId: SUBJECT_ID,
          subjectType: "user",
          role: "owner",
          scopeKind: "organization",
          scopeRef: null,
          createdAt: new Date("2026-01-01"),
          revokedAt: null,
        },
      ];
      const repo = createFakeRepo(roles);
      const env = createFakeEnv();
      const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-4", { repo });
      const text = await res.text();
      expect(text).not.toContain("ra-secret-id");
      expect(text).not.toContain("subjectId");
    });
  });

  describe("validation failures", () => {
    it("returns 422 for invalid JSON body", async () => {
      const env = createFakeEnv();
      const repo = createFakeRepo();
      const req = makeInvalidJsonRequest();

      const res = await handleAuthorizationContext(req, env, "req-5", { repo });
      expect(res.status).toBe(422);

      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe("validation_failed");
    });

    it("returns 422 when subject is missing", async () => {
      const env = createFakeEnv();
      const repo = createFakeRepo();
      const req = makeRequest({ orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-6", { repo });
      expect(res.status).toBe(422);
    });

    it("returns 422 when subject.type is invalid", async () => {
      const env = createFakeEnv();
      const repo = createFakeRepo();
      const req = makeRequest({ subject: { type: "invalid", id: "x" }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-7", { repo });
      expect(res.status).toBe(422);
    });

    it("returns 422 when subject.id is empty", async () => {
      const env = createFakeEnv();
      const repo = createFakeRepo();
      const req = makeRequest({ subject: { type: "user", id: "" }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-8", { repo });
      expect(res.status).toBe(422);
    });

    it("returns 422 when orgId is missing", async () => {
      const env = createFakeEnv();
      const repo = createFakeRepo();
      const req = makeRequest({ subject: { type: "user", id: "usr_1" } });

      const res = await handleAuthorizationContext(req, env, "req-9", { repo });
      expect(res.status).toBe(422);
    });

    it("returns 422 when orgId is empty string", async () => {
      const env = createFakeEnv();
      const repo = createFakeRepo();
      const req = makeRequest({ subject: { type: "user", id: "usr_1" }, orgId: "" });

      const res = await handleAuthorizationContext(req, env, "req-10", { repo });
      expect(res.status).toBe(422);
    });
  });

  describe("unsupported method handling", () => {
    it("returns 405 for GET method on internal route", async () => {
      const { route } = await import("@membership-worker/router");
      const env = createFakeEnv();
      const req = new Request("http://membership-worker/v1/internal/membership/authorization-context", {
        method: "GET",
      });

      const res = await route(req, env);
      expect(res.status).toBe(405);

      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe("unsupported");
    });
  });

  describe("missing DB binding", () => {
    it("returns 503 when PLATFORM_DB is missing", async () => {
      const env: Env = { ENVIRONMENT: "test" };
      const req = makeRequest({ subject: { type: "user", id: "usr_1" }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-11");
      expect(res.status).toBe(503);

      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe("internal_error");
    });
  });

  describe("repository failure", () => {
    it("returns 500 when repository fails", async () => {
      const failRepo: MembershipRepository = {
        ...createFakeRepo(),
        async listRoleAssignments() {
          return { ok: false, error: { kind: "internal" as const, message: "db error" } };
        },
      };
      const env = createFakeEnv();
      const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: ORG_ID });

      const res = await handleAuthorizationContext(req, env, "req-12", { repo: failRepo });
      expect(res.status).toBe(500);

      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe("internal_error");
    });
  });
});

describe("membership-facts: mapRoleAssignmentsToFacts", () => {
  it("maps organization-scoped assignments", () => {
    const assignments: RoleAssignment[] = [
      {
        id: "ra-1",
        orgId: "org-1",
        subjectId: "usr-1",
        subjectType: "user",
        role: "admin",
        scopeKind: "organization",
        scopeRef: null,
        createdAt: new Date(),
        revokedAt: null,
      },
    ];
    const facts = mapRoleAssignmentsToFacts("org-1", assignments);
    expect(facts).toEqual([
      { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: "org-1" } },
    ]);
  });

  it("maps project-scoped assignments using scopeRef as projectId", () => {
    const assignments: RoleAssignment[] = [
      {
        id: "ra-2",
        orgId: "org-1",
        subjectId: "usr-1",
        subjectType: "user",
        role: "project_viewer",
        scopeKind: "project",
        scopeRef: "prj-uuid-1",
        createdAt: new Date(),
        revokedAt: null,
      },
    ];
    const facts = mapRoleAssignmentsToFacts("org-1", assignments);
    expect(facts).toEqual([
      { kind: "role_assignment", role: "project_viewer", scope: { kind: "project", orgId: "org-1", projectId: "prj-uuid-1" } },
    ]);
  });

  it("maps project scopeKind with null scopeRef as project-scoped without projectId", () => {
    const assignments: RoleAssignment[] = [
      {
        id: "ra-3",
        orgId: "org-1",
        subjectId: "usr-1",
        subjectType: "user",
        role: "builder",
        scopeKind: "project",
        scopeRef: null,
        createdAt: new Date(),
        revokedAt: null,
      },
    ];
    const facts = mapRoleAssignmentsToFacts("org-1", assignments);
    expect(facts[0]!.scope.kind).toBe("project");
    expect(facts[0]!.scope.projectId).toBeUndefined();
  });
});

// ── Account-scoped RBAC cascade assembly (saas-workspace-id WID6 §8.2) ──
describe("authorization-context: account-scoped RBAC cascade", () => {
  const ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000a1";
  const CHILD_UUID = "00000000-0000-0000-0000-0000000000c1";
  const UNRELATED_ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000b2";

  function org(id: string, parentOrgId: string | null): import("@saas/db/membership").Organization {
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

  function makeRoleRepo(opts: {
    orgs: Record<string, import("@saas/db/membership").Organization>;
    roles: Record<string, RoleAssignment[]>; // key: orgUuid
  }): MembershipRepository {
    return {
      ...createFakeRepo(),
      async getOrganizationById(id: string) {
        const found = opts.orgs[id];
        return found ? { ok: true as const, value: found } : { ok: false as const, error: { kind: "not_found" as const } };
      },
      async listRoleAssignments(orgId: string) {
        return { ok: true as const, value: opts.roles[orgId] ?? [] };
      },
    };
  }

  function accountAssignment(orgUuid: string): RoleAssignment {
    return {
      id: "ra-acct-1",
      orgId: orgUuid,
      subjectId: SUBJECT_ID,
      subjectType: "user",
      role: "account_admin",
      scopeKind: "account",
      scopeRef: null,
      createdAt: new Date("2026-01-01"),
      revokedAt: null,
    };
  }

  it("cascades account_admin onto a child workspace whose account the actor manages", async () => {
    const repo = makeRoleRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      roles: {
        [CHILD_UUID]: [], // actor is NOT a direct member of the child
        [ACCOUNT_UUID]: [accountAssignment(ACCOUNT_UUID)],
      },
    });
    const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: CHILD_UUID });
    const res = await handleAuthorizationContext(req, createFakeEnv(), "req-casc-1", { repo });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { memberships: unknown[] } };
    expect(json.data.memberships).toContainEqual({
      kind: "role_assignment",
      role: "account_admin",
      scope: { kind: "account", orgId: CHILD_UUID }, // remapped onto the child
    });
  });

  it("does NOT cascade an account role from an unrelated account", async () => {
    const repo = makeRoleRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      roles: {
        [CHILD_UUID]: [],
        [ACCOUNT_UUID]: [], // actor holds no account role here
        [UNRELATED_ACCOUNT_UUID]: [accountAssignment(UNRELATED_ACCOUNT_UUID)],
      },
    });
    const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: CHILD_UUID });
    const res = await handleAuthorizationContext(req, createFakeEnv(), "req-casc-2", { repo });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { memberships: unknown[] } };
    expect(json.data.memberships).toHaveLength(0);
  });

  it("preserves account-scope rows when the target IS the account root", async () => {
    const repo = makeRoleRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      roles: { [ACCOUNT_UUID]: [accountAssignment(ACCOUNT_UUID)] },
    });
    const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: ACCOUNT_UUID });
    const res = await handleAuthorizationContext(req, createFakeEnv(), "req-casc-3", { repo });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { memberships: unknown[] } };
    // exactly one fact, account-scoped, stamped with the account org id (no dup)
    expect(json.data.memberships).toEqual([
      { kind: "role_assignment", role: "account_admin", scope: { kind: "account", orgId: ACCOUNT_UUID } },
    ]);
  });

  it("fails soft to org/project facts when the org fetch fails", async () => {
    const orgRole: RoleAssignment = {
      id: "ra-org-1",
      orgId: CHILD_UUID,
      subjectId: SUBJECT_ID,
      subjectType: "user",
      role: "viewer",
      scopeKind: "organization",
      scopeRef: null,
      createdAt: new Date("2026-01-01"),
      revokedAt: null,
    };
    const repo: MembershipRepository = {
      ...createFakeRepo([orgRole]),
      async getOrganizationById() {
        return { ok: false as const, error: { kind: "not_found" as const } };
      },
    };
    const req = makeRequest({ subject: { type: "user", id: SUBJECT_ID }, orgId: CHILD_UUID });
    const res = await handleAuthorizationContext(req, createFakeEnv(), "req-casc-4", { repo });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { memberships: unknown[] } };
    expect(json.data.memberships).toEqual([
      { kind: "role_assignment", role: "viewer", scope: { kind: "organization", orgId: CHILD_UUID } },
    ]);
  });
});

describe("membership-facts: account-scoped assignments (WID6)", () => {
  it("preserves account scope kind, stamped with the target orgId", () => {
    const assignments: RoleAssignment[] = [
      {
        id: "ra-a",
        orgId: "account-org",
        subjectId: "usr-1",
        subjectType: "user",
        role: "account_admin",
        scopeKind: "account",
        scopeRef: null,
        createdAt: new Date(),
        revokedAt: null,
      },
    ];
    const facts = mapRoleAssignmentsToFacts("target-org", assignments);
    expect(facts).toEqual([
      { kind: "role_assignment", role: "account_admin", scope: { kind: "account", orgId: "target-org" } },
    ]);
  });
});
