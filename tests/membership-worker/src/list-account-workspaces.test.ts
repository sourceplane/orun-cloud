import { handleListAccountWorkspaces } from "@membership-worker/handlers/list-account-workspaces";
import { orgPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization, RoleAssignment } from "@saas/db/membership";
import { authorize } from "@saas/policy-engine";
import type { AuthorizationRequest } from "@saas/contracts/policy";

const ACCOUNT_UUID = "00000000-0000-0000-0000-0000000000a1";
const CHILD1_UUID = "00000000-0000-0000-0000-0000000000c1";
const CHILD2_UUID = "00000000-0000-0000-0000-0000000000c2";
const ACTOR = { subjectId: "usr_admin1", subjectType: "user" };

// Real policy engine over the request body, so the read gate is genuinely exercised.
const policyFetcher = {
  async fetch(_url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(init!.body as string) as AuthorizationRequest;
    return Response.json({ data: authorize(body), meta: { requestId: "r", cursor: null } });
  },
} as unknown as Fetcher;

const env = { ENVIRONMENT: "test", PLATFORM_DB: {}, POLICY_WORKER: policyFetcher } as unknown as Env;

function org(id: string, parentOrgId: string | null, publicRef: string, name: string): Organization {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    slugLower: name.toLowerCase(),
    publicRef,
    status: "active",
    parentOrgId,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function adminRole(orgUuid: string, subjectId: string): RoleAssignment {
  return {
    id: "ra",
    orgId: orgUuid,
    subjectId,
    subjectType: "user",
    role: "admin",
    scopeKind: "organization",
    scopeRef: null,
    createdAt: new Date("2026-01-01"),
    revokedAt: null,
  };
}

function repoFor(roles: RoleAssignment[], children: Organization[]) {
  return {
    repo: {
      listRoleAssignments: async () => ({ ok: true as const, value: roles }),
      listChildOrganizations: async () => ({ ok: true as const, value: children }),
    } as Pick<MembershipRepository, "listRoleAssignments" | "listChildOrganizations">,
  };
}

describe("handleListAccountWorkspaces (IT12)", () => {
  it("lists the account's child workspaces for an account admin", async () => {
    const res = await handleListAccountWorkspaces(
      env,
      "req",
      ACTOR,
      orgPublicId(ACCOUNT_UUID),
      repoFor([adminRole(ACCOUNT_UUID, ACTOR.subjectId)], [
        org(CHILD1_UUID, ACCOUNT_UUID, "ws_TEAMA111", "Team A"),
        org(CHILD2_UUID, ACCOUNT_UUID, "ws_TEAMB222", "Team B"),
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { workspaces: Array<{ orgId: string; workspaceRef: string; name: string }> };
    };
    expect(body.data.workspaces).toHaveLength(2);
    expect(body.data.workspaces[0]!.workspaceRef).toBe("ws_TEAMA111");
    expect(body.data.workspaces[0]!.orgId).toBe(orgPublicId(CHILD1_UUID));
    expect(body.data.workspaces[1]!.name).toBe("Team B");
  });

  it("returns an empty list for an account with no children", async () => {
    const res = await handleListAccountWorkspaces(
      env,
      "req",
      ACTOR,
      orgPublicId(ACCOUNT_UUID),
      repoFor([adminRole(ACCOUNT_UUID, ACTOR.subjectId)], []),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { workspaces: unknown[] } };
    expect(body.data.workspaces).toEqual([]);
  });

  it("denies a subject without a role on the account (404, no disclosure)", async () => {
    const res = await handleListAccountWorkspaces(
      env,
      "req",
      ACTOR,
      orgPublicId(ACCOUNT_UUID),
      repoFor([], [org(CHILD1_UUID, ACCOUNT_UUID, "ws_TEAMA111", "Team A")]),
    );
    expect(res.status).toBe(404);
  });

  it("404 on a malformed account id", async () => {
    const res = await handleListAccountWorkspaces(
      env,
      "req",
      ACTOR,
      "not-an-org",
      repoFor([adminRole(ACCOUNT_UUID, ACTOR.subjectId)], []),
    );
    expect(res.status).toBe(404);
  });
});
