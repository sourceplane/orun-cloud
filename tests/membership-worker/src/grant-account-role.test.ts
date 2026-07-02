import { handleGrantAccountRole } from "@membership-worker/handlers/grant-account-role";
import { orgPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type {
  MembershipRepository,
  Organization,
  RoleAssignment,
  CreateRoleAssignmentInput,
} from "@saas/db/membership";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";

const ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000a1";
const CHILD_UUID = "00000000-0000-0000-0000-0000000000c1";
const ACTOR_ID = "usr_actor1";
const GRANTEE_ID = "usr_grantee1";

// A Fetcher that runs the REAL policy engine over the request body, so the grant
// gate is genuinely exercised (a workspace-only admin must be denied).
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

function accountRole(orgUuid: string, subjectId: string, role: string): RoleAssignment {
  return {
    id: "ra-acct",
    orgId: orgUuid,
    subjectId,
    subjectType: "user",
    role,
    scopeKind: "account",
    scopeRef: null,
    createdAt: new Date("2026-01-01"),
    revokedAt: null,
  };
}

function orgRole(orgUuid: string, subjectId: string, role: string): RoleAssignment {
  return {
    id: "ra-org",
    orgId: orgUuid,
    subjectId,
    subjectType: "user",
    role,
    scopeKind: "organization",
    scopeRef: null,
    createdAt: new Date("2026-01-01"),
    revokedAt: null,
  };
}

type GrantRepo = Pick<
  MembershipRepository,
  "getOrganizationById" | "listRoleAssignments" | "createRoleAssignment"
>;

function makeRepo(opts: {
  orgs: Record<string, Organization>;
  roles: Record<string, RoleAssignment[]>;
}): { repo: GrantRepo; created: CreateRoleAssignmentInput[] } {
  const created: CreateRoleAssignmentInput[] = [];
  const repo = {
    async getOrganizationById(id: string) {
      const found = opts.orgs[id];
      return found
        ? { ok: true as const, value: found }
        : { ok: false as const, error: { kind: "not_found" as const } };
    },
    async listRoleAssignments(orgId: string, subjectId: string) {
      const all = opts.roles[orgId] ?? [];
      return { ok: true as const, value: all.filter((r) => r.subjectId === subjectId) };
    },
    async createRoleAssignment(input: CreateRoleAssignmentInput) {
      created.push(input);
      return {
        ok: true as const,
        value: {
          id: input.id,
          orgId: input.orgId,
          subjectId: input.subjectId,
          subjectType: input.subjectType,
          role: input.role,
          scopeKind: input.scopeKind,
          scopeRef: input.scopeRef ?? null,
          createdAt: input.createdAt,
          revokedAt: null,
        },
      };
    },
  };
  return { repo, created };
}

function makeRequest(orgUuid: string, body: unknown): Request {
  return new Request(`http://membership-worker/v1/organizations/${orgPublicId(orgUuid)}/account-roles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const actor = { subjectId: ACTOR_ID, subjectType: "user" };

describe("grant-account-role (saas-workspace-id WID6)", () => {
  it("an account_admin can grant an account role (written on the account org, scope=account)", async () => {
    const { repo, created } = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      roles: { [ACCOUNT_UUID]: [accountRole(ACCOUNT_UUID, ACTOR_ID, "account_admin")] },
    });
    const req = makeRequest(ACCOUNT_UUID, { role: "account_billing_admin", subjectId: GRANTEE_ID });
    const res = await handleGrantAccountRole(req, createFakeEnv(), "req-1", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0]!.orgId).toBe(ACCOUNT_UUID);
    expect(created[0]!.scopeKind).toBe("account");
    expect(created[0]!.role).toBe("account_billing_admin");
    expect(created[0]!.subjectId).toBe(GRANTEE_ID);
  });

  it("an org owner of the account can grant an account role", async () => {
    const { repo, created } = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      roles: { [ACCOUNT_UUID]: [orgRole(ACCOUNT_UUID, ACTOR_ID, "owner")] },
    });
    const req = makeRequest(ACCOUNT_UUID, { role: "account_admin", subjectId: GRANTEE_ID });
    const res = await handleGrantAccountRole(req, createFakeEnv(), "req-2", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  it("a workspace-only admin CANNOT grant an account role", async () => {
    // Actor is admin on the CHILD workspace only — no role on the account org.
    const { repo, created } = makeRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      roles: {
        [CHILD_UUID]: [orgRole(CHILD_UUID, ACTOR_ID, "admin")],
        [ACCOUNT_UUID]: [], // nothing on the account
      },
    });
    // Grant is attempted while targeting the child; the handler resolves up to
    // the account and gates on the account org, where the actor has no role.
    const req = makeRequest(CHILD_UUID, { role: "account_admin", subjectId: GRANTEE_ID });
    const res = await handleGrantAccountRole(req, createFakeEnv(), "req-3", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404); // denied (surfaced as not_found)
    expect(created).toHaveLength(0);
  });

  it("rejects an invalid (non-account) role", async () => {
    const { repo } = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      roles: { [ACCOUNT_UUID]: [accountRole(ACCOUNT_UUID, ACTOR_ID, "account_admin")] },
    });
    const req = makeRequest(ACCOUNT_UUID, { role: "admin", subjectId: GRANTEE_ID });
    const res = await handleGrantAccountRole(req, createFakeEnv(), "req-4", actor, orgPublicId(ACCOUNT_UUID), { repo });
    expect(res.status).toBe(422);
  });
});

describe("grant-account-role audit (saas-teams TM4b2 backfill)", () => {
  it("emits account.role.granted when an events sink is provided", async () => {
    const { repo } = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      roles: { [ACCOUNT_UUID]: [accountRole(ACCOUNT_UUID, ACTOR_ID, "account_admin")] },
    });
    const events: Array<{ type: string }> = [];
    const eventsRepo = {
      async appendEventWithAudit(input: { event: { type: string } }) {
        events.push({ type: input.event.type });
        return { ok: true as const, value: { event: input.event, audit: {} } as never };
      },
    };
    const req = makeRequest(ACCOUNT_UUID, { role: "account_admin", subjectId: GRANTEE_ID });
    const res = await handleGrantAccountRole(req, createFakeEnv(), "req-a", actor, orgPublicId(ACCOUNT_UUID), { repo, eventsRepo });
    expect(res.status).toBe(201);
    expect(events.map((e) => e.type)).toContain("account.role.granted");
  });
});
