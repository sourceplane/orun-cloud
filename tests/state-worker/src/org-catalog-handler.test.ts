// OV6 — the org-global catalog browser endpoint. Verifies the merged graph maps
// to public ids with provenance, the optional repo/env/facet filters reach the
// query, validation rejects malformed filters, and a policy denial resource-hides
// as a 404.

import { handleListOrgCatalogEntities } from "@state-worker/handlers/catalog";
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

function entityRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "oce1",
    org_id: ORG,
    entity_ref: "component:default/api",
    kind: "Component",
    name: "api",
    owner: "team-platform",
    lifecycle: "production",
    relations: JSON.stringify([{ type: "dependsOn", targetRef: "component:default/db" }]),
    source_project_id: PROJECT,
    source_environment: null,
    source_commit: "abc123",
    head_digest: "sha256:" + "a".repeat(64),
    created_at: "2026-06-17T10:00:00.000Z",
    updated_at: "2026-06-17T10:00:00.000Z",
    ...over,
  };
}

// Captures the org-catalog SELECT so we can assert the filters reached the query.
function capturingExecutor(rows: Record<string, unknown>[]): { executor: SqlExecutor; queries: Array<{ text: string; params: unknown[] }> } {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params });
      const out = text.includes("FROM state.org_catalog_entities") ? rows : [];
      return Promise.resolve({ rows: out as unknown as T[], rowCount: out.length });
    },
  } as unknown as SqlExecutor;
  return { executor, queries };
}

function req(qs = ""): Request {
  return new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/entities${qs}`);
}

describe("GET /v1/organizations/{orgId}/catalog/entities (OV6)", () => {
  it("returns the merged graph with public ids and provenance", async () => {
    const { executor } = capturingExecutor([entityRow()]);
    const res = await handleListOrgCatalogEntities(req(), createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entities: Array<Record<string, unknown>> } };
    expect(body.data.entities).toHaveLength(1);
    const e = body.data.entities[0]!;
    expect(e.orgId).toBe(ORG_PUBLIC);
    expect(e.sourceProjectId).toBe(PROJECT_PUBLIC); // provenance projected to a public id
    expect(e.sourceEnvironment).toBeNull();
    expect(e.sourceCommit).toBe("abc123");
    expect(e.relations).toEqual([{ type: "dependsOn", targetRef: "component:default/db" }]);
  });

  it("pushes the project/env/kind/owner/q filters into the query", async () => {
    const { executor, queries } = capturingExecutor([entityRow()]);
    await handleListOrgCatalogEntities(
      req(`?project=${PROJECT_PUBLIC}&environment=prod&kind=Component&owner=team-platform&q=api`),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG),
      { executor },
    );
    const select = queries.find((q) => q.text.includes("FROM state.org_catalog_entities"))!;
    expect(select.text).toContain("source_project_id");
    expect(select.text).toContain("source_environment =");
    expect(select.text).toContain("kind =");
    expect(select.text).toContain("owner =");
    expect(select.text).toContain("ILIKE");
    // The parsed project uuid (not the public id) is bound.
    expect(select.params).toContain(PROJECT);
    expect(select.params).toContain("prod");
  });

  it("422 on a malformed project filter", async () => {
    const { executor } = capturingExecutor([]);
    const res = await handleListOrgCatalogEntities(req("?project=not-a-project"), createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(422);
  });

  it("422 on a malformed cursor", async () => {
    const { executor } = capturingExecutor([]);
    const res = await handleListOrgCatalogEntities(req("?cursor=nodelimiter"), createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(422);
  });

  it("404s (resource-hiding) when policy denies", async () => {
    const { executor } = capturingExecutor([entityRow()]);
    const res = await handleListOrgCatalogEntities(req(), createEnv(false), "req_2", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(404);
  });
});

// Regression: the org-global catalog route is org-scoped (no project), so it
// must be dispatched at the TOP LEVEL — not under the `/state/`-gated run/object
// plane, where it once sat unreachable (a path with no `/state/` segment never
// entered that sub-router, so the console got "Route not found").
describe("route() — org-global catalog endpoint is reachable", () => {
  it("dispatches /v1/organizations/{org}/catalog/entities to the handler, not Route-not-found", async () => {
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/catalog/entities`, {
      headers: {
        "x-actor-subject-id": ACTOR.subjectId,
        "x-actor-subject-type": ACTOR.subjectType,
      },
    });
    // Policy denies → the handler resource-hides as a plain 404 ("Not found"),
    // which still PROVES the route reached the handler (vs the router's
    // "Route not found: <path>" fall-through).
    const res = await route(req, createEnv(false));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toContain("Route not found");
  });
});
