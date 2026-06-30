import { handleListOrganizations } from "@membership-worker/handlers/list-organizations";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, Organization } from "@saas/db/membership";

function fakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
  } as unknown as Env;
}

const PARENT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function org(over: Partial<Organization> = {}): Organization {
  return {
    id: PARENT_UUID,
    name: "Acme",
    slug: "acme",
    slugLower: "acme",
    publicRef: "ws_PARENT00",
    status: "active",
    parentOrgId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

/** Repo returning a fixed page; records the ids passed to the batch lookup. */
function repoWith(items: Organization[]): {
  repo: Pick<MembershipRepository, "listOrganizationsForSubjectPaged" | "getOrganizationsByIds">;
  batchCalls: string[][];
} {
  const byId = new Map(items.map((o) => [o.id, o]));
  const batchCalls: string[][] = [];
  return {
    batchCalls,
    repo: {
      async listOrganizationsForSubjectPaged() {
        return { ok: true, value: { items, nextCursor: null } };
      },
      async getOrganizationsByIds(ids: string[]) {
        batchCalls.push(ids);
        const out: Array<{ id: string; publicRef: string }> = [];
        for (const id of ids) {
          const o = byId.get(id);
          if (o) out.push({ id: o.id, publicRef: o.publicRef });
        }
        return { ok: true, value: out };
      },
    },
  };
}

const actor = { subjectId: "usr_abc", subjectType: "user" };

describe("list-organizations handler (WID4 workspaceRef surface)", () => {
  it("projects workspaceRef/kind/isAccountRoot and accountId==self for a standalone org", async () => {
    const { repo, batchCalls } = repoWith([org()]);
    const res = await handleListOrganizations(fakeEnv(), "r1", actor, new URL("http://m/v1/organizations"), { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { organizations: Array<Record<string, unknown>> } };
    const o = body.data.organizations[0]!;
    expect(o.id).toMatch(/^org_[0-9a-f]{32}$/);
    expect(o.workspaceRef).toBe("ws_PARENT00");
    expect(o.kind).toBe("account");
    expect(o.isAccountRoot).toBe(true);
    expect(o.accountId).toBe("ws_PARENT00");
    // No parent lookup needed when the page has no children.
    expect(batchCalls).toHaveLength(0);
  });

  it("projects accountId as the parent's workspaceRef for a child org", async () => {
    const parent = org();
    const child = org({ id: CHILD_UUID, name: "Child", slug: "child", slugLower: "child", publicRef: "ws_CHILD001", parentOrgId: PARENT_UUID });
    const { repo, batchCalls } = repoWith([parent, child]);
    const res = await handleListOrganizations(fakeEnv(), "r2", actor, new URL("http://m/v1/organizations"), { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { organizations: Array<Record<string, unknown>> } };
    const byRef = new Map(body.data.organizations.map((o) => [o.workspaceRef, o]));

    const parentOut = byRef.get("ws_PARENT00")!;
    expect(parentOut.kind).toBe("account");
    expect(parentOut.isAccountRoot).toBe(true);
    expect(parentOut.accountId).toBe("ws_PARENT00");

    const childOut = byRef.get("ws_CHILD001")!;
    expect(childOut.kind).toBe("workspace");
    expect(childOut.isAccountRoot).toBe(false);
    expect(childOut.accountId).toBe("ws_PARENT00");

    // N+1 avoidance: the parent is already on the page, so its publicRef is
    // resolved locally with NO extra lookup at all.
    expect(batchCalls).toHaveLength(0);
  });

  it("batches DISTINCT parent ids in a single lookup across the page", async () => {
    const parent = org();
    const childA = org({ id: CHILD_UUID, name: "A", slug: "a", slugLower: "a", publicRef: "ws_CHILDAAA", parentOrgId: PARENT_UUID });
    const childB = org({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "B", slug: "b", slugLower: "b", publicRef: "ws_CHILDBBB", parentOrgId: PARENT_UUID });
    const { repo, batchCalls } = repoWith([parent, childA, childB]);
    const res = await handleListOrganizations(fakeEnv(), "r3", actor, new URL("http://m/v1/organizations"), { repo });
    expect(res.status).toBe(200);
    // Two children share one parent already present on the page -> no extra lookup.
    expect(batchCalls).toHaveLength(0);
  });

  it("looks up off-page parents once, deduplicated", async () => {
    // Two children of the same parent that is NOT on the page.
    const childA = org({ id: CHILD_UUID, name: "A", slug: "a", slugLower: "a", publicRef: "ws_CHILDAAA", parentOrgId: PARENT_UUID });
    const childB = org({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "B", slug: "b", slugLower: "b", publicRef: "ws_CHILDBBB", parentOrgId: PARENT_UUID });
    const parent = org(); // present in repo store but not on the returned page
    const { repo, batchCalls } = repoWith([childA, childB, parent]);
    // Return only the two children on the page.
    repo.listOrganizationsForSubjectPaged = async () => ({ ok: true, value: { items: [childA, childB], nextCursor: null } });

    const res = await handleListOrganizations(fakeEnv(), "r4", actor, new URL("http://m/v1/organizations"), { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { organizations: Array<Record<string, unknown>> } };
    for (const o of body.data.organizations) {
      expect(o.accountId).toBe("ws_PARENT00");
    }
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([PARENT_UUID]);
  });
});
