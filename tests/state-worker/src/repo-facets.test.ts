// WO5 — the org repo-facet read model endpoints. Verifies the projected repo
// self-descriptions map to public ids (incl. doc_ref), the per-project get
// returns a single facet, a policy denial resource-hides as 404, and the routes
// are dispatched top-level (outside the /state/ contract-version gate).

import { handleListOrgRepoFacets, handleGetOrgRepoFacet, handleGetOrgCatalogDoc } from "@state-worker/handlers/repo-facets";
import { route } from "@state-worker/router";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const PROJECT_PUBLIC = `prj_${PROJECT.replace(/-/g, "")}`;
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function membershipFetcher(): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) =>
      String(input).includes("authorization-context")
        ? Promise.resolve(
            Response.json({
              data: { memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } }] },
            }),
          )
        : Promise.resolve(new Response(null, { status: 404 })),
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}
function policyFetcher(allow: boolean): Fetcher {
  return { fetch: () => Promise.resolve(Response.json({ data: { allow } })), connect() { throw new Error("ni"); } } as unknown as Fetcher;
}
function createEnv(allow = true): Env {
  return { ENVIRONMENT: "test", PLATFORM_DB: {}, MEMBERSHIP_WORKER: membershipFetcher(), POLICY_WORKER: policyFetcher(allow) } as unknown as Env;
}

function facetRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    org_id: ORG,
    source_project_id: PROJECT,
    display_name: "Orun Platform",
    description: "The platform",
    owner: "group:platform",
    default_branch: null,
    links: JSON.stringify([{ title: "Runbook", url: "https://x", icon: "book" }]),
    tags: JSON.stringify(["saas"]),
    doc_ref: JSON.stringify({ path: "docs/overview.md", digest: "sha256:" + "d".repeat(64) }),
    entity_ref: "default/orun/orun",
    head_digest: "sha256:" + "a".repeat(64),
    source_commit: "abc123",
    synced_at: "2026-06-17T10:00:00.000Z",
    ...over,
  };
}

function executorFor(rows: Record<string, unknown>[]): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      const out = text.includes("FROM state.repo_facet") ? rows : [];
      return Promise.resolve({ rows: out as unknown as T[], rowCount: out.length });
    },
  } as unknown as SqlExecutor;
}

describe("GET /v1/organizations/{orgId}/repo-facets (WO5)", () => {
  it("returns the repo facets with public ids and doc_ref", async () => {
    const res = await handleListOrgRepoFacets(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/repo-facets`),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG),
      { executor: executorFor([facetRow()]) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { repoFacets: Array<Record<string, unknown>> } };
    expect(body.data.repoFacets).toHaveLength(1);
    const f = body.data.repoFacets[0]!;
    expect(f.orgId).toBe(ORG_PUBLIC);
    expect(f.projectId).toBe(PROJECT_PUBLIC); // sourceProjectId → public prj_
    expect(f.displayName).toBe("Orun Platform");
    expect(f.owner).toBe("group:platform");
    expect(f.links).toEqual([{ title: "Runbook", url: "https://x", icon: "book" }]);
    expect(f.docRef).toEqual({ path: "docs/overview.md", digest: "sha256:" + "d".repeat(64) });
    expect(f.entityRef).toBe("default/orun/orun");
  });

  it("returns a single facet for the per-project get", async () => {
    const res = await handleGetOrgRepoFacet(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/repo-facets/${PROJECT_PUBLIC}`),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      { executor: executorFor([facetRow()]) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { repoFacet: Record<string, unknown> | null } };
    expect(body.data.repoFacet?.projectId).toBe(PROJECT_PUBLIC);
  });

  it("returns null when no facet is projected for the project", async () => {
    const res = await handleGetOrgRepoFacet(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/repo-facets/${PROJECT_PUBLIC}`),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      { executor: executorFor([]) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { repoFacet: unknown } };
    expect(body.data.repoFacet).toBeNull();
  });

  it("404s (resource-hiding) when policy denies", async () => {
    const res = await handleListOrgRepoFacets(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/repo-facets`),
      createEnv(false),
      "req_2",
      ACTOR,
      asUuid(ORG),
      { executor: executorFor([facetRow()]) },
    );
    expect(res.status).toBe(404);
  });
});

describe("route() — repo-facet endpoints are reachable top-level", () => {
  it("dispatches /repo-facets to the handler, not Route-not-found", async () => {
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/repo-facets`, {
      headers: { "x-actor-subject-id": ACTOR.subjectId, "x-actor-subject-type": ACTOR.subjectType },
    });
    const res = await route(req, createEnv(false)); // policy denies → 404, but route was found
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toContain("Route not found");
  });
});

// ── GET /v1/organizations/{orgId}/catalog/doc (WO5 overview doc read) ──

function framedBlob(kind: string, body: string): Uint8Array {
  const enc = new TextEncoder();
  const bodyBytes = enc.encode(body);
  const header = enc.encode(`${kind} ${bodyBytes.length}\x00`);
  const out = new Uint8Array(header.length + bodyBytes.length);
  out.set(header, 0);
  out.set(bodyBytes, header.length);
  return out;
}

function envWithBucket(allow: boolean, key: string | null, framed: Uint8Array): Env {
  return {
    ...createEnv(allow),
    ORUN_STATE: {
      get: (k: string) =>
        key !== null && k === key
          ? Promise.resolve({ arrayBuffer: () => Promise.resolve(framed.buffer) })
          : Promise.resolve(null),
    },
  } as unknown as Env;
}

describe("GET /v1/organizations/{orgId}/catalog/doc (WO5)", () => {
  const DIGEST = "sha256:" + "d".repeat(64);
  const MD = "# Ogpic\n\nPhotography rental.";
  const KEY = `state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/objects/${DIGEST}`;

  it("serves the DEFRAMED markdown for a digest referenced by the org catalog", async () => {
    const res = await handleGetOrgCatalogDoc(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/doc?digest=${encodeURIComponent(DIGEST)}`),
      envWithBucket(true, KEY, framedBlob("blob", MD)),
      "req_1",
      ACTOR,
      asUuid(ORG),
      { executor: executorFor([{ source_project_id: PROJECT }]) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(MD); // frame header stripped
  });

  it("404s a digest that is not a doc_ref in the org catalog", async () => {
    const res = await handleGetOrgCatalogDoc(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/doc?digest=${encodeURIComponent(DIGEST)}`),
      envWithBucket(true, null, framedBlob("blob", MD)),
      "req_2",
      ACTOR,
      asUuid(ORG),
      { executor: executorFor([]) }, // findCatalogDocProject → no row
    );
    expect(res.status).toBe(404);
  });

  it("resource-hides as 404 on policy denial", async () => {
    const res = await handleGetOrgCatalogDoc(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/doc?digest=${encodeURIComponent(DIGEST)}`),
      envWithBucket(false, KEY, framedBlob("blob", MD)),
      "req_3",
      ACTOR,
      asUuid(ORG),
      { executor: executorFor([{ source_project_id: PROJECT }]) },
    );
    expect(res.status).toBe(404);
  });

  it("404s an invalid digest", async () => {
    const res = await handleGetOrgCatalogDoc(
      new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/doc?digest=not-a-digest`),
      envWithBucket(true, KEY, framedBlob("blob", MD)),
      "req_4",
      ACTOR,
      asUuid(ORG),
      { executor: executorFor([{ source_project_id: PROJECT }]) },
    );
    expect(res.status).toBe(404);
  });
});
