import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { ConfigResult, EnvelopeVersionCounts, SecretDek, SecretDekRepository } from "./types.js";

// ── Row mapper ─────────────────────────────────────────────

function mapSecretDek(row: Record<string, unknown>): SecretDek {
  return {
    orgId: row.org_id as string,
    generation: Number(row.generation),
    wrappedDek: row.wrapped_dek as string,
    state: row.state as string,
    createdAt: new Date(row.created_at as string),
  };
}

function safeError(message: string): ConfigResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

// ── Repository factory ─────────────────────────────────────

/**
 * Wrapped workspace DEK storage (saas-secret-manager SM2). Rows hold DEK
 * ciphertext under the KEK only — this repository never sees, logs, or
 * returns unwrapped key bytes; wrap/unwrap happens in config-worker memory.
 */
export function createSecretDekRepository(executor: SqlExecutor): SecretDekRepository {
  return {
    async getActiveDek(orgId: string): Promise<ConfigResult<SecretDek>> {
      try {
        // convert_from: wrapped_dek is JSON text stored as BYTEA — a bare
        // ::text cast would yield the \x hex form, not the document.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT org_id, generation, convert_from(wrapped_dek, 'UTF8') AS wrapped_dek, state, created_at
           FROM config.secret_deks
           WHERE org_id = $1 AND state = 'active'
           ORDER BY generation DESC
           LIMIT 1`,
          [orgId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretDek(result.rows[0]!) };
      } catch {
        return safeError("Failed to get active DEK");
      }
    },

    async insertDek(orgId: string, generation: number, wrappedDek: string): Promise<ConfigResult<{ inserted: boolean }>> {
      try {
        // ON CONFLICT DO NOTHING: the get-or-create race (two first writers
        // minting generation 1) converges on one row; losers re-SELECT.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO config.secret_deks (org_id, generation, wrapped_dek, state, created_at)
           VALUES ($1, $2, $3, 'active', now())
           ON CONFLICT (org_id, generation) DO NOTHING`,
          [orgId, generation, wrappedDek],
        );
        return { ok: true, value: { inserted: result.rowCount > 0 } };
      } catch {
        return safeError("Failed to insert DEK");
      }
    },

    async countEnvelopeVersions(orgId?: string): Promise<ConfigResult<EnvelopeVersionCounts>> {
      try {
        // The envelope is JSON text stored as BYTEA; a serialized-JSON LIKE
        // probe on convert_from() classifies the format version without the
        // ciphertext ever leaving SQL — counts only, never envelope bytes.
        const v2Probe = `convert_from(sv.ciphertext_envelope, 'UTF8') LIKE '%"v":2%'`;
        const sql = orgId !== undefined
          ? `SELECT
               COUNT(*) FILTER (WHERE NOT (${v2Probe}))::int AS v1_count,
               COUNT(*) FILTER (WHERE ${v2Probe})::int AS v2_count
             FROM config.secret_versions sv
             JOIN config.secret_metadata sm ON sm.id = sv.secret_id
             WHERE sm.org_id = $1`
          : `SELECT
               COUNT(*) FILTER (WHERE NOT (${v2Probe}))::int AS v1_count,
               COUNT(*) FILTER (WHERE ${v2Probe})::int AS v2_count
             FROM config.secret_versions sv`;
        const result = await executor.execute<Record<string, unknown>>(sql, orgId !== undefined ? [orgId] : []);
        const row = result.rows[0];
        return {
          ok: true,
          value: { v1Count: Number(row?.v1_count ?? 0), v2Count: Number(row?.v2_count ?? 0) },
        };
      } catch {
        return safeError("Failed to count envelope versions");
      }
    },
  };
}
