// Org-curated scope templates (saas-secrets-platform SP4).
//
// A custom template is a named derivation of a code-declared BASE template:
// the base supplies mint semantics (permission grammar, custody kind, params,
// TTL ceiling); the org supplies identity + display. Versioned; soft-retire
// only — there is no hard delete, so a template can never be deleted out from
// under a live secret.

import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type { IntegrationsResult } from "./types.js";

export type OrgScopeTemplateStatus = "active" | "retired";

export interface OrgScopeTemplate {
  id: Uuid;
  orgId: Uuid;
  provider: string;
  /** The id bindings and create surfaces use (code-template grammar). */
  templateId: string;
  /** The code-declared template supplying mint semantics; custom ⊆ base. */
  baseTemplate: string;
  displayName: string;
  description: string;
  version: number;
  status: OrgScopeTemplateStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrgScopeTemplateInput {
  orgId: Uuid;
  provider: string;
  templateId: string;
  baseTemplate: string;
  displayName: string;
  description: string;
}

export interface UpdateOrgScopeTemplateInput {
  displayName?: string;
  description?: string;
  status?: OrgScopeTemplateStatus;
}

export interface ScopeTemplatesRepository {
  /** Every org template for a provider, active AND retired (the manage view). */
  listScopeTemplates(orgId: Uuid, provider: string): Promise<IntegrationsResult<OrgScopeTemplate[]>>;
  getScopeTemplate(
    orgId: Uuid,
    provider: string,
    templateId: string,
  ): Promise<IntegrationsResult<OrgScopeTemplate | null>>;
  /** Fails with kind "conflict" when (org, provider, templateId) exists. */
  createScopeTemplate(
    input: CreateOrgScopeTemplateInput,
  ): Promise<IntegrationsResult<OrgScopeTemplate>>;
  /** Display/description edits bump `version`; status flips do not. */
  updateScopeTemplate(
    orgId: Uuid,
    provider: string,
    templateId: string,
    input: UpdateOrgScopeTemplateInput,
  ): Promise<IntegrationsResult<OrgScopeTemplate | null>>;
}

function safeError(message: string): IntegrationsResult<never> {
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

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

function mapRow(row: Record<string, unknown>): OrgScopeTemplate {
  return {
    id: row.id as Uuid,
    orgId: row.org_id as Uuid,
    provider: row.provider as string,
    templateId: row.template_id as string,
    baseTemplate: row.base_template as string,
    displayName: row.display_name as string,
    description: (row.description as string) ?? "",
    version: Number(row.version),
    status: row.status as OrgScopeTemplateStatus,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export function createScopeTemplatesRepository(executor: SqlExecutor): ScopeTemplatesRepository {
  return {
    async listScopeTemplates(orgId, provider) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations.scope_templates
           WHERE org_id = $1 AND provider = $2
           ORDER BY created_at ASC, id ASC`,
          [orgId, provider],
        );
        return { ok: true, value: result.rows.map(mapRow) };
      } catch {
        return safeError("Failed to list scope templates");
      }
    },

    async getScopeTemplate(orgId, provider, templateId) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations.scope_templates
           WHERE org_id = $1 AND provider = $2 AND template_id = $3`,
          [orgId, provider, templateId],
        );
        const row = result.rows[0];
        return { ok: true, value: row ? mapRow(row) : null };
      } catch {
        return safeError("Failed to read scope template");
      }
    },

    async createScopeTemplate(input) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO integrations.scope_templates
             (org_id, provider, template_id, base_template, display_name, description)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            input.orgId,
            input.provider,
            input.templateId,
            input.baseTemplate,
            input.displayName,
            input.description,
          ],
        );
        return { ok: true, value: mapRow(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "scope_template" } };
        }
        return safeError("Failed to create scope template");
      }
    },

    async updateScopeTemplate(orgId, provider, templateId, input) {
      try {
        const sets: string[] = [];
        const values: unknown[] = [orgId, provider, templateId];
        let bumpVersion = false;
        if (input.displayName !== undefined) {
          values.push(input.displayName);
          sets.push(`display_name = $${values.length}`);
          bumpVersion = true;
        }
        if (input.description !== undefined) {
          values.push(input.description);
          sets.push(`description = $${values.length}`);
          bumpVersion = true;
        }
        if (input.status !== undefined) {
          values.push(input.status);
          sets.push(`status = $${values.length}`);
        }
        if (sets.length === 0) {
          // No-op update: return the current row.
          const current = await executor.execute<Record<string, unknown>>(
            `SELECT * FROM integrations.scope_templates
             WHERE org_id = $1 AND provider = $2 AND template_id = $3`,
            [orgId, provider, templateId],
          );
          const row = current.rows[0];
          return { ok: true, value: row ? mapRow(row) : null };
        }
        if (bumpVersion) sets.push(`version = version + 1`);
        sets.push(`updated_at = now()`);
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations.scope_templates
           SET ${sets.join(", ")}
           WHERE org_id = $1 AND provider = $2 AND template_id = $3
           RETURNING *`,
          values,
        );
        const row = result.rows[0];
        return { ok: true, value: row ? mapRow(row) : null };
      } catch {
        return safeError("Failed to update scope template");
      }
    },
  };
}
