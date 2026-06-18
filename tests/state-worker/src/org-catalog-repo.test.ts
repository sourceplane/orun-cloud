// OV6 — org-global catalog projection repository. Verifies idempotent projection
// (ON CONFLICT on the (org, source project, environment, entity_ref) scope),
// namespacing by source so the same ref from two projects coexists, the merged
// org listing, and the projector's delete-a-scope primitive. The DB is an
// in-memory store interpreting the repo's SQL so ON CONFLICT / DELETE behave like
// the real partial-index semantics.

import { createStateRepository } from "@saas/db/state";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "44444444-4444-4444-8444-444444444444";
const PROJECT_B = "55555555-5555-4555-8555-555555555555";

function scopeKey(orgId: string, projectId: string, env: string | null, ref: string): string {
  return `${orgId}|${projectId}|${env ?? ""}|${ref}`;
}

function orgCatalogExecutor(): { executor: SqlExecutor; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      const { rows: out, rowCount } = run(text, params);
      return Promise.resolve({ rows: out as unknown as T[], rowCount });
    },
  } as unknown as SqlExecutor;

  function run(text: string, p: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    if (text.includes("INSERT INTO state.org_catalog_entities")) {
      const [id, orgId, entityRef, kind, name, owner, lifecycle, relations, sourceProjectId, sourceEnv, sourceCommit, headDigest] =
        p as [string, string, string, string, string, string | null, string | null, string, string, string | null, string | null, string];
      const key = scopeKey(orgId, sourceProjectId, sourceEnv ?? null, entityRef);
      const existing = rows.get(key);
      const row: Record<string, unknown> = existing
        ? { ...existing, kind, name, owner: owner ?? null, lifecycle: lifecycle ?? null, relations, source_commit: sourceCommit ?? null, head_digest: headDigest, updated_at: new Date().toISOString() }
        : {
            id,
            org_id: orgId,
            entity_ref: entityRef,
            kind,
            name,
            owner: owner ?? null,
            lifecycle: lifecycle ?? null,
            relations,
            source_project_id: sourceProjectId,
            source_environment: sourceEnv ?? null,
            source_commit: sourceCommit ?? null,
            head_digest: headDigest,
            created_at: new Date(Date.now() + seq++).toISOString(),
            updated_at: new Date().toISOString(),
          };
      rows.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes("DELETE FROM state.org_catalog_entities")) {
      const [orgId, sourceProjectId, sourceEnv] = p as [string, string, string | null];
      let removed = 0;
      for (const [k, r] of [...rows.entries()]) {
        if (r.org_id === orgId && r.source_project_id === sourceProjectId && (r.source_environment ?? "") === (sourceEnv ?? "")) {
          rows.delete(k);
          removed++;
        }
      }
      return { rows: [], rowCount: removed };
    }
    if (text.includes("FROM state.org_catalog_entities")) {
      const orgId = p[0] as string;
      const out = [...rows.values()]
        .filter((r) => r.org_id === orgId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { rows: out, rowCount: out.length };
    }
    return { rows: [], rowCount: 0 };
  }

  return { executor, rows };
}

function entityInput(over?: Record<string, unknown>) {
  return {
    id: "e1",
    orgId: asUuid(ORG),
    entityRef: "component:default/api",
    kind: "Component",
    name: "api",
    sourceProjectId: asUuid(PROJECT_A),
    headDigest: "sha256:" + "a".repeat(64),
    owner: "team-platform",
    relations: [{ type: "dependsOn", targetRef: "component:default/db" }],
    ...over,
  };
}

describe("StateRepository org-global catalog (OV6)", () => {
  it("projects an entity, and re-projecting the same scope updates in place (idempotent)", async () => {
    const { executor, rows } = orgCatalogExecutor();
    const repo = createStateRepository(executor);

    const first = await repo.upsertOrgCatalogEntity(entityInput());
    expect(first.ok).toBe(true);
    expect(rows.size).toBe(1);

    // Same (org, project, env, ref) with a changed name — updates, no new row.
    const again = await repo.upsertOrgCatalogEntity(entityInput({ id: "e1-b", name: "api-gateway" }));
    expect(again.ok).toBe(true);
    expect(rows.size).toBe(1);
    if (again.ok) expect(again.value.name).toBe("api-gateway");
  });

  it("namespaces by source project — the same ref from two projects coexists", async () => {
    const { executor, rows } = orgCatalogExecutor();
    const repo = createStateRepository(executor);
    await repo.upsertOrgCatalogEntity(entityInput({ sourceProjectId: asUuid(PROJECT_A) }));
    await repo.upsertOrgCatalogEntity(entityInput({ id: "e2", sourceProjectId: asUuid(PROJECT_B) }));
    expect(rows.size).toBe(2);

    const list = await repo.listOrgCatalogEntities(asUuid(ORG), { limit: 50, cursor: null });
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value.items).toHaveLength(2);
  });

  it("deletes a (project, environment) scope and reports the count removed", async () => {
    const { executor, rows } = orgCatalogExecutor();
    const repo = createStateRepository(executor);
    // Two entities in (A, project-wide) and one in (A, prod).
    await repo.upsertOrgCatalogEntity(entityInput({ id: "a1", entityRef: "component:default/api" }));
    await repo.upsertOrgCatalogEntity(entityInput({ id: "a2", entityRef: "component:default/web" }));
    await repo.upsertOrgCatalogEntity(entityInput({ id: "a3", entityRef: "component:default/api", sourceEnvironment: "prod" }));
    expect(rows.size).toBe(3);

    const removed = await repo.deleteOrgCatalogEntitiesForScope(asUuid(ORG), asUuid(PROJECT_A), null);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toBe(2); // only the project-wide scope
    expect(rows.size).toBe(1); // the prod-scoped entity survives
  });
});

// OV9 — the org state-plane storage footprint (STOCK aggregates).
function storageExecutor(objects: Record<string, unknown>, logs: Record<string, unknown>): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      const row = text.includes("FROM state.objects") ? objects : text.includes("FROM state.log_chunks") ? logs : {};
      return Promise.resolve({ rows: [row] as unknown as T[], rowCount: 1 });
    },
  } as unknown as SqlExecutor;
}

describe("StateRepository.getOrgStateStorage (OV9)", () => {
  it("aggregates object + log counts and bytes, coercing pg bigint strings", async () => {
    const repo = createStateRepository(
      storageExecutor({ count: "12", bytes: "204800" }, { count: 3, bytes: BigInt(5120) }),
    );
    const res = await repo.getOrgStateStorage(asUuid(ORG));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.objects).toEqual({ count: 12, bytes: 204800 });
      expect(res.value.logs).toEqual({ count: 3, bytes: 5120 });
    }
  });

  it("defaults missing/negative aggregates to zero", async () => {
    const repo = createStateRepository(storageExecutor({ count: null, bytes: -1 }, {}));
    const res = await repo.getOrgStateStorage(asUuid(ORG));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.objects).toEqual({ count: 0, bytes: 0 });
      expect(res.value.logs).toEqual({ count: 0, bytes: 0 });
    }
  });
});
