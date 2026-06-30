import { handleSubjectOrgs } from "@membership-worker/handlers/subject-orgs";
import type { MembershipRepository, OrganizationWithRole } from "@saas/db/membership";
import type { Env } from "@membership-worker/env";

function fakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
  };
}

function repoWith(orgs: OrganizationWithRole[]): MembershipRepository {
  return {
    async listOrganizationsWithRoleForSubject() {
      return { ok: true, value: orgs };
    },
  } as unknown as MembershipRepository;
}

const ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function org(over: Partial<OrganizationWithRole> = {}): OrganizationWithRole {
  return {
    id: ORG_UUID,
    name: "Acme",
    slug: "acme",
    slugLower: "acme",
    publicRef: "ws_3KF9TQ2P",
    status: "active",
    parentOrgId: null,
    role: "admin",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("subject-orgs handler (OP1)", () => {
  function req(body: unknown): Request {
    return new Request("http://membership-worker/v1/internal/membership/subject-orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns the subject's orgs with public ids and roles", async () => {
    const res = await handleSubjectOrgs(req({ subject: { type: "user", id: "usr_abc" } }), fakeEnv(), "r1", {
      repo: repoWith([org()]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { orgs: Array<{ id: string; workspaceRef: string; slug: string; name: string; role: string }> };
    };
    expect(body.data.orgs).toHaveLength(1);
    expect(body.data.orgs[0]!.id).toMatch(/^org_[0-9a-f]{32}$/);
    // WID5: the durable Workspace ID is projected alongside the legacy id.
    expect(body.data.orgs[0]!.workspaceRef).toBe("ws_3KF9TQ2P");
    expect(body.data.orgs[0]!.slug).toBe("acme");
    expect(body.data.orgs[0]!.role).toBe("admin");
  });

  it("filters out non-active orgs", async () => {
    const res = await handleSubjectOrgs(req({ subject: { type: "user", id: "usr_abc" } }), fakeEnv(), "r2", {
      repo: repoWith([org({ status: "suspended" })]),
    });
    const body = (await res.json()) as { data: { orgs: unknown[] } };
    expect(body.data.orgs).toHaveLength(0);
  });

  it("validates the subject", async () => {
    const res = await handleSubjectOrgs(req({}), fakeEnv(), "r3", { repo: repoWith([]) });
    expect(res.status).toBe(422);
  });
});
