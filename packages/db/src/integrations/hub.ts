// Integration-hub repository (saas-integration-hub IH0): parent-credential
// custody, the minted-credential ledger, and the per-provider facts tables
// behind migration 730_integration_hub_foundation.
//
// Lives beside the IG repository (repository.ts) rather than inside it so the
// IH substrate is an additive module: the shipped connection/repo-link/inbox
// surface is untouched.
//
// Custody rules (design §3): provider_credentials.ciphertext is WRITE-ONLY at
// the API boundary — this repository returns it (the worker must decrypt) but
// it must never cross a public surface or appear in logs; rows are zeroized
// (deleted) on connection revoke. minted_credentials never stores values.

import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  CursorPosition,
  IntegrationsResult,
  PagedResult,
  PageQueryParams,
} from "./types.js";

// ── Entity types ────────────────────────────────────────────

export type ProviderCredentialKind =
  | "slack_bot_token"
  | "cloudflare_parent_token"
  | "cloudflare_refresh_token"
  | "cloudflare_pkce_verifier"
  | "supabase_refresh_token"
  | "supabase_access_token_cache"
  | "supabase_pkce_verifier";

export interface ProviderCredential {
  id: string;
  connectionId: string;
  kind: ProviderCredentialKind;
  /** AES-256-GCM envelope — never expose through a public API or log. */
  ciphertext: string;
  scopes: Record<string, unknown> | unknown[] | null;
  externalRef: string | null;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertProviderCredentialInput {
  id: string;
  connectionId: Uuid;
  kind: ProviderCredentialKind;
  ciphertext: string;
  scopes?: Record<string, unknown> | unknown[] | null;
  externalRef?: string | null;
  expiresAt?: Date | null;
}

export type MintPurpose = "api" | "secret_resolve";

export type MintRevokeStatus = "pending" | "revoked" | "expired" | "orphaned";

export interface MintedCredential {
  id: string;
  orgId: string;
  connectionId: string;
  provider: string;
  template: string;
  params: Record<string, unknown> | null;
  purpose: MintPurpose;
  requestedBy: string | null;
  runId: string | null;
  jobId: string | null;
  ttlSeconds: number;
  providerRef: string | null;
  mintedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeStatus: MintRevokeStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertMintedCredentialInput {
  id: string;
  orgId: Uuid;
  connectionId: Uuid;
  provider: string;
  template: string;
  params?: Record<string, unknown> | null;
  purpose: MintPurpose;
  requestedBy?: string | null;
  runId?: string | null;
  jobId?: string | null;
  ttlSeconds: number;
  providerRef?: string | null;
  expiresAt: Date;
}

export interface MarkMintedCredentialInput {
  revokeStatus: MintRevokeStatus;
  revokedAt?: Date | null;
}

export interface ListMintedCredentialsQuery {
  connectionId?: Uuid;
  purpose?: MintPurpose;
}

export interface SlackWorkspace {
  id: string;
  /** Null = orphaned callback (recorded, never auto-bound). */
  connectionId: string | null;
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  botUserId: string | null;
  appId: string | null;
  grantedScopes: unknown[] | null;
  installedByExternalUser: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSlackWorkspaceInput {
  id: string;
  connectionId?: Uuid | null;
  teamId: string;
  teamName?: string | null;
  enterpriseId?: string | null;
  botUserId?: string | null;
  appId?: string | null;
  grantedScopes?: unknown[] | null;
  installedByExternalUser?: string | null;
}

export type CloudflareTokenStatus = "active" | "expiring" | "invalid";

export interface CloudflareAccount {
  id: string;
  connectionId: string | null;
  accountExternalId: string;
  accountName: string | null;
  parentTokenRef: string | null;
  grantedPolicies: unknown[] | null;
  tokenStatus: CloudflareTokenStatus;
  parentExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertCloudflareAccountInput {
  id: string;
  connectionId?: Uuid | null;
  accountExternalId: string;
  accountName?: string | null;
  parentTokenRef?: string | null;
  grantedPolicies?: unknown[] | null;
  tokenStatus?: CloudflareTokenStatus;
  parentExpiresAt?: Date | null;
}

export interface SupabaseOrg {
  id: string;
  connectionId: string | null;
  supabaseOrgId: string;
  orgName: string | null;
  grantedScopes: unknown[] | null;
  projects: unknown[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertSupabaseOrgInput {
  id: string;
  connectionId?: Uuid | null;
  supabaseOrgId: string;
  orgName?: string | null;
  grantedScopes?: unknown[] | null;
  projects?: unknown[] | null;
}

// ── Repository interface ────────────────────────────────────

export interface IntegrationHubRepository {
  // Parent-credential custody
  upsertProviderCredential(
    input: UpsertProviderCredentialInput,
  ): Promise<IntegrationsResult<ProviderCredential>>;
  getProviderCredential(
    connectionId: Uuid,
    kind: ProviderCredentialKind,
  ): Promise<IntegrationsResult<ProviderCredential>>;
  /** Zeroize: hard-delete every custody row for a revoked connection. */
  deleteProviderCredentials(
    connectionId: Uuid,
  ): Promise<IntegrationsResult<{ deleted: number }>>;
  /** Delete ONE custody row (e.g. a consumed PKCE verifier, IH6). */
  deleteProviderCredential(
    connectionId: Uuid,
    kind: ProviderCredentialKind,
  ): Promise<IntegrationsResult<{ deleted: number }>>;

  // Minted-credential ledger
  insertMintedCredential(
    input: InsertMintedCredentialInput,
  ): Promise<IntegrationsResult<MintedCredential>>;
  getMintedCredential(orgId: Uuid, id: Uuid): Promise<IntegrationsResult<MintedCredential>>;
  listMintedCredentials(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListMintedCredentialsQuery,
  ): Promise<IntegrationsResult<PagedResult<MintedCredential>>>;
  markMintedCredential(
    id: Uuid,
    input: MarkMintedCredentialInput,
  ): Promise<IntegrationsResult<MintedCredential>>;
  /** Revoke fan-out on connection revoke: live (pending) mints, oldest first. */
  listLiveMintedCredentials(
    connectionId: Uuid,
  ): Promise<IntegrationsResult<MintedCredential[]>>;
  /** Rate limiting (IH4): mints in the org since a cutoff. */
  countMintedCredentialsSince(orgId: Uuid, since: Date): Promise<IntegrationsResult<number>>;
  /** Expiry sweep (IH9): flip past-due pending mints to expired; returns the count. */
  bulkExpireMintedCredentials(before: Date, limit: number): Promise<IntegrationsResult<number>>;

  // Slack workspace facts
  upsertSlackWorkspace(
    input: UpsertSlackWorkspaceInput,
  ): Promise<IntegrationsResult<SlackWorkspace>>;
  getSlackWorkspaceByTeamId(teamId: string): Promise<IntegrationsResult<SlackWorkspace>>;
  getSlackWorkspaceByConnectionId(
    connectionId: Uuid,
  ): Promise<IntegrationsResult<SlackWorkspace>>;
  /** Re-auth (IH9): rebind a workspace to a new connection — explicit, never via upsert. */
  rebindSlackWorkspace(
    teamId: string,
    connectionId: Uuid,
  ): Promise<IntegrationsResult<SlackWorkspace>>;

  // Cloudflare account facts
  upsertCloudflareAccount(
    input: UpsertCloudflareAccountInput,
  ): Promise<IntegrationsResult<CloudflareAccount>>;
  getCloudflareAccountByConnectionId(
    connectionId: Uuid,
  ): Promise<IntegrationsResult<CloudflareAccount>>;
  /** Re-auth/tenancy guard (IH9): the current binding for a provider-side account. */
  getCloudflareAccountByExternalId(
    accountExternalId: string,
  ): Promise<IntegrationsResult<CloudflareAccount>>;
  /** Health/orphan sweep enumeration (IH9): connected fact rows, stalest first. */
  listCloudflareAccountsForSweep(
    limit: number,
  ): Promise<IntegrationsResult<Array<CloudflareAccount & { orgId: string; connectionStatus: string }>>>;

  // Supabase org facts
  upsertSupabaseOrg(input: UpsertSupabaseOrgInput): Promise<IntegrationsResult<SupabaseOrg>>;
  getSupabaseOrgByConnectionId(connectionId: Uuid): Promise<IntegrationsResult<SupabaseOrg>>;
  /** Re-auth/tenancy guard (IH9): the current binding for a provider-side org. */
  getSupabaseOrgByExternalId(supabaseOrgId: string): Promise<IntegrationsResult<SupabaseOrg>>;
  /** Health/orphan sweep enumeration (IH9): connected fact rows, stalest first. */
  listSupabaseOrgsForSweep(
    limit: number,
  ): Promise<IntegrationsResult<Array<SupabaseOrg & { orgId: string; connectionStatus: string }>>>;
}

// ── Helpers (mirrors repository.ts conventions) ─────────────

function safeError(message: string): IntegrationsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function notFound(): IntegrationsResult<never> {
  return { ok: false, error: { kind: "not_found" } };
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

function dateOrNull(v: unknown): Date | null {
  return v == null ? null : toDate(v);
}

function jsonOrNull(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

// ── Row mappers ─────────────────────────────────────────────

function mapProviderCredential(row: Record<string, unknown>): ProviderCredential {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    kind: row.kind as ProviderCredentialKind,
    ciphertext: row.ciphertext as string,
    scopes: parseJson(row.scopes),
    externalRef: (row.external_ref as string) ?? null,
    expiresAt: dateOrNull(row.expires_at),
    rotatedAt: dateOrNull(row.rotated_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapMintedCredential(row: Record<string, unknown>): MintedCredential {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    connectionId: row.connection_id as string,
    provider: row.provider as string,
    template: row.template as string,
    params: parseJson(row.params),
    purpose: row.purpose as MintPurpose,
    requestedBy: (row.requested_by as string) ?? null,
    runId: (row.run_id as string) ?? null,
    jobId: (row.job_id as string) ?? null,
    ttlSeconds: Number(row.ttl_seconds),
    providerRef: (row.provider_ref as string) ?? null,
    mintedAt: toDate(row.minted_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: dateOrNull(row.revoked_at),
    revokeStatus: row.revoke_status as MintRevokeStatus,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapSlackWorkspace(row: Record<string, unknown>): SlackWorkspace {
  return {
    id: row.id as string,
    connectionId: (row.connection_id as string) ?? null,
    teamId: row.team_id as string,
    teamName: (row.team_name as string) ?? null,
    enterpriseId: (row.enterprise_id as string) ?? null,
    botUserId: (row.bot_user_id as string) ?? null,
    appId: (row.app_id as string) ?? null,
    grantedScopes: parseJson(row.granted_scopes),
    installedByExternalUser: (row.installed_by_external_user as string) ?? null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapCloudflareAccount(row: Record<string, unknown>): CloudflareAccount {
  return {
    id: row.id as string,
    connectionId: (row.connection_id as string) ?? null,
    accountExternalId: row.account_external_id as string,
    accountName: (row.account_name as string) ?? null,
    parentTokenRef: (row.parent_token_ref as string) ?? null,
    grantedPolicies: parseJson(row.granted_policies),
    tokenStatus: row.token_status as CloudflareTokenStatus,
    parentExpiresAt: dateOrNull(row.parent_expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapCloudflareAccountForSweep(
  row: Record<string, unknown>,
): CloudflareAccount & { orgId: string; connectionStatus: string } {
  return {
    ...mapCloudflareAccount(row),
    orgId: row.org_id as string,
    connectionStatus: row.connection_status as string,
  };
}

function mapSupabaseOrg(row: Record<string, unknown>): SupabaseOrg {
  return {
    id: row.id as string,
    connectionId: (row.connection_id as string) ?? null,
    supabaseOrgId: row.supabase_org_id as string,
    orgName: (row.org_name as string) ?? null,
    grantedScopes: parseJson(row.granted_scopes),
    projects: parseJson(row.projects),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapSupabaseOrgForSweep(
  row: Record<string, unknown>,
): SupabaseOrg & { orgId: string; connectionStatus: string } {
  return {
    ...mapSupabaseOrg(row),
    orgId: row.org_id as string,
    connectionStatus: row.connection_status as string,
  };
}

// ── Repository factory ──────────────────────────────────────

export function createIntegrationHubRepository(executor: SqlExecutor): IntegrationHubRepository {
  return {
    // ── Parent-credential custody ─────────────────────────
    async upsertProviderCredential(input) {
      try {
        const result = await executor.execute(
          `INSERT INTO integrations.provider_credentials
             (id, connection_id, kind, ciphertext, scopes, external_ref, expires_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (connection_id, kind) DO UPDATE SET
             ciphertext = EXCLUDED.ciphertext,
             scopes = EXCLUDED.scopes,
             external_ref = EXCLUDED.external_ref,
             expires_at = EXCLUDED.expires_at,
             rotated_at = now(),
             updated_at = now()
           RETURNING *`,
          [
            input.id,
            input.connectionId,
            input.kind,
            input.ciphertext,
            jsonOrNull(input.scopes),
            input.externalRef ?? null,
            input.expiresAt ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) return safeError("provider credential upsert returned no row");
        return { ok: true, value: mapProviderCredential(row) };
      } catch (err) {
        return safeError(`provider credential upsert failed: ${String(err)}`);
      }
    },

    async getProviderCredential(connectionId, kind) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.provider_credentials
           WHERE connection_id = $1 AND kind = $2`,
          [connectionId, kind],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapProviderCredential(row) };
      } catch (err) {
        return safeError(`provider credential read failed: ${String(err)}`);
      }
    },

    async deleteProviderCredentials(connectionId) {
      try {
        const result = await executor.execute(
          `DELETE FROM integrations.provider_credentials WHERE connection_id = $1`,
          [connectionId],
        );
        return { ok: true, value: { deleted: result.rowCount ?? 0 } };
      } catch (err) {
        return safeError(`provider credential zeroize failed: ${String(err)}`);
      }
    },

    async deleteProviderCredential(connectionId, kind) {
      try {
        const result = await executor.execute(
          `DELETE FROM integrations.provider_credentials
           WHERE connection_id = $1 AND kind = $2`,
          [connectionId, kind],
        );
        return { ok: true, value: { deleted: result.rowCount ?? 0 } };
      } catch (err) {
        return safeError(`provider credential delete failed: ${String(err)}`);
      }
    },

    // ── Minted-credential ledger ──────────────────────────
    async insertMintedCredential(input) {
      try {
        const result = await executor.execute(
          `INSERT INTO integrations.minted_credentials
             (id, org_id, connection_id, provider, template, params, purpose,
              requested_by, run_id, job_id, ttl_seconds, provider_ref, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.connectionId,
            input.provider,
            input.template,
            jsonOrNull(input.params),
            input.purpose,
            input.requestedBy ?? null,
            input.runId ?? null,
            input.jobId ?? null,
            input.ttlSeconds,
            input.providerRef ?? null,
            input.expiresAt,
          ],
        );
        const row = result.rows[0];
        if (!row) return safeError("minted credential insert returned no row");
        return { ok: true, value: mapMintedCredential(row) };
      } catch (err) {
        return safeError(`minted credential insert failed: ${String(err)}`);
      }
    },

    async getMintedCredential(orgId, id) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.minted_credentials WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapMintedCredential(row) };
      } catch (err) {
        return safeError(`minted credential read failed: ${String(err)}`);
      }
    },

    async listMintedCredentials(orgId, params, query) {
      try {
        const conditions = ["org_id = $1"];
        const values: unknown[] = [orgId];
        if (query?.connectionId) {
          values.push(query.connectionId);
          conditions.push(`connection_id = $${values.length}`);
        }
        if (query?.purpose) {
          values.push(query.purpose);
          conditions.push(`purpose = $${values.length}`);
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          conditions.push(
            `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
          );
        }
        values.push(params.limit + 1);
        const result = await executor.execute(
          `SELECT * FROM integrations.minted_credentials
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );
        const rows = result.rows.slice(0, params.limit);
        const items = rows.map(mapMintedCredential);
        let nextCursor: CursorPosition | null = null;
        if (result.rows.length > params.limit && rows.length > 0) {
          const last = items[items.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items, nextCursor } };
      } catch (err) {
        return safeError(`minted credential list failed: ${String(err)}`);
      }
    },

    async markMintedCredential(id, input) {
      try {
        const result = await executor.execute(
          `UPDATE integrations.minted_credentials
           SET revoke_status = $2, revoked_at = $3, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [id, input.revokeStatus, input.revokedAt ?? null],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapMintedCredential(row) };
      } catch (err) {
        return safeError(`minted credential mark failed: ${String(err)}`);
      }
    },

    async listLiveMintedCredentials(connectionId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.minted_credentials
           WHERE connection_id = $1 AND revoke_status = 'pending'
           ORDER BY expires_at ASC`,
          [connectionId],
        );
        return { ok: true, value: result.rows.map(mapMintedCredential) };
      } catch (err) {
        return safeError(`live minted credential list failed: ${String(err)}`);
      }
    },

    async countMintedCredentialsSince(orgId, since) {
      try {
        const result = await executor.execute(
          `SELECT COUNT(*)::int AS count FROM integrations.minted_credentials
           WHERE org_id = $1 AND minted_at >= $2`,
          [orgId, since],
        );
        return { ok: true, value: Number(result.rows[0]?.count ?? 0) };
      } catch (err) {
        return safeError(`minted credential count failed: ${String(err)}`);
      }
    },

    async bulkExpireMintedCredentials(before, limit) {
      try {
        const result = await executor.execute(
          `UPDATE integrations.minted_credentials
           SET revoke_status = 'expired', revoked_at = expires_at, updated_at = now()
           WHERE id IN (
             SELECT id FROM integrations.minted_credentials
             WHERE revoke_status = 'pending' AND expires_at < $1
             ORDER BY expires_at ASC
             LIMIT $2
           )
           RETURNING id`,
          [before, limit],
        );
        return { ok: true, value: result.rows.length };
      } catch (err) {
        return safeError(`minted credential bulk expire failed: ${String(err)}`);
      }
    },

    // ── Slack workspace facts ─────────────────────────────
    async upsertSlackWorkspace(input) {
      try {
        const result = await executor.execute(
          `INSERT INTO integrations.slack_workspaces
             (id, connection_id, team_id, team_name, enterprise_id, bot_user_id,
              app_id, granted_scopes, installed_by_external_user)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (team_id) DO UPDATE SET
             connection_id = COALESCE(EXCLUDED.connection_id, integrations.slack_workspaces.connection_id),
             team_name = EXCLUDED.team_name,
             enterprise_id = EXCLUDED.enterprise_id,
             bot_user_id = EXCLUDED.bot_user_id,
             app_id = EXCLUDED.app_id,
             granted_scopes = EXCLUDED.granted_scopes,
             installed_by_external_user = EXCLUDED.installed_by_external_user,
             updated_at = now()
           RETURNING *`,
          [
            input.id,
            input.connectionId ?? null,
            input.teamId,
            input.teamName ?? null,
            input.enterpriseId ?? null,
            input.botUserId ?? null,
            input.appId ?? null,
            jsonOrNull(input.grantedScopes),
            input.installedByExternalUser ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) return safeError("slack workspace upsert returned no row");
        return { ok: true, value: mapSlackWorkspace(row) };
      } catch (err) {
        return safeError(`slack workspace upsert failed: ${String(err)}`);
      }
    },

    async getSlackWorkspaceByTeamId(teamId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.slack_workspaces WHERE team_id = $1`,
          [teamId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapSlackWorkspace(row) };
      } catch (err) {
        return safeError(`slack workspace read failed: ${String(err)}`);
      }
    },

    async getSlackWorkspaceByConnectionId(connectionId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.slack_workspaces WHERE connection_id = $1`,
          [connectionId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapSlackWorkspace(row) };
      } catch (err) {
        return safeError(`slack workspace read failed: ${String(err)}`);
      }
    },

    async rebindSlackWorkspace(teamId, connectionId) {
      try {
        const result = await executor.execute(
          `UPDATE integrations.slack_workspaces
           SET connection_id = $2, updated_at = now()
           WHERE team_id = $1
           RETURNING *`,
          [teamId, connectionId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapSlackWorkspace(row) };
      } catch (err) {
        return safeError(`slack workspace rebind failed: ${String(err)}`);
      }
    },

    // ── Cloudflare account facts ──────────────────────────
    async upsertCloudflareAccount(input) {
      try {
        const result = await executor.execute(
          `INSERT INTO integrations.cloudflare_accounts
             (id, connection_id, account_external_id, account_name,
              parent_token_ref, granted_policies, token_status, parent_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           ON CONFLICT (account_external_id) DO UPDATE SET
             connection_id = EXCLUDED.connection_id,
             account_name = EXCLUDED.account_name,
             parent_token_ref = EXCLUDED.parent_token_ref,
             granted_policies = EXCLUDED.granted_policies,
             token_status = EXCLUDED.token_status,
             parent_expires_at = EXCLUDED.parent_expires_at,
             updated_at = now()
           RETURNING *`,
          [
            input.id,
            input.connectionId ?? null,
            input.accountExternalId,
            input.accountName ?? null,
            input.parentTokenRef ?? null,
            jsonOrNull(input.grantedPolicies),
            input.tokenStatus ?? "active",
            input.parentExpiresAt ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) return safeError("cloudflare account upsert returned no row");
        return { ok: true, value: mapCloudflareAccount(row) };
      } catch (err) {
        return safeError(`cloudflare account upsert failed: ${String(err)}`);
      }
    },

    async getCloudflareAccountByConnectionId(connectionId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.cloudflare_accounts WHERE connection_id = $1`,
          [connectionId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapCloudflareAccount(row) };
      } catch (err) {
        return safeError(`cloudflare account read failed: ${String(err)}`);
      }
    },

    async getCloudflareAccountByExternalId(accountExternalId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.cloudflare_accounts WHERE account_external_id = $1`,
          [accountExternalId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapCloudflareAccount(row) };
      } catch (err) {
        return safeError(`cloudflare account read failed: ${String(err)}`);
      }
    },

    async listCloudflareAccountsForSweep(limit) {
      try {
        const result = await executor.execute(
          `SELECT t.*, c.org_id AS org_id, c.status AS connection_status
           FROM integrations.cloudflare_accounts t
           JOIN integrations.connections c ON c.id = t.connection_id
           ORDER BY t.updated_at ASC
           LIMIT $1`,
          [limit],
        );
        return { ok: true, value: result.rows.map(mapCloudflareAccountForSweep) };
      } catch (err) {
        return safeError(`cloudflare account sweep list failed: ${String(err)}`);
      }
    },

    // ── Supabase org facts ────────────────────────────────
    async upsertSupabaseOrg(input) {
      try {
        const result = await executor.execute(
          `INSERT INTO integrations.supabase_orgs
             (id, connection_id, supabase_org_id, org_name, granted_scopes, projects)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
           ON CONFLICT (supabase_org_id) DO UPDATE SET
             connection_id = EXCLUDED.connection_id,
             org_name = EXCLUDED.org_name,
             granted_scopes = EXCLUDED.granted_scopes,
             projects = EXCLUDED.projects,
             updated_at = now()
           RETURNING *`,
          [
            input.id,
            input.connectionId ?? null,
            input.supabaseOrgId,
            input.orgName ?? null,
            jsonOrNull(input.grantedScopes),
            jsonOrNull(input.projects),
          ],
        );
        const row = result.rows[0];
        if (!row) return safeError("supabase org upsert returned no row");
        return { ok: true, value: mapSupabaseOrg(row) };
      } catch (err) {
        return safeError(`supabase org upsert failed: ${String(err)}`);
      }
    },

    async getSupabaseOrgByConnectionId(connectionId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.supabase_orgs WHERE connection_id = $1`,
          [connectionId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapSupabaseOrg(row) };
      } catch (err) {
        return safeError(`supabase org read failed: ${String(err)}`);
      }
    },

    async getSupabaseOrgByExternalId(supabaseOrgId) {
      try {
        const result = await executor.execute(
          `SELECT * FROM integrations.supabase_orgs WHERE supabase_org_id = $1`,
          [supabaseOrgId],
        );
        const row = result.rows[0];
        if (!row) return notFound();
        return { ok: true, value: mapSupabaseOrg(row) };
      } catch (err) {
        return safeError(`supabase org read failed: ${String(err)}`);
      }
    },

    async listSupabaseOrgsForSweep(limit) {
      try {
        const result = await executor.execute(
          `SELECT t.*, c.org_id AS org_id, c.status AS connection_status
           FROM integrations.supabase_orgs t
           JOIN integrations.connections c ON c.id = t.connection_id
           ORDER BY t.updated_at ASC
           LIMIT $1`,
          [limit],
        );
        return { ok: true, value: result.rows.map(mapSupabaseOrgForSweep) };
      } catch (err) {
        return safeError(`supabase org sweep list failed: ${String(err)}`);
      }
    },
  };
}
