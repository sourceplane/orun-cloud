import { handleListAccountMembers } from "@membership-worker/handlers/list-account-members";
import { orgPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type {
  MembershipRepository,
  Organization,
  OrganizationMember,
  RoleAssignment,
} from "@saas/db/membership";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";

const ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000a1";
const CHILD_UUID = "00000000-0000-0000-0000-0000000000c1";
const ACTOR_ID = "usr_actor1";

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

function member(subjectId: string, status = "active"): OrganizationMember {
  return {
    id: `mem-${subjectId}`,
    orgId: ACCOUNT_UUID,
    subjectId,
    subjectType: "user",
    status,
    createdAt: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-01"),
  };
}

function accountRole(subjectId: string, role: string, subjectType = "user"): RoleAssignment {
  return {
    id: `ra-${subjectId}-${role}`,
    orgId: ACCOUNT_UUID,
    subjectId,
    subjectType,
    role,
    scopeKind: "account",
    scopeRef: null,
    createdAt: new Date("2026-01-01"),
    revokedAt: null,
  };
}

type Repo = Pick<
  MembershipRepository,
  "getOrganizationById" | "listRoleAssignments" | "listMembers" | "listAccountRoleAssignments"
>;

function makeRepo(opts: {
  orgs: Record<string, Organization>;
  actorRoles: Record<string, RoleAssignment[]>;
  members?: OrganizationMember[];
  accountAssignments?: RoleAssignment[];
}): Repo {
  return {
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
    async listMembers(orgId: string) {
      return { ok: true as const, value: (opts.members ?? []).filter((m) => m.orgId === orgId) };
    },
    async listAccountRoleAssignments(accountOrgId: string) {
      return {
        ok: true as const,
        value: (opts.accountAssignments ?? []).filter((a) => a.orgId === accountOrgId),
      };
    },
  };
}

const actor = { subjectId: ACTOR_ID, subjectType: "user" };
const actorIsAccountAdmin = {
  [ACCOUNT_UUID]: [accountRole(ACTOR_ID, "account_admin")],
};

async function rosterFor(repo: Repo, orgUuid: string): Promise<Array<Record<string, unknown>>> {
  const res = await handleListAccountMembers(createFakeEnv(), "req", actor, orgPublicId(orgUuid), { repo });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { members: Array<Record<string, unknown>> } };
  return body.data.members;
}

describe("list-account-members (teams-hub TH1b — derived roster, no new table)", () => {
  it("unions root-org members and account-role holders, tagged by origin", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      members: [member("usr_plain")],
      accountAssignments: [
        accountRole(ACTOR_ID, "account_admin"), // cascade admin, NOT an org member
      ],
    });
    const roster = await rosterFor(repo, ACCOUNT_UUID);
    expect(roster).toHaveLength(2);
    expect(roster.find((r) => r.subjectId === "usr_plain")).toMatchObject({
      origin: "member",
      status: "active",
      accountRoles: [],
    });
    // The legibility gap: a cascade admin who appears in NO member list is
    // visible on the account roster, labeled by what they hold.
    expect(roster.find((r) => r.subjectId === ACTOR_ID)).toMatchObject({
      origin: "account_role",
      accountRoles: ["account_admin"],
    });
  });

  it("a subject who is both a member and an account-role holder is one row, origin=both", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      members: [member("usr_dual")],
      accountAssignments: [
        accountRole("usr_dual", "account_billing_admin"),
        accountRole("usr_dual", "account_admin"),
      ],
    });
    const roster = await rosterFor(repo, ACCOUNT_UUID);
    const dual = roster.filter((r) => r.subjectId === "usr_dual");
    expect(dual).toHaveLength(1);
    expect(dual[0]).toMatchObject({
      origin: "both",
      status: "active",
      accountRoles: ["account_billing_admin", "account_admin"],
    });
  });

  it("excludes team grants (people roster) and inactive members", async () => {
    const repo = makeRepo({
      orgs: { [ACCOUNT_UUID]: org(ACCOUNT_UUID, null) },
      actorRoles: actorIsAccountAdmin,
      members: [member("usr_gone", "removed")],
      accountAssignments: [
        accountRole("team_0011223344556677889900aabbccddee", "account_admin", "team"),
      ],
    });
    const roster = await rosterFor(repo, ACCOUNT_UUID);
    expect(roster).toHaveLength(0);
  });

  it("targeting a child workspace resolves up to the account roster", async () => {
    const repo = makeRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      actorRoles: actorIsAccountAdmin,
      members: [member("usr_root_member")],
    });
    const roster = await rosterFor(repo, CHILD_UUID);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.subjectId).toBe("usr_root_member");
  });

  it("a workspace-only admin is denied (404, resource not disclosed)", async () => {
    const workspaceAdmin: RoleAssignment = {
      id: "ra-ws",
      orgId: CHILD_UUID,
      subjectId: ACTOR_ID,
      subjectType: "user",
      role: "admin",
      scopeKind: "organization",
      scopeRef: null,
      createdAt: new Date("2026-01-01"),
      revokedAt: null,
    };
    const repo = makeRepo({
      orgs: {
        [CHILD_UUID]: org(CHILD_UUID, ACCOUNT_UUID),
        [ACCOUNT_UUID]: org(ACCOUNT_UUID, null),
      },
      actorRoles: { [CHILD_UUID]: [workspaceAdmin], [ACCOUNT_UUID]: [] },
      members: [member("usr_hidden")],
    });
    const res = await handleListAccountMembers(createFakeEnv(), "req-deny", actor, orgPublicId(CHILD_UUID), { repo });
    expect(res.status).toBe(404);
  });
});
