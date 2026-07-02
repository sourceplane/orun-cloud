// SM3 config repository additions: secret-policy upsert/list, ciphertext read,
// last-used stamp, and the DEK-by-generation decrypt lookup. Fake-executor
// tests asserting SQL shape + mapping (matches config.test.ts conventions).

import { createConfigRepository, createSecretDekRepository } from "@saas/db/config";
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

const POLICY_ROW = {
  id: "p1",
  org_id: "11111111-1111-1111-1111-111111111111",
  project_id: null,
  name: "prod-secrets",
  tier: "stack",
  source: "stack:acme@1.0.0",
  document: { rules: [{ id: "r", effect: "allow", scope: { env: "prod", key: "*" } }] },
  document_hash: "hash-abc",
  created_at: "2026-07-02T00:00:00Z",
  was_updated: true,
};

describe("putSecretPolicy", () => {
  it("upserts idempotently by hash and reports `updated`", async () => {
    const { executor, queries } = fakeExecutor([POLICY_ROW], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.putSecretPolicy({
      id: "p1",
      orgId: POLICY_ROW.org_id,
      projectId: null,
      name: "prod-secrets",
      tier: "stack",
      source: "stack:acme@1.0.0",
      document: { rules: [] },
      documentHash: "hash-abc",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.updated).toBe(true);
      expect(res.value.record.name).toBe("prod-secrets");
      expect(res.value.record.documentHash).toBe("hash-abc");
    }
    expect(queries[0]!.text).toContain("ON CONFLICT");
    expect(queries[0]!.text).toContain("document_hash <> EXCLUDED.document_hash");
  });

  it("treats a rowCount=0 conflict as a no-op (updated=false) via re-select", async () => {
    // First call (upsert) returns nothing; the re-select returns the row.
    const queries: QueryRecord[] = [];
    let call = 0;
    const executor: SqlExecutor = {
      async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
        queries.push({ text, params: params ?? [] });
        call += 1;
        if (call === 1) return { rows: [] as unknown as T[], rowCount: 0 };
        return { rows: [POLICY_ROW] as unknown as T[], rowCount: 1 };
      },
    };
    const repo = createConfigRepository(executor);
    const res = await repo.putSecretPolicy({
      id: "p1", orgId: POLICY_ROW.org_id, projectId: null, name: "prod-secrets", tier: "stack", source: "s", document: { rules: [] }, documentHash: "hash-abc",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.updated).toBe(false);
    expect(queries).toHaveLength(2);
  });
});

describe("listSecretPolicies", () => {
  it("orders composition → stack → intent and includes workspace-wide + project docs", async () => {
    const { executor, queries } = fakeExecutor([POLICY_ROW]);
    const repo = createConfigRepository(executor);
    const res = await repo.listSecretPolicies({ orgId: POLICY_ROW.org_id, projectId: "22222222-2222-2222-2222-222222222222" });
    expect(res.ok).toBe(true);
    expect(queries[0]!.text).toContain("CASE tier WHEN 'composition' THEN 0 WHEN 'stack' THEN 1 ELSE 2 END");
    expect(queries[0]!.text).toContain("project_id IS NULL OR project_id =");
  });

  it("workspace-only scope probes just the NULL-project rows", async () => {
    const { executor, queries } = fakeExecutor([]);
    const repo = createConfigRepository(executor);
    await repo.listSecretPolicies({ orgId: POLICY_ROW.org_id });
    expect(queries[0]!.text).toContain("project_id IS NULL");
    expect(queries[0]!.text).not.toContain("project_id =");
  });
});

describe("getSecretCiphertext + touchSecretLastUsed", () => {
  it("reads the envelope via convert_from and filters active versions", async () => {
    const { executor, queries } = fakeExecutor([{ ciphertext_envelope: '{"v":1}' }], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.getSecretCiphertext("44444444-4444-4444-4444-444444444444", 9);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('{"v":1}');
    expect(queries[0]!.text).toContain("convert_from(ciphertext_envelope, 'UTF8')");
    expect(queries[0]!.text).toContain("status = 'active'");
  });

  it("stamps last_used_at", async () => {
    const { executor, queries } = fakeExecutor([{}], 1);
    const repo = createConfigRepository(executor);
    const res = await repo.touchSecretLastUsed("11111111-1111-1111-1111-111111111111", "44444444-4444-4444-4444-444444444444", new Date("2026-07-02T00:00:00Z"));
    expect(res.ok).toBe(true);
    expect(queries[0]!.text).toContain("UPDATE config.secret_metadata SET last_used_at");
  });
});

describe("getWrappedDek (decrypt lookup)", () => {
  it("fetches a specific generation and excludes shredded", async () => {
    const { executor, queries } = fakeExecutor([{ wrapped_dek: '{"v":1,"iv":"x","ct":"y"}' }], 1);
    const repo = createSecretDekRepository(executor);
    const res = await repo.getWrappedDek("11111111-1111-1111-1111-111111111111", 3);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('"iv":"x"');
    expect(queries[0]!.text).toContain("generation = $2");
    expect(queries[0]!.text).toContain("state <> 'shredded'");
  });
});
