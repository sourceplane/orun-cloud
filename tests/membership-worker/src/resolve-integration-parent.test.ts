import { handleResolveIntegrationParent } from "@membership-worker/handlers/resolve-integration-parent";
import type { Env } from "@membership-worker/env";
import type { Organization, MembershipResult } from "@saas/db/membership";

const env = { ENVIRONMENT: "test" } as Env;
const CHILD_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";
const CHILD_PUB = "org_2f65ddde1f5b4e938c0b80e030e31229";
const PARENT_HEX = "11111111-1111-1111-1111-111111111111";
const PARENT_PUB = "org_11111111111111111111111111111111";

function org(id: string, parentOrgId: string | null, publicRef: string, name: string): Organization {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    slugLower: name.toLowerCase(),
    publicRef,
    status: "active",
    parentOrgId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function req(orgId: string): Request {
  return new Request("https://m/v1/internal/membership/organizations/integration-parent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
}

/** getOrganizationById keyed by hex id, so child→parent both resolve. */
function depsFor(byId: Record<string, Organization>) {
  return {
    repo: {
      getOrganizationById: async (id: string): Promise<MembershipResult<Organization>> =>
        byId[id] ? { ok: true, value: byId[id]! } : { ok: false, error: { kind: "not_found" as const } },
    },
  };
}

describe("handleResolveIntegrationParent", () => {
  it("returns account: null for a standalone / account-root org", async () => {
    const res = await handleResolveIntegrationParent(
      req(CHILD_PUB),
      env,
      "req",
      depsFor({ [CHILD_HEX]: org(CHILD_HEX, null, "ws_CHILD000", "Solo") }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isChild: boolean; account: unknown } };
    expect(body.data.isChild).toBe(false);
    expect(body.data.account).toBeNull();
  });

  it("returns the Account (ws_ + name) for a child org", async () => {
    const res = await handleResolveIntegrationParent(
      req(CHILD_PUB),
      env,
      "req",
      depsFor({
        [CHILD_HEX]: org(CHILD_HEX, PARENT_HEX, "ws_CHILD000", "Team A"),
        [PARENT_HEX]: org(PARENT_HEX, null, "ws_ACME9999", "Acme"),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { isChild: boolean; account: { orgId: string; workspaceRef: string; name: string } };
    };
    expect(body.data.isChild).toBe(true);
    expect(body.data.account.orgId).toBe(PARENT_PUB);
    expect(body.data.account.workspaceRef).toBe("ws_ACME9999");
    expect(body.data.account.name).toBe("Acme");
  });

  it("404 when the org is not found", async () => {
    const res = await handleResolveIntegrationParent(req(CHILD_PUB), env, "req", depsFor({}));
    expect(res.status).toBe(404);
  });

  it("400 on a malformed orgId", async () => {
    const res = await handleResolveIntegrationParent(req("not-an-org"), env, "req", depsFor({}));
    expect(res.status).toBe(400);
  });
});
