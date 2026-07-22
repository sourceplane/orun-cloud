/**
 * Pure logic for the secrets "Bind to integration" path
 * (saas-integration-hub IH8, design §6 "Secrets UI").
 *
 * Dependency-free (no React, no DOM) so the binding rules are unit-testable
 * in isolation (tests/web-console-next). The React wiring lives in
 * `secrets-panel.tsx`; this file owns:
 *
 *   - the create dialog's mode ("value" | "binding")
 *   - which connections can back a brokered secret
 *   - binding form validation → a `CreateBrokeredSecretRequest`-shaped body
 *   - `deriveBrokerRow` (row provenance for brokered secrets)
 *   - the entitlement-aware 412 message for `createBrokeredSecret`
 *
 * Nothing here ever touches a secret VALUE — a brokered secret has none.
 */

import type {
  CreateBrokeredSecretRequest,
  CreateRotatedSecretRequest,
  PublicSecretMetadata,
} from "@saas/contracts/config";

/** The create dialog's two paths: a stored value, or a broker binding. */
export type CreateSecretMode = "value" | "binding" | "rotated";

/** Public connection id shape (`int_<32hex>`), same alphabet as the platform's prefix ids. */
export const CONNECTION_ID_PATTERN = /^int_[0-9a-f]{32}$/;

/**
 * Providers with the `credential-broker` capability the console can bind
 * against (design §5: Cloudflare + Supabase adapters; GitHub's broker serves
 * repo tokens through the Git surface, not secret bindings, in v1).
 */
export const BROKER_CAPABLE_PROVIDERS: readonly string[] = ["cloudflare", "supabase"];

export function isBrokerCapableProvider(providerId: string): boolean {
  return BROKER_CAPABLE_PROVIDERS.includes(providerId);
}

/** Connections the binding picker offers: active + broker-capable. */
export function brokerConnections<T extends { provider: string; status: string }>(
  connections: readonly T[],
): T[] {
  return connections.filter((c) => c.status === "active" && isBrokerCapableProvider(c.provider));
}

// ---------------------------------------------------------------------------
// Binding form validation
// ---------------------------------------------------------------------------

/** Structural twin of `ScopeTemplateInfo` (archetype.ts) — kept local for purity. */
export interface BindTemplateLike {
  id: string;
  params: readonly string[];
}

export interface BindingFormValues {
  secretKey: string;
  displayName: string;
  /** Public connection id (int_…), from the picker. */
  connectionId: string;
  /** Template id chosen from the connection's provider catalog. */
  template: string;
  /** Raw param inputs keyed by param name. */
  params: Record<string, string>;
  /** Optional rotation cadence for the scoped credential (SC2), e.g. "90d".
   *  Empty / "off" means no scheduled rotation. */
  rotationPolicy?: string;
}

/** Duration grammar the server accepts for a rotation cadence. */
export const ROTATION_POLICY_PATTERN = /^[0-9]+[hdwmy]$/;

export type BindingFormResult =
  | { ok: true; request: CreateBrokeredSecretRequest }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate the binding form and shape the `createBrokeredSecret` body.
 *
 *   - `secretKey`: same rule as the static-value schema (1..128 after trim);
 *   - `connectionId`: must match `int_<32hex>`;
 *   - `template`: must be one of the provider catalog's template ids;
 *   - params: every param the chosen template declares, non-empty (trimmed);
 *   - `displayName`: optional, ≤128.
 *
 * Errors are keyed by field name (param errors keyed by the param name).
 */
export function validateBindingForm(
  form: BindingFormValues,
  templates: readonly BindTemplateLike[],
): BindingFormResult {
  const errors: Record<string, string> = {};

  const secretKey = form.secretKey.trim();
  if (secretKey.length === 0) errors.secretKey = "Required";
  else if (secretKey.length > 128) errors.secretKey = "At most 128 characters";

  if (!CONNECTION_ID_PATTERN.test(form.connectionId)) {
    errors.connectionId = "Pick a connection";
  }

  const template = templates.find((t) => t.id === form.template);
  if (!template) {
    errors.template = "Pick a scope template";
  }

  const params: Record<string, string> = {};
  if (template) {
    for (const name of template.params) {
      const value = (form.params[name] ?? "").trim();
      if (value.length === 0) errors[name] = "Required";
      else params[name] = value;
    }
  }

  const displayName = form.displayName.trim();
  if (displayName.length > 128) errors.displayName = "At most 128 characters";

  const rotationPolicy = (form.rotationPolicy ?? "").trim();
  if (rotationPolicy.length > 0 && !ROTATION_POLICY_PATTERN.test(rotationPolicy)) {
    errors.rotationPolicy = "Use a duration like 90d, 12w, or 720h";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const request: CreateBrokeredSecretRequest = {
    secretKey,
    binding: {
      connectionId: form.connectionId,
      template: template!.id,
      ...(template!.params.length > 0 ? { params } : {}),
    },
    ...(displayName.length > 0 ? { displayName } : {}),
    ...(rotationPolicy.length > 0 ? { rotationPolicy } : {}),
  };
  return { ok: true, request };
}

// ---------------------------------------------------------------------------
// Provider-rotated create (provider-rotated-secrets RS1/RS4)
// ---------------------------------------------------------------------------

export interface RotationFormValues extends BindingFormValues {
  /** Overlap the prior token stays valid after a rotation (seconds). Empty =
   *  the engine default (24h). */
  graceSeconds?: string;
  /** Materialize target re-delivered on rotation for a long-lived consumer. */
  deliverTarget?: string;
}

export type RotationFormResult =
  | { ok: true; request: CreateRotatedSecretRequest }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate the rotated-create form and shape the `createRotatedSecret` body.
 * Same connection/template/params/displayName rules as a brokered binding, but
 * this IS a stored secret: the value is minted once from the parent and
 * re-minted on the `rotationPolicy` cadence (RS2). Extra optional inputs:
 * `graceSeconds` (non-negative integer) and `deliverTarget` (non-empty).
 */
export function validateRotationForm(
  form: RotationFormValues,
  templates: readonly BindTemplateLike[],
): RotationFormResult {
  const errors: Record<string, string> = {};

  const secretKey = form.secretKey.trim();
  if (secretKey.length === 0) errors.secretKey = "Required";
  else if (secretKey.length > 128) errors.secretKey = "At most 128 characters";

  if (!CONNECTION_ID_PATTERN.test(form.connectionId)) {
    errors.connectionId = "Pick a connection";
  }

  const template = templates.find((t) => t.id === form.template);
  if (!template) errors.template = "Pick a scope template";

  const params: Record<string, string> = {};
  if (template) {
    for (const name of template.params) {
      const value = (form.params[name] ?? "").trim();
      if (value.length === 0) errors[name] = "Required";
      else params[name] = value;
    }
  }

  const displayName = form.displayName.trim();
  if (displayName.length > 128) errors.displayName = "At most 128 characters";

  // Rotation cadence is meaningful here (it drives the RS2 engine), but the
  // server defaults it to 30d — so an empty policy is valid.
  const rotationPolicy = (form.rotationPolicy ?? "").trim();
  if (rotationPolicy.length > 0 && !ROTATION_POLICY_PATTERN.test(rotationPolicy)) {
    errors.rotationPolicy = "Use a duration like 90d, 12w, or 720h";
  }

  const graceRaw = (form.graceSeconds ?? "").trim();
  let graceSeconds: number | undefined;
  if (graceRaw.length > 0) {
    const n = Number(graceRaw);
    if (!Number.isInteger(n) || n < 0) errors.graceSeconds = "Whole seconds, 0 or more";
    else graceSeconds = n;
  }

  const deliverTarget = (form.deliverTarget ?? "").trim();

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const request: CreateRotatedSecretRequest = {
    secretKey,
    rotation: {
      connectionId: form.connectionId,
      template: template!.id,
      ...(template!.params.length > 0 ? { params } : {}),
      ...(graceSeconds !== undefined ? { graceSeconds } : {}),
      ...(deliverTarget.length > 0 ? { deliverTarget } : {}),
    },
    ...(displayName.length > 0 ? { displayName } : {}),
    ...(rotationPolicy.length > 0 ? { rotationPolicy } : {}),
  };
  return { ok: true, request };
}

// ---------------------------------------------------------------------------
// Row provenance
// ---------------------------------------------------------------------------

export interface BrokerRow {
  provider: string;
  template: string;
  connectionId: string;
  /** Sub-label provenance, e.g. "brokered · cloudflare · workers-deploy". */
  label: string;
}

/**
 * Derive the broker provenance for a secrets-table row. Returns null for
 * static rows (absent `source` means static — surfaces that predate brokered
 * secrets) and for a brokered row missing its display binding (defensive).
 */
export function deriveBrokerRow(
  meta: Pick<PublicSecretMetadata, "source" | "binding">,
): BrokerRow | null {
  if (meta.source !== "brokered") return null;
  const binding = meta.binding;
  if (!binding) return null;
  return {
    provider: binding.provider,
    template: binding.template,
    connectionId: binding.connectionId,
    label: `brokered · ${binding.provider} · ${binding.template}`,
  };
}

// ---------------------------------------------------------------------------
// Provider-rotation provenance (provider-rotated-secrets RS4)
// ---------------------------------------------------------------------------

export interface RotationRow {
  provider: string;
  template: string;
  connectionId: string;
  /** Materialize target re-delivered on rotation; null = per-run consumers. */
  deliverTarget: string | null;
  /** Sub-label provenance, e.g. "rotated · cloudflare · workers-deploy · every 30d". */
  label: string;
}

/**
 * Derive the provider-rotation provenance for a secrets-table row. Returns
 * null for non-rotated rows (absent `rotation` — plain static or brokered).
 * A rotated row is an ordinary stored secret whose NEXT version the engine
 * mints from the connected parent; value-shaped actions (rotate now) apply.
 */
export function deriveRotationRow(
  meta: Pick<PublicSecretMetadata, "rotation"> & { rotationPolicy?: string | null },
): RotationRow | null {
  const rotation = meta.rotation;
  if (!rotation) return null;
  const cadence = meta.rotationPolicy ? ` · every ${meta.rotationPolicy}` : "";
  return {
    provider: rotation.provider,
    template: rotation.template,
    connectionId: rotation.connectionId,
    deliverTarget: rotation.deliverTarget,
    label: `rotated · ${rotation.provider} · ${rotation.template}${cadence}`,
  };
}

// ---------------------------------------------------------------------------
// Orphan health (brokered-orphan-safety, Feature 1)
// ---------------------------------------------------------------------------

/** Display projection of a brokered row's derived orphan health. */
export interface OrphanView {
  /** The connection can no longer mint — the row will fail to resolve. */
  orphaned: boolean;
  /** The derived binding status the server stamped ("revoked", "suspended", …). */
  bindingStatus: NonNullable<PublicSecretMetadata["bindingStatus"]>;
  /** Pill label: "orphaned" when orphaned, else the binding status. */
  label: string;
  /** One-line explanation for a tooltip / banner. */
  reason: string;
}

/**
 * Derive the orphan-health view for a secrets-table row. Returns null for
 * static rows and for brokered rows the server did NOT stamp (health unknown —
 * the status lookup was unreachable; we never assert orphaned on doubt). A
 * healthy brokered row (`orphaned === false`) returns a view too, so the caller
 * can choose to render an "active" affordance or nothing.
 */
export function orphanView(
  meta: Pick<PublicSecretMetadata, "source" | "orphaned" | "bindingStatus">,
): OrphanView | null {
  if (meta.source !== "brokered") return null;
  // Unstamped: the health lookup was unreachable. Do not assert orphaned.
  if (meta.orphaned === undefined && meta.bindingStatus === undefined) return null;
  const bindingStatus = meta.bindingStatus ?? "unknown";
  const orphaned = meta.orphaned === true;
  const reason = orphaned
    ? bindingStatus === "unknown"
      ? "Its integration connection no longer exists — this secret will fail to resolve at plan and run time."
      : `Its integration connection is ${bindingStatus} — this secret will fail to resolve at plan and run time.`
    : "Its integration connection is active.";
  return {
    orphaned,
    bindingStatus,
    label: orphaned ? "orphaned" : bindingStatus,
    reason,
  };
}

/** Filter a list to the orphaned brokered rows, for the attention banner. */
export function orphanedSecrets<T extends Pick<PublicSecretMetadata, "source" | "orphaned" | "bindingStatus">>(
  secrets: readonly T[],
): T[] {
  return secrets.filter((s) => orphanView(s)?.orphaned === true);
}

// ---------------------------------------------------------------------------
// 412 messaging for createBrokeredSecret
// ---------------------------------------------------------------------------

/** Structural subset of `ApiErrorBody` (lib/api.ts) — kept local for purity. */
export interface BrokeredCreateError {
  message: string;
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * Entitlement-aware inline message for a 412 from `createBrokeredSecret`
 * (`limit.brokered_secrets` / broker feature gates). Unknown reasons fall
 * back to the server message — never a silent toast.
 */
export function brokeredCreateErrorMessage(error: BrokeredCreateError): string {
  const details = error.details ?? {};
  const key = typeof details.key === "string" ? details.key : null;
  const entitlement = key ? key.split(".").pop()!.replace(/_/g, " ") : "brokered secrets";
  switch (error.reason) {
    case "limit_reached": {
      const limit = typeof details.limit === "number" ? details.limit : null;
      const current = typeof details.current === "number" ? details.current : null;
      const usage =
        limit !== null && current !== null ? ` (${current} of ${limit} used)` : limit !== null ? ` (limit ${limit})` : "";
      return `Your plan's ${entitlement} limit is reached${usage}. Upgrade your plan to bind more secrets.`;
    }
    case "not_configured":
      return `Billing isn't configured for this workspace yet, so the ${entitlement} entitlement can't be validated. Finish setup in Billing, then try again.`;
    case "disabled":
      return `${entitlement.charAt(0).toUpperCase()}${entitlement.slice(1)} are disabled on your plan. Contact your account team to enable this entitlement.`;
    default:
      return error.message;
  }
}
