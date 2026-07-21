import {
  createConfigRepository,
} from "@saas/db/config";
import { asUuid } from "@saas/db";
import type {
  Scope,
  SecretMetadata,
} from "@saas/db/config";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) {
        throw options.error;
      }
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-01-15T10:00:00Z");

const SAMPLE_SETTING_ROW = {
  id: "set-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  key: "theme",
  value: { dark: true },
  description: "UI theme",
  overridable: true,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_FLAG_ROW = {
  id: "flg-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  flag_key: "beta_feature",
  enabled: true,
  value: null,
  description: "Beta feature toggle",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_SECRET_ROW = {
  id: "sec-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  secret_key: "DB_PASSWORD",
  display_name: "Database Password",
  status: "active",
  version: 1,
  rotation_policy: null,
  last_rotated_at: null,
  expires_at: null,
  created_by: "user-001",
  personal_owner: null,
  overridable: true,
  last_used_at: null,
  source: "static",
  binding_provider: null,
  binding_connection_id: null,
  binding_template: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

// A brokered head (saas-integration-hub IH7): no stored value — the envelope
// is a binding pointer; the metadata carries the display-only binding facts.
const BROKERED_SECRET_ROW = {
  ...SAMPLE_SECRET_ROW,
  id: "sec-brk",
  secret_key: "CLOUDFLARE_API_TOKEN",
  source: "brokered",
  binding_provider: "cloudflare",
  binding_connection_id: "00000000-0000-0000-0000-00000000c0f1",
  binding_template: "workers-deploy",
};

const SAMPLE_SECRET_VERSION_ROW = {
  secret_id: "sec-001",
  version: 2,
  status: "active",
  created_by: "00000000-0000-0000-0000-000000000001",
  created_at: NOW.toISOString(),
};

const CREATED_BY = asUuid("00000000-0000-0000-0000-000000000001");

const ORG_SCOPE: Scope = { kind: "organization", orgId: "org-001" };
const PROJECT_SCOPE: Scope = { kind: "project", orgId: "org-001", projectId: "prj-001" };
const ENV_SCOPE: Scope = { kind: "environment", orgId: "org-001", projectId: "prj-001", environmentId: "env-001" };

// ── Settings tests ─────────────────────────────────────────

describe("ConfigRepository — Settings", () => {
  it("creates an org-scoped setting with parameterized query", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: { dark: true },
      description: "UI theme",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("set-001");
      expect(result.value.scopeKind).toBe("organization");
      expect(result.value.projectId).toBeNull();
      expect(result.value.environmentId).toBeNull();
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("config.settings");
    expect(queries[0]!.params[2]).toBeNull(); // project_id null
    expect(queries[0]!.params[3]).toBeNull(); // environment_id null
  });

  it("creates a project-scoped setting with both orgId and projectId", async () => {
    const row = { ...SAMPLE_SETTING_ROW, project_id: "prj-001", scope_kind: "project" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-002",
      scope: PROJECT_SCOPE,
      key: "timeout",
      value: 30,
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[1]).toBe("org-001"); // org_id
    expect(queries[0]!.params[2]).toBe("prj-001"); // project_id
    expect(queries[0]!.params[3]).toBeNull(); // environment_id
  });

  it("creates an environment-scoped setting with all three IDs", async () => {
    const row = { ...SAMPLE_SETTING_ROW, project_id: "prj-001", environment_id: "env-001", scope_kind: "environment" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-003",
      scope: ENV_SCOPE,
      key: "log_level",
      value: "debug",
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[1]).toBe("org-001");
    expect(queries[0]!.params[2]).toBe("prj-001");
    expect(queries[0]!.params[3]).toBe("env-001");
  });

  it("returns conflict on unique violation", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23505" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
    }
  });

  it("returns conflict when insert returns 0 rows", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
    }
  });

  it("returns internal error on check violation", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal");
    }
  });

  it("updates a setting by orgId + settingId", async () => {
    const updatedRow = { ...SAMPLE_SETTING_ROW, value: { dark: false } };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.updateSetting("org-001", "set-001", { value: { dark: false } });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("set-001");
  });

  it("returns not_found when updating a non-existent setting", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.updateSetting("org-001", "set-999", { value: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("gets a setting by orgId + settingId", async () => {
    const { executor } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSetting("org-001", "set-001");
    expect(result.ok).toBe(true);
  });

  it("returns not_found for missing setting", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.getSetting("org-001", "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("lists settings with org scope filter", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.listSettings(ORG_SCOPE, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(1);
    expect(queries[0]!.text).toContain("scope_kind = 'organization'");
  });

  it("lists settings with project scope filter requiring orgId + projectId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSettings(PROJECT_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.text).toContain("org_id = $1 AND project_id = $2");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("prj-001");
  });

  it("lists settings with environment scope filter requiring all three IDs", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSettings(ENV_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.text).toContain("org_id = $1 AND project_id = $2 AND environment_id = $3");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("prj-001");
    expect(queries[0]!.params[2]).toBe("env-001");
  });

  it("supports cursor pagination in list", async () => {
    const rows = [
      { ...SAMPLE_SETTING_ROW, id: "set-a" },
      { ...SAMPLE_SETTING_ROW, id: "set-b" },
    ];
    const { executor } = createFakeExecutor({ rows });
    const repo = createConfigRepository(executor);
    const result = await repo.listSettings(ORG_SCOPE, { limit: 1, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.nextCursor).not.toBeNull();
    }
  });

  // ── WID7: overridable + getSettingByScopeKey ───────────────

  it("defaults overridable to true when creating and persists it (round-trip)", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: { dark: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.overridable).toBe(true);
    // overridable column included in the INSERT; default true passed as a param
    expect(queries[0]!.text).toContain("overridable");
    expect(queries[0]!.params).toContain(true);
  });

  it("round-trips overridable=false on an account-scope create", async () => {
    const lockedRow = { ...SAMPLE_SETTING_ROW, scope_kind: "account", overridable: false };
    const { executor, queries } = createFakeExecutor({ rows: [lockedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: { kind: "organization", orgId: "acct-001" },
      key: "theme",
      value: { dark: true },
      overridable: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.overridable).toBe(false);
      expect(result.value.scopeKind).toBe("account");
    }
    expect(queries[0]!.params).toContain(false);
  });

  it("getSettingByScopeKey probes an org scope tuple + key", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSettingByScopeKey(ORG_SCOPE, "theme");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("scope_kind = 'organization'");
    expect(queries[0]!.text).toContain("key = $2");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("theme");
  });

  it("getSettingByScopeKey probes an account scope by accountId", async () => {
    const accountRow = { ...SAMPLE_SETTING_ROW, org_id: "acct-001", scope_kind: "account", overridable: false };
    const { executor, queries } = createFakeExecutor({ rows: [accountRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSettingByScopeKey({ kind: "account", accountId: "acct-001" }, "theme");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scopeKind).toBe("account");
      expect(result.value.overridable).toBe(false);
    }
    expect(queries[0]!.text).toContain("scope_kind = 'account'");
    expect(queries[0]!.params[0]).toBe("acct-001");
    expect(queries[0]!.params[1]).toBe("theme");
  });

  it("getSettingByScopeKey probes an environment scope tuple", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.getSettingByScopeKey(ENV_SCOPE, "theme");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
    expect(queries[0]!.text).toContain("org_id = $1 AND project_id = $2 AND environment_id = $3 AND scope_kind = 'environment'");
    expect(queries[0]!.params[3]).toBe("theme");
  });

  it("getSettingByScopeKey returns not_found when no row matches", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.getSettingByScopeKey(ORG_SCOPE, "missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });
});

// ── Feature flags tests ────────────────────────────────────

describe("ConfigRepository — Feature Flags", () => {
  it("creates an org-scoped flag", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_FLAG_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createFeatureFlag({
      id: "flg-001",
      scope: ORG_SCOPE,
      flagKey: "beta_feature",
      enabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.flagKey).toBe("beta_feature");
      expect(result.value.enabled).toBe(true);
    }
    expect(queries[0]!.text).toContain("config.feature_flags");
  });

  it("creates a project-scoped flag with orgId + projectId", async () => {
    const row = { ...SAMPLE_FLAG_ROW, project_id: "prj-001", scope_kind: "project" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    await repo.createFeatureFlag({
      id: "flg-002",
      scope: PROJECT_SCOPE,
      flagKey: "dark_mode",
    });
    expect(queries[0]!.params[2]).toBe("prj-001");
  });

  it("returns conflict on duplicate flag key", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23505" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createFeatureFlag({
      id: "flg-001",
      scope: ORG_SCOPE,
      flagKey: "beta_feature",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("updates a flag by orgId + flagId", async () => {
    const updatedRow = { ...SAMPLE_FLAG_ROW, enabled: false };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.updateFeatureFlag("org-001", "flg-001", { enabled: false });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("flg-001");
  });

  it("returns not_found when updating a missing flag", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.updateFeatureFlag("org-001", "nope", { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("gets a flag by orgId + flagId", async () => {
    const { executor } = createFakeExecutor({ rows: [SAMPLE_FLAG_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getFeatureFlag("org-001", "flg-001");
    expect(result.ok).toBe(true);
  });

  it("lists flags with scope filter", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_FLAG_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.listFeatureFlags(ORG_SCOPE, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("config.feature_flags");
  });
});

// ── Secret metadata tests ──────────────────────────────────

describe("ConfigRepository — Secret Metadata", () => {
  it("creates secret metadata without exposing plaintext", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      displayName: "Database Password",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const val = result.value;
      // Must not have ciphertext_envelope or any plaintext secret field
      expect("ciphertext_envelope" in val).toBe(false);
      expect("ciphertextEnvelope" in val).toBe(false);
      expect("plaintext" in val).toBe(false);
      expect("secret_value" in val).toBe(false);
      expect("secretValue" in val).toBe(false);
      expect(val.secretKey).toBe("DB_PASSWORD");
      expect(val.status).toBe("active");
      expect(val.version).toBe(1);
    }
    // RETURNING clause must not include ciphertext_envelope
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("lists secret metadata without exposing ciphertext_envelope", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.listSecretMetadata(ORG_SCOPE, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      const item = result.value.items[0]!;
      expect("ciphertext_envelope" in item).toBe(false);
      expect("ciphertextEnvelope" in item).toBe(false);
    }
    // SELECT must use safe columns, not *
    expect(queries[0]!.text).not.toContain("SELECT *");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("gets secret metadata without exposing ciphertext_envelope", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSecretMetadata("org-001", "sec-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
    expect(queries[0]!.text).not.toContain("SELECT *");
  });

  it("rotates secret metadata (increments version and appends a version row)", async () => {
    const rotatedRow = { ...SAMPLE_SECRET_ROW, version: 2, last_rotated_at: NOW.toISOString() };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.rotateSecretMetadata("org-001", "sec-001", CREATED_BY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(2);
    }
    // One atomic statement: head bump + append to the version history (SM1).
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("version = version + 1");
    expect(queries[0]!.text).toContain("status = 'active'");
    expect(queries[0]!.text).toContain("INSERT INTO config.secret_versions");
    expect(queries[0]!.params[2]).toBe(CREATED_BY);
    // The head cache is not overwritten on a metadata-only rotate.
    expect(queries[0]!.text).not.toContain("ciphertext_envelope = $");
  });

  it("rotate with a new envelope refreshes the head cache and appends it", async () => {
    const rotatedRow = { ...SAMPLE_SECRET_ROW, version: 2, last_rotated_at: NOW.toISOString() };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.rotateSecretMetadata("org-001", "sec-001", CREATED_BY, "{\"alg\":\"AES-256-GCM\"}");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("ciphertext_envelope = $4");
    expect(queries[0]!.text).toContain("INSERT INTO config.secret_versions");
    expect(queries[0]!.params[3]).toBe("{\"alg\":\"AES-256-GCM\"}");
  });

  it("revokes secret metadata", async () => {
    const revokedRow = { ...SAMPLE_SECRET_ROW, status: "revoked" };
    const { executor, queries } = createFakeExecutor({ rows: [revokedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.revokeSecretMetadata("org-001", "sec-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("revoked");
    }
    expect(queries[0]!.text).toContain("status = 'revoked'");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("returns not_found when rotating non-existent secret", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.rotateSecretMetadata("org-001", "nope", CREATED_BY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("returns not_found when revoking non-existent secret", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.revokeSecretMetadata("org-001", "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("repoints a brokered secret: bumps version, swaps binding columns + pointer, appends a version (Feature 7)", async () => {
    const repointed = {
      ...SAMPLE_SECRET_ROW,
      version: 4,
      source: "brokered",
      binding_provider: "supabase",
      binding_connection_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      binding_template: "management-access",
    };
    const { executor, queries } = createFakeExecutor({ rows: [repointed] });
    const repo = createConfigRepository(executor);
    const result = await repo.repointBrokeredSecret("org-001", "sec-001", CREATED_BY, {
      provider: "supabase",
      connectionUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as never,
      template: "management-access",
      pointerEnvelope: '{"v":"brokered"}',
    });
    expect(result.ok).toBe(true);
    // One atomic statement, scoped to an ACTIVE BROKERED head only.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("version = version + 1");
    expect(queries[0]!.text).toContain("source = 'brokered'");
    expect(queries[0]!.text).toContain("binding_connection_id = $5");
    expect(queries[0]!.text).toContain("ciphertext_envelope = $7");
    expect(queries[0]!.text).toContain("INSERT INTO config.secret_versions");
    expect(queries[0]!.params[3]).toBe("supabase");
    expect(queries[0]!.params[6]).toBe('{"v":"brokered"}');
  });

  it("returns not_found when repointing a non-brokered or missing head", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.repointBrokeredSecret("org-001", "nope", CREATED_BY, {
      provider: "supabase",
      connectionUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as never,
      template: "management-access",
      pointerEnvelope: "{}",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("touchBrokeredRotation stamps last_rotated_at (+ optional cadence) on an active brokered head only (SC2)", async () => {
    const brokered = { ...SAMPLE_SECRET_ROW, source: "brokered", rotation_policy: "90d" };
    const { executor, queries } = createFakeExecutor({ rows: [brokered] });
    const repo = createConfigRepository(executor);
    const result = await repo.touchBrokeredRotation("org-001", "sec-001", { rotationPolicy: "90d", stampRotation: true });
    expect(result.ok).toBe(true);
    // Guarded to an active brokered head; no version bump, no value touched.
    expect(queries[0]!.text).toContain("source = 'brokered'");
    expect(queries[0]!.text).toContain("last_rotated_at = now()");
    expect(queries[0]!.text).toContain("rotation_policy = $3");
    expect(queries[0]!.text).not.toContain("version = version + 1");
    expect(queries[0]!.text).not.toContain("ciphertext");
    expect(queries[0]!.params[2]).toBe("90d");
  });

  it("touchBrokeredRotation can set the cadence WITHOUT stamping a rotation (SC2)", async () => {
    const brokered = { ...SAMPLE_SECRET_ROW, source: "brokered", rotation_policy: "30d" };
    const { executor, queries } = createFakeExecutor({ rows: [brokered] });
    const repo = createConfigRepository(executor);
    const result = await repo.touchBrokeredRotation("org-001", "sec-001", { rotationPolicy: "30d", stampRotation: false });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).not.toContain("last_rotated_at = now()");
    expect(queries[0]!.text).toContain("rotation_policy = $3");
  });

  it("lists secret metadata with project scope requiring orgId + projectId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSecretMetadata(PROJECT_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("prj-001");
  });

  it("creates project-scoped secret with orgId + projectId", async () => {
    const row = { ...SAMPLE_SECRET_ROW, project_id: "prj-001", scope_kind: "project" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    await repo.createSecretMetadata({
      id: "sec-002",
      scope: PROJECT_SCOPE,
      secretKey: "API_TOKEN",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(queries[0]!.params[1]).toBe("org-001");
    expect(queries[0]!.params[2]).toBe("prj-001");
    expect(queries[0]!.params[3]).toBeNull(); // environment_id
  });

  it("returns conflict on duplicate secret key", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23505" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});

// ── Scope validation tests ─────────────────────────────────

// ── Secret store v3 (saas-secret-manager SM1) ──────────────

describe("ConfigRepository — Secret Store v3 (SM1)", () => {
  it("create with an envelope appends version 1 in the same statement", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      createdBy: CREATED_BY,
      ciphertextEnvelope: "{\"alg\":\"AES-256-GCM\"}",
    });
    expect(result.ok).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("INSERT INTO config.secret_versions");
    // The final projection never exposes the envelope.
    const finalSelect = queries[0]!.text.split("SELECT").pop()!;
    expect(finalSelect).not.toContain("ciphertext_envelope");
  });

  it("create without an envelope appends no version row", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      createdBy: CREATED_BY,
    });
    expect(queries[0]!.text).not.toContain("config.secret_versions");
  });

  it("create persists personal_owner and overridable", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    await repo.createSecretMetadata({
      id: "sec-001",
      scope: ENV_SCOPE,
      secretKey: "MY_TOKEN",
      createdBy: CREATED_BY,
      personalOwner: asUuid("00000000-0000-0000-0000-000000000009"),
      overridable: false,
    });
    expect(queries[0]!.params[10]).toBe("00000000-0000-0000-0000-000000000009");
    expect(queries[0]!.params[11]).toBe(false);
  });

  it("create accepts the account scope rung", async () => {
    const row = { ...SAMPLE_SECRET_ROW, scope_kind: "account" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: { kind: "account", accountId: "org-acct" },
      secretKey: "DB_PASSWORD",
      createdBy: CREATED_BY,
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[1]).toBe("org-acct");
    expect(queries[0]!.params[4]).toBe("account");
  });

  it("listSecretVersions returns history newest-first, metadata only", async () => {
    const rows = [
      { ...SAMPLE_SECRET_VERSION_ROW, version: 3 },
      { ...SAMPLE_SECRET_VERSION_ROW, version: 2 },
    ];
    const { executor, queries } = createFakeExecutor({ rows });
    const repo = createConfigRepository(executor);
    const result = await repo.listSecretVersions("org-001", "sec-001", { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items.map((v) => v.version)).toEqual([3, 2]);
      const item = result.value.items[0]!;
      expect("ciphertextEnvelope" in item).toBe(false);
      expect("ciphertext_envelope" in item).toBe(false);
      expect(item.secretId).toBe("sec-001");
      expect(item.status).toBe("active");
    }
    expect(queries[0]!.text).toContain("ORDER BY created_at DESC, version DESC");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
    // Tenant isolation rides the metadata org check.
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("sec-001");
  });

  it("getSecretMetadataByScopeKey probes the shared row by default", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSecretMetadataByScopeKey(ORG_SCOPE, "DB_PASSWORD");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("personal_owner IS NULL");
    expect(queries[0]!.text).toContain("status IN ('active', 'rotated')");
    expect(queries[0]!.params).toEqual(["org-001", "DB_PASSWORD"]);
  });

  it("getSecretMetadataByScopeKey matches a given personal owner", async () => {
    const row = { ...SAMPLE_SECRET_ROW, personal_owner: "user-009" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSecretMetadataByScopeKey(ENV_SCOPE, "MY_TOKEN", "user-009");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.personalOwner).toBe("user-009");
    }
    expect(queries[0]!.text).toContain("personal_owner = $");
    expect(queries[0]!.params).toEqual(["org-001", "prj-001", "env-001", "MY_TOKEN", "user-009"]);
  });

  it("getSecretMetadataByScopeKey probes the account rung by accountId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSecretMetadataByScopeKey({ kind: "account", accountId: "org-acct" }, "DB_PASSWORD");
    expect(result.ok).toBe(false);
    expect(queries[0]!.text).toContain("scope_kind = 'account'");
    expect(queries[0]!.params[0]).toBe("org-acct");
  });

  it("list without a viewer excludes every personal row", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSecretMetadata(ENV_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.text).toContain("AND personal_owner IS NULL");
  });

  it("list with a viewer includes only that viewer's personal rows", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSecretMetadata(ENV_SCOPE, { limit: 10, cursor: null }, "user-009");
    expect(queries[0]!.text).toContain("(personal_owner IS NULL OR personal_owner = $");
    expect(queries[0]!.params).toContain("user-009");
  });
});

// ── Brokered secrets (saas-integration-hub IH7) ────────────

describe("ConfigRepository — Brokered Secrets (IH7)", () => {
  const CONNECTION_ID = asUuid("00000000-0000-0000-0000-00000000c0f1");
  const BROKERED_ENVELOPE = "{\"v\":\"brokered\",\"provider\":{\"connectionId\":\"int_1\",\"template\":\"workers-deploy\",\"params\":{}}}";

  it("create persists the discriminator and the three binding facts", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [BROKERED_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-brk",
      scope: ORG_SCOPE,
      secretKey: "CLOUDFLARE_API_TOKEN",
      createdBy: CREATED_BY,
      source: "brokered",
      bindingProvider: "cloudflare",
      bindingConnectionId: CONNECTION_ID,
      bindingTemplate: "workers-deploy",
      ciphertextEnvelope: BROKERED_ENVELOPE,
    });
    expect(result.ok).toBe(true);
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.text).toContain("source, binding_provider, binding_connection_id, binding_template");
    expect(q.params[12]).toBe("brokered");
    expect(q.params[13]).toBe("cloudflare");
    expect(q.params[14]).toBe("00000000-0000-0000-0000-00000000c0f1");
    expect(q.params[15]).toBe("workers-deploy");
    // The binding pointer still rides the existing envelope write path.
    expect(q.params[16]).toBe(BROKERED_ENVELOPE);
    expect(q.text).toContain("INSERT INTO config.secret_versions");
  });

  it("create defaults source to 'static' with no binding facts", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      createdBy: CREATED_BY,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("static");
      expect(result.value.bindingProvider).toBeNull();
      expect(result.value.bindingConnectionId).toBeNull();
      expect(result.value.bindingTemplate).toBeNull();
    }
    expect(queries[0]!.params[12]).toBe("static");
    expect(queries[0]!.params[13]).toBeNull();
    expect(queries[0]!.params[14]).toBeNull();
    expect(queries[0]!.params[15]).toBeNull();
  });

  it("the mapper surfaces broker provenance on reads", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [BROKERED_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSecretMetadata("org-001", "sec-brk");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("brokered");
      expect(result.value.bindingProvider).toBe("cloudflare");
      expect(result.value.bindingConnectionId).toBe("00000000-0000-0000-0000-00000000c0f1");
      expect(result.value.bindingTemplate).toBe("workers-deploy");
    }
    // Provenance rides the safe-column projection — never the envelope.
    expect(queries[0]!.text).toContain("binding_provider");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("countBrokeredSecrets counts live brokered bindings in the org", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [{ count: 3 }] });
    const repo = createConfigRepository(executor);
    const result = await repo.countBrokeredSecrets("org-001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(3);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("COUNT(*)");
    expect(queries[0]!.text).toContain("FROM config.secret_metadata");
    expect(queries[0]!.text).toContain("source = 'brokered'");
    // Only live heads count against limit.brokered_secrets.
    expect(queries[0]!.text).toContain("status IN ('active', 'rotated')");
    expect(queries[0]!.params).toEqual(["org-001"]);
  });

  it("countBrokeredSecrets returns 0 when no row comes back", async () => {
    const { executor } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    const result = await repo.countBrokeredSecrets("org-001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(0);
  });

  it("countBrokeredSecrets maps executor failure to internal", async () => {
    const { executor } = createFakeExecutor({ error: new Error("boom") });
    const repo = createConfigRepository(executor);
    const result = await repo.countBrokeredSecrets("org-001");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });
});

describe("ConfigRepository — Scope Validation", () => {
  it("rejects setting creation when check constraint violated", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-bad",
      scope: ORG_SCOPE,
      key: "x",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });

  it("rejects flag creation when check constraint violated", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createFeatureFlag({
      id: "flg-bad",
      scope: ORG_SCOPE,
      flagKey: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });

  it("rejects secret creation when check constraint violated", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-bad",
      scope: ORG_SCOPE,
      secretKey: "x",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });
});

// ── Secret safety invariants ───────────────────────────────

describe("Secret Safety Invariants", () => {
  it("SecretMetadata type does not include plaintext or ciphertext fields", () => {
    // This is a compile-time + runtime assertion
    const sample: SecretMetadata = {
      id: "x",
      orgId: "o",
      projectId: null,
      environmentId: null,
      scopeKind: "organization",
      secretKey: "k",
      displayName: null,
      status: "active",
      version: 1,
      rotationPolicy: null,
      lastRotatedAt: null,
      expiresAt: null,
      createdBy: asUuid("00000000-0000-0000-0000-000000000002"),
      personalOwner: null,
      overridable: true,
      lastUsedAt: null,
      source: "static",
      bindingProvider: null,
      bindingConnectionId: null,
      bindingTemplate: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const keys = Object.keys(sample);
    expect(keys).not.toContain("ciphertextEnvelope");
    expect(keys).not.toContain("ciphertext_envelope");
    expect(keys).not.toContain("plaintext");
    expect(keys).not.toContain("secretValue");
    expect(keys).not.toContain("secret_value");
    expect(keys).not.toContain("value");
  });

  it("repository read queries never SELECT * for secret_metadata", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);

    await repo.getSecretMetadata("org-001", "sec-001");
    await repo.listSecretMetadata(ORG_SCOPE, { limit: 10, cursor: null });
    await repo.getSecretMetadataByScopeKey(ORG_SCOPE, "DB_PASSWORD");
    await repo.listSecretVersions("org-001", "sec-001", { limit: 10, cursor: null });
    await repo.revokeSecretMetadata("org-001", "sec-001");

    for (const q of queries) {
      expect(q.text).not.toContain("SELECT *");
      expect(q.text).not.toContain("ciphertext_envelope");
    }
  });

  it("rotate never projects the envelope back to the caller", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    await repo.rotateSecretMetadata("org-001", "sec-001", CREATED_BY);
    // The version-append CTE references the column; the final projection —
    // everything after the last SELECT — must stay on the safe columns.
    const finalSelect = queries[0]!.text.split("SELECT").pop()!;
    expect(finalSelect).not.toContain("ciphertext_envelope");
    expect(finalSelect).not.toContain("*");
  });
});

describe("JSONB value round-trip (fetch_types:false regression)", () => {
  // The Hyperdrive executor disables OID type parsing, so JSONB columns
  // arrive as RAW JSON TEXT. A stored string setting must NOT read back
  // quoted — this exact bug made the dispatch-model picker and the copilot
  // flag silently fail every string comparison.
  it("parses a raw-text JSONB string value back to the string", async () => {
    const row = { ...SAMPLE_SETTING_ROW, key: "dispatch.copilot", value: '"on"' };
    const { executor } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSetting("org-001", "set-001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe("on");
  });

  it("parses raw-text JSONB objects and passes parsed/unparseable values through", async () => {
    const objRow = { ...SAMPLE_SETTING_ROW, value: '{"dark":true}' };
    const { executor } = createFakeExecutor({ rows: [objRow] });
    const repo = createConfigRepository(executor);
    const obj = await repo.getSetting("org-001", "set-001");
    if (obj.ok) expect(obj.value.value).toEqual({ dark: true });

    // Driver-parsed values (objects) and non-JSON strings pass through.
    const parsedRow = { ...SAMPLE_SETTING_ROW, value: { dark: true } };
    const { executor: e2 } = createFakeExecutor({ rows: [parsedRow] });
    const p = await createConfigRepository(e2).getSetting("org-001", "set-001");
    if (p.ok) expect(p.value.value).toEqual({ dark: true });
  });
});
