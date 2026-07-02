import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  ConfigRepository,
  ConfigResult,
  CreateFeatureFlagInput,
  CreateSecretMetadataInput,
  CreateSettingInput,
  CursorPosition,
  FeatureFlag,
  PagedResult,
  PageQueryParams,
  PutSecretPolicyInput,
  ResolveScope,
  Scope,
  SecretMetadata,
  SecretPolicyRecord,
  SecretPolicyScope,
  SecretVersion,
  Setting,
  UpdateFeatureFlagInput,
  UpdateSettingInput,
} from "./types.js";

// ── Scope helpers ──────────────────────────────────────────

function scopeColumns(scope: ResolveScope): {
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
} {
  switch (scope.kind) {
    case "organization":
      return { orgId: scope.orgId, projectId: null, environmentId: null, scopeKind: "organization" };
    case "project":
      return { orgId: scope.orgId, projectId: scope.projectId, environmentId: null, scopeKind: "project" };
    case "environment":
      return { orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId, scopeKind: "environment" };
    case "account":
      // An account-scope row lives on the account org's id (no project/env).
      return { orgId: scope.accountId, projectId: null, environmentId: null, scopeKind: "account" };
  }
}

function scopeWhere(scope: ResolveScope): { clause: string; params: unknown[] } {
  switch (scope.kind) {
    case "organization":
      return { clause: "org_id = $1 AND scope_kind = 'organization'", params: [scope.orgId] };
    case "project":
      return { clause: "org_id = $1 AND project_id = $2 AND scope_kind = 'project'", params: [scope.orgId, scope.projectId] };
    case "environment":
      return { clause: "org_id = $1 AND project_id = $2 AND environment_id = $3 AND scope_kind = 'environment'", params: [scope.orgId, scope.projectId, scope.environmentId] };
    case "account":
      return { clause: "org_id = $1 AND scope_kind = 'account'", params: [scope.accountId] };
  }
}

// ── Row mappers ────────────────────────────────────────────

function mapSetting(row: Record<string, unknown>): Setting {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    scopeKind: row.scope_kind as Setting["scopeKind"],
    key: row.key as string,
    value: row.value,
    description: (row.description as string) ?? null,
    overridable: (row.overridable as boolean) ?? true,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapFeatureFlag(row: Record<string, unknown>): FeatureFlag {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    scopeKind: row.scope_kind as FeatureFlag["scopeKind"],
    flagKey: row.flag_key as string,
    enabled: row.enabled as boolean,
    value: row.value ?? null,
    description: (row.description as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSecretMetadata(row: Record<string, unknown>): SecretMetadata {
  // Intentionally omit ciphertext_envelope — never expose through repository
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    scopeKind: row.scope_kind as SecretMetadata["scopeKind"],
    secretKey: row.secret_key as string,
    displayName: (row.display_name as string) ?? null,
    status: row.status as string,
    version: row.version as number,
    rotationPolicy: (row.rotation_policy as string) ?? null,
    lastRotatedAt: row.last_rotated_at ? new Date(row.last_rotated_at as string) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    createdBy: row.created_by as string,
    personalOwner: (row.personal_owner as string) ?? null,
    overridable: (row.overridable as boolean) ?? true,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSecretVersion(row: Record<string, unknown>): SecretVersion {
  // Intentionally omits ciphertext_envelope — version reads are metadata only.
  return {
    secretId: row.secret_id as string,
    version: row.version as number,
    status: row.status as string,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
  };
}

function mapSecretPolicy(row: Record<string, unknown>): SecretPolicyRecord {
  const doc = row.document;
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    name: row.name as string,
    tier: row.tier as SecretPolicyRecord["tier"],
    source: row.source as string,
    document: (typeof doc === "string" ? JSON.parse(doc) : doc) as Record<string, unknown>,
    documentHash: row.document_hash as string,
    createdAt: new Date(row.created_at as string),
  };
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ── Secret metadata safe columns (no ciphertext_envelope) ──

const SECRET_METADATA_SAFE_COLUMNS = `id, org_id, project_id, environment_id, scope_kind, secret_key, display_name, status, version, rotation_policy, last_rotated_at, expires_at, created_by, personal_owner, overridable, last_used_at, created_at, updated_at`;

const SECRET_VERSION_SAFE_COLUMNS = `secret_id, version, status, created_by, created_at`;

function safeError(message: string): ConfigResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23514"
  );
}

// ── Paged list helper ──────────────────────────────────────

async function pagedList<T>(
  executor: SqlExecutor,
  table: string,
  scope: ResolveScope,
  params: PageQueryParams,
  mapper: (row: Record<string, unknown>) => T,
  selectColumns = "*",
): Promise<ConfigResult<PagedResult<T>>> {
  return pagedListWhere(executor, table, scopeWhere(scope), params, mapper, selectColumns);
}

async function pagedListWhere<T>(
  executor: SqlExecutor,
  table: string,
  sw: { clause: string; params: unknown[] },
  params: PageQueryParams,
  mapper: (row: Record<string, unknown>) => T,
  selectColumns = "*",
): Promise<ConfigResult<PagedResult<T>>> {
  try {
    const fetchLimit = params.limit + 1;
    const baseIdx = sw.params.length;
    let sql: string;
    let values: unknown[];
    if (params.cursor) {
      sql = `SELECT ${selectColumns} FROM ${table}
       WHERE ${sw.clause}
         AND (created_at, id) < ($${baseIdx + 2}, $${baseIdx + 3})
       ORDER BY created_at DESC, id DESC
       LIMIT $${baseIdx + 1}`;
      values = [...sw.params, fetchLimit, params.cursor.createdAt, params.cursor.id];
    } else {
      sql = `SELECT ${selectColumns} FROM ${table}
       WHERE ${sw.clause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${baseIdx + 1}`;
      values = [...sw.params, fetchLimit];
    }
    const result = await executor.execute<Record<string, unknown>>(sql, values);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > params.limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError(`Failed to list from ${table}`);
  }
}

// ── Repository factory ─────────────────────────────────────

export function createConfigRepository(executor: SqlExecutor): ConfigRepository {
  return {
    // ── Settings ──────────────────────────────────────────

    async createSetting(input: CreateSettingInput): Promise<ConfigResult<Setting>> {
      try {
        const sc = scopeColumns(input.scope);
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO config.settings (id, org_id, project_id, environment_id, scope_kind, key, value, description, overridable, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
           ON CONFLICT (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), key) DO NOTHING
           RETURNING *`,
          [input.id, sc.orgId, sc.projectId, sc.environmentId, sc.scopeKind, input.key, JSON.stringify(input.value), input.description ?? null, input.overridable ?? true],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "setting" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "setting" } };
        }
        if (isCheckViolation(err)) {
          return safeError("Invalid scope for setting");
        }
        return safeError("Failed to create setting");
      }
    },

    async updateSetting(orgId: string, settingId: string, input: UpdateSettingInput): Promise<ConfigResult<Setting>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config.settings
           SET value = $3, description = COALESCE($4, description), updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING *`,
          [orgId, settingId, JSON.stringify(input.value), input.description ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch {
        return safeError("Failed to update setting");
      }
    },

    async getSetting(orgId: string, settingId: string): Promise<ConfigResult<Setting>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM config.settings WHERE org_id = $1 AND id = $2`,
          [orgId, settingId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch {
        return safeError("Failed to get setting");
      }
    },

    async getSettingByScopeKey(scope: ResolveScope, key: string): Promise<ConfigResult<Setting>> {
      try {
        const sw = scopeWhere(scope);
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM config.settings WHERE ${sw.clause} AND key = $${sw.params.length + 1}`,
          [...sw.params, key],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch {
        return safeError("Failed to get setting by scope/key");
      }
    },

    async listSettings(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<Setting>>> {
      return pagedList(executor, "config.settings", scope, params, mapSetting);
    },

    // ── Feature flags ─────────────────────────────────────

    async createFeatureFlag(input: CreateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>> {
      try {
        const sc = scopeColumns(input.scope);
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO config.feature_flags (id, org_id, project_id, environment_id, scope_kind, flag_key, enabled, value, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
           ON CONFLICT (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), flag_key) DO NOTHING
           RETURNING *`,
          [input.id, sc.orgId, sc.projectId, sc.environmentId, sc.scopeKind, input.flagKey, input.enabled ?? false, input.value ? JSON.stringify(input.value) : null, input.description ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "feature_flag" } };
        }
        return { ok: true, value: mapFeatureFlag(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "feature_flag" } };
        }
        if (isCheckViolation(err)) {
          return safeError("Invalid scope for feature flag");
        }
        return safeError("Failed to create feature flag");
      }
    },

    async updateFeatureFlag(orgId: string, flagId: string, input: UpdateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>> {
      try {
        const setClauses: string[] = ["updated_at = now()"];
        const values: unknown[] = [orgId, flagId];
        let idx = 3;
        if (input.enabled !== undefined) {
          setClauses.push(`enabled = $${idx}`);
          values.push(input.enabled);
          idx++;
        }
        if (input.value !== undefined) {
          setClauses.push(`value = $${idx}`);
          values.push(JSON.stringify(input.value));
          idx++;
        }
        if (input.description !== undefined) {
          setClauses.push(`description = $${idx}`);
          values.push(input.description);
          idx++;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config.feature_flags SET ${setClauses.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`,
          values,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapFeatureFlag(result.rows[0]!) };
      } catch {
        return safeError("Failed to update feature flag");
      }
    },

    async getFeatureFlag(orgId: string, flagId: string): Promise<ConfigResult<FeatureFlag>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM config.feature_flags WHERE org_id = $1 AND id = $2`,
          [orgId, flagId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapFeatureFlag(result.rows[0]!) };
      } catch {
        return safeError("Failed to get feature flag");
      }
    },

    async listFeatureFlags(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<FeatureFlag>>> {
      return pagedList(executor, "config.feature_flags", scope, params, mapFeatureFlag);
    },

    // ── Secret metadata ───────────────────────────────────

    async createSecretMetadata(input: CreateSecretMetadataInput): Promise<ConfigResult<SecretMetadata>> {
      try {
        const sc = scopeColumns(input.scope);
        const hasCiphertext = input.ciphertextEnvelope !== undefined;
        // With an envelope, version 1 is appended to config.secret_versions in the
        // same statement (a data-modifying CTE) so head + history stay atomic even
        // without an explicit transaction.
        const sql = hasCiphertext
          ? `WITH head AS (
             INSERT INTO config.secret_metadata (id, org_id, project_id, environment_id, scope_kind, secret_key, display_name, status, version, rotation_policy, expires_at, created_by, personal_owner, overridable, ciphertext_envelope, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1, $8, $9, $10, $11, $12, $13, now(), now())
             RETURNING *
           ), version_append AS (
             INSERT INTO config.secret_versions (secret_id, version, ciphertext_envelope, created_by)
             SELECT id, version, ciphertext_envelope, created_by FROM head
           )
           SELECT ${SECRET_METADATA_SAFE_COLUMNS} FROM head`
          : `INSERT INTO config.secret_metadata (id, org_id, project_id, environment_id, scope_kind, secret_key, display_name, status, version, rotation_policy, expires_at, created_by, personal_owner, overridable, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1, $8, $9, $10, $11, $12, now(), now())
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`;
        const params = [input.id, sc.orgId, sc.projectId, sc.environmentId, sc.scopeKind, input.secretKey, input.displayName ?? null, input.rotationPolicy ?? null, input.expiresAt?.toISOString() ?? null, input.createdBy, input.personalOwner ?? null, input.overridable ?? true];
        if (hasCiphertext) {
          params.push(input.ciphertextEnvelope!);
        }
        const result = await executor.execute<Record<string, unknown>>(sql, params);
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "secret_metadata" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "secret_metadata" } };
        }
        if (isCheckViolation(err)) {
          return safeError("Invalid scope for secret metadata");
        }
        return safeError("Failed to create secret metadata");
      }
    },

    async listSecretMetadata(scope: ResolveScope, params: PageQueryParams, viewerSubjectId?: string): Promise<ConfigResult<PagedResult<SecretMetadata>>> {
      // A personal overlay is visible only to its owner: without a viewer every
      // personal row is excluded; with one, only that viewer's rows join the list.
      const sw = scopeWhere(scope);
      const whereParams = [...sw.params];
      let clause = sw.clause;
      if (viewerSubjectId !== undefined) {
        whereParams.push(viewerSubjectId);
        clause += ` AND (personal_owner IS NULL OR personal_owner = $${whereParams.length})`;
      } else {
        clause += ` AND personal_owner IS NULL`;
      }
      return pagedListWhere(executor, "config.secret_metadata", { clause, params: whereParams }, params, mapSecretMetadata, SECRET_METADATA_SAFE_COLUMNS);
    },

    async getSecretMetadataByScopeKey(scope: ResolveScope, key: string, personalOwner?: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        const sw = scopeWhere(scope);
        const values = [...sw.params, key];
        let personalClause = "personal_owner IS NULL";
        if (personalOwner !== undefined) {
          values.push(personalOwner);
          personalClause = `personal_owner = $${values.length}`;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${SECRET_METADATA_SAFE_COLUMNS} FROM config.secret_metadata
           WHERE ${sw.clause} AND secret_key = $${sw.params.length + 1} AND ${personalClause}
             AND status IN ('active', 'rotated')`,
          values,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to get secret metadata by scope/key");
      }
    },

    async getSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${SECRET_METADATA_SAFE_COLUMNS} FROM config.secret_metadata WHERE org_id = $1 AND id = $2`,
          [orgId, secretId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to get secret metadata");
      }
    },

    async rotateSecretMetadata(orgId: string, secretId: string, createdBy: Uuid, ciphertextEnvelope?: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        // Append, never overwrite (SM1): the head cache is refreshed and the new
        // (secret_id, version) row lands in config.secret_versions in the same
        // statement. A metadata-only rotate (no new envelope) carries the current
        // envelope forward so history stays aligned with the head version.
        const hasCiphertext = ciphertextEnvelope !== undefined;
        const setClause = hasCiphertext
          ? `version = version + 1, last_rotated_at = now(), updated_at = now(), ciphertext_envelope = $4`
          : `version = version + 1, last_rotated_at = now(), updated_at = now()`;
        const sql = `WITH head AS (
           UPDATE config.secret_metadata
           SET ${setClause}
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING *
         ), version_append AS (
           INSERT INTO config.secret_versions (secret_id, version, ciphertext_envelope, created_by)
           SELECT id, version, ciphertext_envelope, $3 FROM head
           WHERE ciphertext_envelope IS NOT NULL
         )
         SELECT ${SECRET_METADATA_SAFE_COLUMNS} FROM head`;
        const params: unknown[] = [orgId, secretId, createdBy];
        if (hasCiphertext) {
          params.push(ciphertextEnvelope);
        }
        const result = await executor.execute<Record<string, unknown>>(sql, params);
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to rotate secret metadata");
      }
    },

    async revokeSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config.secret_metadata
           SET status = 'revoked', updated_at = now()
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`,
          [orgId, secretId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to revoke secret metadata");
      }
    },

    async listSecretVersions(orgId: string, secretId: string, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretVersion>>> {
      try {
        // Newest first. Tenant isolation rides the metadata join (org_id lives on
        // the head row, not the version rows). Metadata columns only — the
        // envelope never crosses the repository read surface.
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT ${SECRET_VERSION_SAFE_COLUMNS} FROM config.secret_versions
           WHERE secret_id = $2
             AND secret_id IN (SELECT id FROM config.secret_metadata WHERE org_id = $1 AND id = $2)
             AND created_at < $4
           ORDER BY created_at DESC, version DESC
           LIMIT $3`;
          values = [orgId, secretId, fetchLimit, params.cursor.createdAt];
        } else {
          sql = `SELECT ${SECRET_VERSION_SAFE_COLUMNS} FROM config.secret_versions
           WHERE secret_id = $2
             AND secret_id IN (SELECT id FROM config.secret_metadata WHERE org_id = $1 AND id = $2)
           ORDER BY created_at DESC, version DESC
           LIMIT $3`;
          values = [orgId, secretId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapSecretVersion);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          // The version rows share the secret's uuid as the cursor id (the
          // standard cursor shape wants a uuid; created_at carries the position).
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.secretId };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch {
        return safeError("Failed to list secret versions");
      }
    },

    async getSecretCiphertext(secretId: string, version: number): Promise<ConfigResult<string>> {
      try {
        // convert_from: ciphertext_envelope is JSON text stored as BYTEA — a bare
        // ::text cast would yield the \x hex form, not the document. This is the
        // ONE repository read allowed to select ciphertext (SM3 resolve/reveal).
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT convert_from(ciphertext_envelope, 'UTF8') AS ciphertext_envelope
           FROM config.secret_versions
           WHERE secret_id = $1 AND version = $2 AND status = 'active'`,
          [secretId, version],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: result.rows[0]!.ciphertext_envelope as string };
      } catch {
        return safeError("Failed to get secret ciphertext");
      }
    },

    async touchSecretLastUsed(orgId: string, secretId: string, at: Date): Promise<ConfigResult<void>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config.secret_metadata SET last_used_at = $3
           WHERE org_id = $1 AND id = $2`,
          [orgId, secretId, at.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to stamp last_used_at");
      }
    },

    // ── Secret policies (SM3, Layer 2) ─────────────────────

    async putSecretPolicy(input: PutSecretPolicyInput): Promise<ConfigResult<{ record: SecretPolicyRecord; updated: boolean }>> {
      try {
        // Idempotent by document_hash: an unchanged push updates nothing (xmax
        // stays 0 ⇒ no row-version bump), a changed one replaces document + hash
        // in place. `updated` is true only when the stored row actually changed.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO config.secret_policies (id, org_id, project_id, name, tier, source, document, document_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
           ON CONFLICT (org_id, COALESCE(project_id, '${ZERO_UUID}'), tier, name)
             DO UPDATE SET
               document = EXCLUDED.document,
               document_hash = EXCLUDED.document_hash,
               source = EXCLUDED.source
             WHERE config.secret_policies.document_hash <> EXCLUDED.document_hash
           RETURNING *,
             (xmax <> 0) AS was_updated`,
          [input.id, input.orgId, input.projectId ?? null, input.name, input.tier, input.source, JSON.stringify(input.document), input.documentHash],
        );
        if (result.rowCount === 0) {
          // ON CONFLICT ... WHERE guard skipped the update (identical hash): the
          // push is a clean no-op. Re-read the current row so callers still get it.
          const existing = await executor.execute<Record<string, unknown>>(
            `SELECT * FROM config.secret_policies
             WHERE org_id = $1 AND COALESCE(project_id, '${ZERO_UUID}') = COALESCE($2::uuid, '${ZERO_UUID}') AND tier = $3 AND name = $4`,
            [input.orgId, input.projectId ?? null, input.tier, input.name],
          );
          if (existing.rowCount === 0) {
            return safeError("Failed to upsert secret policy");
          }
          return { ok: true, value: { record: mapSecretPolicy(existing.rows[0]!), updated: false } };
        }
        const row = result.rows[0]!;
        return { ok: true, value: { record: mapSecretPolicy(row), updated: (row.was_updated as boolean) === true } };
      } catch (err: unknown) {
        if (isCheckViolation(err)) {
          return safeError("Invalid tier for secret policy");
        }
        return safeError("Failed to upsert secret policy");
      }
    },

    async listSecretPolicies(scope: SecretPolicyScope): Promise<ConfigResult<SecretPolicyRecord[]>> {
      try {
        // Tier order composition → stack → intent (policy-model §5). Workspace-
        // wide documents (project_id NULL) always join; a project id adds that
        // project's documents. Ordered deterministically by (tier, name).
        const values: unknown[] = [scope.orgId];
        let projectClause = "project_id IS NULL";
        if (scope.projectId) {
          values.push(scope.projectId);
          projectClause = `(project_id IS NULL OR project_id = $${values.length})`;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM config.secret_policies
           WHERE org_id = $1 AND ${projectClause}
           ORDER BY
             CASE tier WHEN 'composition' THEN 0 WHEN 'stack' THEN 1 ELSE 2 END,
             name ASC`,
          values,
        );
        return { ok: true, value: result.rows.map(mapSecretPolicy) };
      } catch {
        return safeError("Failed to list secret policies");
      }
    },
  };
}
