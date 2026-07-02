// SEC7 config repository additions: the rotation/expiry due-scan + reminder
// stamp. Fake-executor tests asserting SQL shape + mapping (matches
// config-secret-syncs.test.ts / config.test.ts conventions).

import { createConfigRepository } from "@saas/db/config";
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
const SECRET = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NOW = new Date("2026-07-02T00:00:00Z");

const DUE_ROW = {
  id: SECRET,
  org_id: ORG,
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  secret_key: "API_KEY",
  rotation_policy: "90d",
  last_rotated_at: "2026-01-01T00:00:00Z",
  expires_at: null,
  created_at: "2025-12-01T00:00:00Z",
  age_days: 183,
  due_kind: "rotation",
};

describe("listSecretsDueForRotation", () => {
  it("selects overdue-by-policy AND expiring rows and excludes fresh / recently-reminded ones", async () => {
    const { executor, queries } = fakeExecutor([DUE_ROW], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.listSecretsDueForRotation(NOW, 7 * 24 * 3600, 24 * 3600, 100);
    expect(res.ok).toBe(true);

    const sql = queries[0]!.text;
    // Overdue-by-policy: parses the "<n>[hdwmy]" duration and adds it to the last
    // rotation (or created_at when never rotated).
    expect(sql).toContain("rotation_policy ~ '^[0-9]+[hdwmy]$'");
    expect(sql).toContain("COALESCE(last_rotated_at, created_at)");
    expect(sql).toContain("make_interval");
    // Expiring: expires_at within now + lead window.
    expect(sql).toContain("expires_at < $1::timestamptz + make_interval(secs => $2)");
    // Fresh rows excluded: only active, shared (non-personal) rows qualify.
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("personal_owner IS NULL");
    // Idempotency: suppress rows reminded within the window.
    expect(sql).toContain("last_reminded_at IS NULL OR last_reminded_at < $1::timestamptz - make_interval(secs => $3)");
    // Bounded batch.
    expect(sql).toContain("LIMIT $4");
    // No ciphertext/value column is ever selected.
    expect(sql).not.toContain("ciphertext");

    expect(queries[0]!.params).toEqual([NOW.toISOString(), 7 * 24 * 3600, 24 * 3600, 100]);
  });

  it("maps the due row (metadata only, dueKind + ageDays)", async () => {
    const { executor } = fakeExecutor([DUE_ROW], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.listSecretsDueForRotation(NOW, 3600, 3600, 10);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      const row = res.value[0]!;
      expect(row.id).toBe(SECRET);
      expect(row.secretKey).toBe("API_KEY");
      expect(row.rotationPolicy).toBe("90d");
      expect(row.ageDays).toBe(183);
      expect(row.dueKind).toBe("rotation");
      expect(row.lastRotatedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      // No value/ciphertext field on the mapped shape.
      expect((row as unknown as Record<string, unknown>).value).toBeUndefined();
    }
  });

  it("maps an expiring row's dueKind", async () => {
    const { executor } = fakeExecutor([{ ...DUE_ROW, due_kind: "expiry", expires_at: "2026-07-05T00:00:00Z" }], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.listSecretsDueForRotation(NOW, 3600, 3600, 10);
    if (res.ok) expect(res.value[0]!.dueKind).toBe("expiry");
  });

  it("returns an empty list without error when nothing is due", async () => {
    const { executor } = fakeExecutor([], 0);
    const repo = createConfigRepository(executor);
    const res = await repo.listSecretsDueForRotation(NOW, 3600, 3600, 10);
    expect(res).toEqual({ ok: true, value: [] });
  });
});

describe("markSecretsReminded", () => {
  it("stamps last_reminded_at for a batch via ANY($1::uuid[])", async () => {
    const { executor, queries } = fakeExecutor([], 2);
    const repo = createConfigRepository(executor);
    const ids = [SECRET, "dddddddd-dddd-dddd-dddd-dddddddddddd"];
    const res = await repo.markSecretsReminded(ids, NOW);
    expect(res).toEqual({ ok: true, value: undefined });
    expect(queries[0]!.text).toContain("UPDATE config.secret_metadata SET last_reminded_at = $2");
    expect(queries[0]!.text).toContain("id = ANY($1::uuid[])");
    expect(queries[0]!.params).toEqual([ids, NOW.toISOString()]);
  });

  it("is a no-op (no query) for an empty id list", async () => {
    const { executor, queries } = fakeExecutor([], 0);
    const repo = createConfigRepository(executor);
    const res = await repo.markSecretsReminded([], NOW);
    expect(res).toEqual({ ok: true, value: undefined });
    expect(queries).toHaveLength(0);
  });
});
