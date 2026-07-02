// SM5 config repository additions: materialization-provenance record/list/orphan.
// Fake-executor tests asserting SQL shape + mapping (matches config.test.ts and
// config-secret-policies.test.ts conventions).

import { createConfigRepository } from "@saas/db/config";
import type { Scope } from "@saas/db/config";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(rows: Record<string, unknown>[] = [], rowCount?: number): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      return { rows: rows as unknown as T[], rowCount: rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const PRJ = "22222222-2222-2222-2222-222222222222";
const ENV = "44444444-4444-4444-4444-444444444444";
const SECRET = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const ENV_SCOPE: Scope = { kind: "environment", orgId: ORG, projectId: PRJ, environmentId: ENV };

const SYNC_ROW = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  secret_id: SECRET,
  org_id: ORG,
  project_id: PRJ,
  environment_id: ENV,
  version: 7,
  target: "cloudflare-worker",
  entity_ref: "Resource/worker-api-prod",
  run_id: "01JRUNULID",
  status: "synced",
  synced_at: "2026-07-02T00:00:00Z",
};

describe("recordSecretSync", () => {
  it("supersede + insert live in one atomic statement, idempotency-guarded", async () => {
    const { executor, queries } = fakeExecutor([SYNC_ROW], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.recordSecretSync({
      id: SYNC_ROW.id,
      scope: ENV_SCOPE,
      secretId: SECRET,
      version: 7,
      target: "cloudflare-worker",
      entityRef: "Resource/worker-api-prod",
      runId: "01JRUNULID",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.version).toBe(7);
      expect(res.value.target).toBe("cloudflare-worker");
      expect(res.value.entityRef).toBe("Resource/worker-api-prod");
      expect(res.value.status).toBe("synced");
      // No `value` field exists on the mapped provenance row.
      expect(Object.keys(res.value)).not.toContain("value");
    }
    const sql = queries[0]!.text;
    // One statement carrying: the idempotency probe, the supersede, the insert.
    expect(sql).toContain("WITH existing AS");
    expect(sql).toContain("SET status = 'superseded'");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM existing)");
    expect(sql).toContain("INSERT INTO config.secret_syncs");
    expect(sql).toContain("'synced'");
    // Scope denormalized from the environment scope.
    expect(queries[0]!.params).toEqual([SYNC_ROW.id, SECRET, ORG, PRJ, ENV, 7, "cloudflare-worker", "Resource/worker-api-prod", "01JRUNULID"]);
  });

  it("maps `not_found`-shaped empty result to an internal error (never a phantom row)", async () => {
    const { executor } = fakeExecutor([], 0);
    const repo = createConfigRepository(executor);
    const res = await repo.recordSecretSync({
      id: SYNC_ROW.id, scope: ENV_SCOPE, secretId: SECRET, version: 1, target: "t", entityRef: "e", runId: "r",
    });
    expect(res.ok).toBe(false);
  });
});

describe("listSecretSyncs", () => {
  it("filters by entityRef + status and keys on (synced_at, id)", async () => {
    const { executor, queries } = fakeExecutor([SYNC_ROW]);
    const repo = createConfigRepository(executor);
    const res = await repo.listSecretSyncs(ENV_SCOPE, { entityRef: "Resource/worker-api-prod", status: "synced" }, { limit: 50, cursor: null });
    expect(res.ok).toBe(true);
    const sql = queries[0]!.text;
    expect(sql).toContain("entity_ref = $");
    expect(sql).toContain("status = $");
    expect(sql).toContain("ORDER BY synced_at DESC, id DESC");
    // Environment scope narrows to the exact tuple.
    expect(sql).toContain("org_id = $1 AND project_id = $2 AND environment_id = $3");
  });

  it("per-component filter narrows by secret_id", async () => {
    const { executor, queries } = fakeExecutor([]);
    const repo = createConfigRepository(executor);
    await repo.listSecretSyncs({ kind: "organization", orgId: ORG }, { secretId: SECRET }, { limit: 10, cursor: null });
    const sql = queries[0]!.text;
    expect(sql).toContain("secret_id = $");
    // Org scope excludes project/environment-scoped rows.
    expect(sql).toContain("project_id IS NULL AND environment_id IS NULL");
  });

  it("carries a keyset predicate when a cursor is supplied", async () => {
    const { executor, queries } = fakeExecutor([]);
    const repo = createConfigRepository(executor);
    await repo.listSecretSyncs(ENV_SCOPE, {}, { limit: 10, cursor: { createdAt: "2026-07-01T00:00:00.000Z", id: SYNC_ROW.id } });
    expect(queries[0]!.text).toContain("(synced_at, id) <");
  });
});

describe("markSyncsOrphaned", () => {
  it("flips only live rows for the entity to orphaned and returns the count", async () => {
    const { executor, queries } = fakeExecutor([], 3);
    const repo = createConfigRepository(executor);
    const res = await repo.markSyncsOrphaned("Resource/worker-api-prod");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.count).toBe(3);
    const sql = queries[0]!.text;
    expect(sql).toContain("SET status = 'orphaned'");
    expect(sql).toContain("entity_ref = $1 AND status = 'synced'");
  });
});
