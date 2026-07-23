// Org-curated scope templates (saas-secrets-platform SP4).
//
// The integration's space curates named derivations of the provider's
// code-declared templates: the BASE supplies mint semantics (permission
// grammar, custody kind, params, TTL ceiling) — the org supplies identity and
// display. The substrate serves the merged catalog through the SP0 capability
// read; the mint path resolves custom → base at issue time, so a custom
// template can never exceed its base (deny-by-default by construction).
//
// Soft-retire only (SP-A6): a retired template disappears from create
// surfaces while existing bindings keep resolving. No hard delete exists, so
// a template can never be deleted out from under a live secret.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  CreateScopeTemplateRequest,
  IntegrationProviderId,
  IntegrationScopeTemplate,
  ListScopeTemplatesResponse,
  ScopeTemplateResponse,
  UpdateScopeTemplateRequest,
} from "@saas/contracts/integrations";
import { INTEGRATION_POLICY_ACTIONS } from "@saas/contracts/integrations";
import type { OrgScopeTemplate } from "@saas/db/integrations";
import { createScopeTemplatesRepository } from "@saas/db/integrations";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse } from "../http.js";
import { getConfiguredProvider, getDormantProvider } from "../providers/registry.js";
import { authorizeIntegration } from "./connections.js";

/** Same grammar the broker accepts for a template id. */
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface ScopeTemplateHandlerDeps {
  executor?: SqlExecutor;
}

function resolveExecutor(env: Env, deps?: ScopeTemplateHandlerDeps): SqlExecutor {
  return deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
}

/** The provider's code-declared secret-source templates; null when the
 *  provider does not declare the secrets capability. */
function declaredTemplates(env: Env, providerId: string): readonly IntegrationScopeTemplate[] | null {
  const provider = getConfiguredProvider(env, providerId)?.provider ?? getDormantProvider(providerId);
  if (!provider?.secrets) return null;
  return provider.secrets.scopeTemplates();
}

/** Project an org row onto the wire shape, inheriting mint semantics
 *  (params, TTL ceiling, custody) from its base template. */
export function toWireTemplate(
  row: OrgScopeTemplate,
  base: IntegrationScopeTemplate,
): IntegrationScopeTemplate {
  return {
    id: row.templateId,
    provider: row.provider as IntegrationProviderId,
    version: row.version,
    displayName: row.displayName,
    description: row.description,
    params: base.params,
    maxTtlSeconds: base.maxTtlSeconds,
    ...(base.custodyKind ? { custodyKind: base.custodyKind } : {}),
    origin: "custom",
    baseTemplate: row.baseTemplate,
    status: row.status,
  };
}

/**
 * The merged catalog served to create surfaces + the capability read:
 * declared templates (origin stamped) followed by the org's ACTIVE custom
 * templates. Customs whose base disappeared are dropped (fail closed).
 */
export function mergeActiveTemplates(
  declared: readonly IntegrationScopeTemplate[],
  customs: readonly OrgScopeTemplate[],
): IntegrationScopeTemplate[] {
  const byId = new Map(declared.map((t) => [t.id, t]));
  const merged: IntegrationScopeTemplate[] = declared.map((t) => ({ ...t, origin: "declared" as const }));
  for (const row of customs) {
    if (row.status !== "active") continue;
    const base = byId.get(row.baseTemplate);
    if (!base) continue;
    merged.push(toWireTemplate(row, base));
  }
  return merged;
}

// ── GET …/providers/:providerId/scope-templates (the manage view) ──

export async function handleListScopeTemplates(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  providerId: string,
  deps?: ScopeTemplateHandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const declared = declaredTemplates(env, providerId);
  if (!declared) {
    return errorResponse("not_found", "No secret-source capability for this provider", 404, requestId, {
      reason: "capability_not_supported",
    });
  }

  const repo = createScopeTemplatesRepository(resolveExecutor(env, deps));
  const customs = await repo.listScopeTemplates(orgId, providerId);
  if (!customs.ok) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  // Manage view: declared first, then EVERY custom (retired included) so the
  // space can reactivate. Customs with a vanished base are dropped.
  const byId = new Map(declared.map((t) => [t.id, t]));
  const templates: IntegrationScopeTemplate[] = declared.map((t) => ({
    ...t,
    origin: "declared" as const,
  }));
  for (const row of customs.value) {
    const base = byId.get(row.baseTemplate);
    if (!base) continue;
    templates.push(toWireTemplate(row, base));
  }
  const payload: ListScopeTemplatesResponse = { templates };
  return successResponse(payload, requestId);
}

// ── POST …/providers/:providerId/scope-templates ──

export async function handleCreateScopeTemplate(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  providerId: string,
  deps?: ScopeTemplateHandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.MANAGE,
    requestId,
  );
  if (denied) return denied;

  const declared = declaredTemplates(env, providerId);
  if (!declared) {
    return errorResponse("not_found", "No secret-source capability for this provider", 404, requestId, {
      reason: "capability_not_supported",
    });
  }

  let body: Partial<CreateScopeTemplateRequest>;
  try {
    body = (await request.json()) as Partial<CreateScopeTemplateRequest>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const fields: Record<string, string[]> = {};
  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  if (!TEMPLATE_ID_RE.test(templateId)) {
    fields.templateId = ["Lowercase letters, digits, and dashes (2–64 chars)"];
  } else if (declared.some((t) => t.id === templateId)) {
    fields.templateId = ["Collides with a declared template id"];
  }
  const baseTemplate = typeof body.baseTemplate === "string" ? body.baseTemplate.trim() : "";
  const base = declared.find((t) => t.id === baseTemplate);
  if (!base) fields.baseTemplate = ["Must name one of the provider's declared templates"];
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > 128) {
    fields.displayName = ["Required, at most 128 characters"];
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 1024) fields.description = ["At most 1024 characters"];
  if (Object.keys(fields).length > 0) {
    return errorResponse("validation_failed", "Validation failed", 422, requestId, { fields });
  }

  const repo = createScopeTemplatesRepository(resolveExecutor(env, deps));
  const created = await repo.createScopeTemplate({
    orgId,
    provider: providerId,
    templateId,
    baseTemplate,
    displayName,
    description,
  });
  if (!created.ok) {
    if (created.error.kind === "conflict") {
      return errorResponse("conflict", "Template id already exists", 409, requestId);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const payload: ScopeTemplateResponse = { template: toWireTemplate(created.value, base!) };
  return successResponse(payload, requestId, 201);
}

// ── PATCH …/providers/:providerId/scope-templates/:templateId ──

export async function handleUpdateScopeTemplate(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  providerId: string,
  templateId: string,
  deps?: ScopeTemplateHandlerDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.MANAGE,
    requestId,
  );
  if (denied) return denied;

  const declared = declaredTemplates(env, providerId);
  if (!declared) {
    return errorResponse("not_found", "No secret-source capability for this provider", 404, requestId, {
      reason: "capability_not_supported",
    });
  }
  // Declared templates are code-owned — the console never edits them here.
  if (declared.some((t) => t.id === templateId)) {
    return errorResponse("conflict", "Declared templates are code-owned", 409, requestId, {
      reason: "template_declared",
    });
  }

  let body: Partial<UpdateScopeTemplateRequest>;
  try {
    body = (await request.json()) as Partial<UpdateScopeTemplateRequest>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const fields: Record<string, string[]> = {};
  const patch: { displayName?: string; description?: string; status?: "active" | "retired" } = {};
  if (body.displayName !== undefined) {
    const v = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (v.length === 0 || v.length > 128) fields.displayName = ["Required, at most 128 characters"];
    else patch.displayName = v;
  }
  if (body.description !== undefined) {
    const v = typeof body.description === "string" ? body.description.trim() : "";
    if (v.length > 1024) fields.description = ["At most 1024 characters"];
    else patch.description = v;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "retired") {
      fields.status = ["Must be active or retired"];
    } else patch.status = body.status;
  }
  if (Object.keys(fields).length > 0) {
    return errorResponse("validation_failed", "Validation failed", 422, requestId, { fields });
  }

  const repo = createScopeTemplatesRepository(resolveExecutor(env, deps));
  const updated = await repo.updateScopeTemplate(orgId, providerId, templateId, patch);
  if (!updated.ok) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!updated.value) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const base = declared.find((t) => t.id === updated.value!.baseTemplate);
  if (!base) {
    // The base vanished from the code catalog — the row is inert.
    return errorResponse("conflict", "The base template no longer exists", 409, requestId, {
      reason: "base_template_missing",
    });
  }
  const payload: ScopeTemplateResponse = { template: toWireTemplate(updated.value, base) };
  return successResponse(payload, requestId);
}

/**
 * Mint-path resolution (SP4): a template id that is not in the provider's
 * code catalog may be an org custom template — resolve it to its BASE (which
 * supplies every mint semantic) when it exists for this org, any status
 * (retired templates keep resolving; soft-retire only hides creation).
 * Returns null when the id is unknown (the caller keeps template_unknown).
 */
export async function resolveCustomTemplate(
  executor: SqlExecutor,
  orgId: Uuid,
  providerId: string,
  templateId: string,
  declared: readonly IntegrationScopeTemplate[],
): Promise<IntegrationScopeTemplate | null> {
  const repo = createScopeTemplatesRepository(executor);
  const row = await repo.getScopeTemplate(orgId, providerId, templateId);
  if (!row.ok || !row.value) return null;
  const base = declared.find((t) => t.id === row.value!.baseTemplate);
  return base ?? null;
}
