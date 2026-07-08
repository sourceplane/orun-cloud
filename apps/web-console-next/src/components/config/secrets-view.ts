/**
 * Pure, dependency-free view helpers for the Secrets console surface
 * (saas-secret-manager SM1/SM3/SM5/SEC7). No React, no DOM — the React wiring
 * lives in `secrets-panel.tsx` / `secret-policies-panel.tsx`; this file owns the
 * business logic so it is unit-tested in isolation (tests/web-console-next).
 *
 * The write-only discipline is preserved here: no helper ever accepts or returns
 * a secret VALUE. `revealGuard` only validates the reveal *reason*.
 */

import type {
  PublicSecretMetadata,
  PublicSecretSync,
  EvaluateSecretPolicyRequest,
} from "@saas/contracts/config";

/** A Badge variant string (matches `@/components/ui/badge`) — kept as a bare
 *  string so this module stays free of any UI import. */
export type BadgeTone =
  | "default"
  | "secondary"
  | "destructive"
  | "warning"
  | "success"
  | "outline";

// ---------------------------------------------------------------------------
// Rotation status
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a rotation-policy string (`"90d"`, `"12w"`, `"720h"`) to a whole number
 * of days. Returns null for absent/malformed policies (treated as "no policy").
 */
export function parseRotationPolicyDays(policy: string | null | undefined): number | null {
  if (!policy) return null;
  const m = /^(\d+)\s*([dwh])$/i.exec(policy.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2]!.toLowerCase()) {
    case "d":
      return n;
    case "w":
      return n * 7;
    case "h":
      return Math.max(1, Math.round(n / 24));
    default:
      return null;
  }
}

export interface RotationStatus {
  /** Whole days since the last rotation (or creation when never rotated). */
  ageDays: number;
  /** True when a rotation policy exists and the age meets/exceeds it. */
  due: boolean;
  /** Short human label for the rotation column (legacy phrasing). */
  label: string;
  /**
   * Terser label the Northwind Secrets table renders: "31d / 180d" (in-window),
   * "Due · 94d / 90d" (overdue), "61d old · no policy".
   */
  displayLabel: string;
  /** Badge tone the panel maps to a variant. */
  tone: BadgeTone;
  /** True when a rotation policy is configured for this secret. */
  hasPolicy: boolean;
  /** The policy window in days, or null when no policy is configured. */
  policyDays: number | null;
  /** Whole days past the policy when overdue; null otherwise. */
  overdueByDays: number | null;
}

/**
 * Derive the rotation view-model for a secret. `lastRotatedAt` anchors the age
 * when present, else `createdAt`. A secret with no rotation policy is never
 * "due"; its label is a bare age.
 *
 * The Northwind Secrets table renders the mock's terser labels — "31d / 180d"
 * (in-window), "Due · 94d / 90d" (overdue), "61d old · no policy" — while the
 * base `label` keeps its legacy phrasing for any surface still reading it.
 */
export function rotationStatus(
  meta: Pick<PublicSecretMetadata, "rotationPolicy" | "lastRotatedAt" | "createdAt">,
  now: Date,
): RotationStatus {
  const anchor = meta.lastRotatedAt ?? meta.createdAt;
  const anchorMs = anchor ? new Date(anchor).getTime() : NaN;
  const ageDays = Number.isNaN(anchorMs)
    ? 0
    : Math.max(0, Math.floor((now.getTime() - anchorMs) / DAY_MS));

  const policyDays = parseRotationPolicyDays(meta.rotationPolicy);
  if (policyDays === null) {
    return {
      ageDays,
      due: false,
      label: `${ageDays}d old`,
      displayLabel: `${ageDays}d old · no policy`,
      tone: "secondary",
      hasPolicy: false,
      policyDays: null,
      overdueByDays: null,
    };
  }
  const due = ageDays >= policyDays;
  return {
    ageDays,
    due,
    label: due ? `Rotation due (${ageDays}d)` : `${ageDays}d / ${policyDays}d`,
    displayLabel: due ? `Due · ${ageDays}d / ${policyDays}d` : `${ageDays}d / ${policyDays}d`,
    tone: due ? "warning" : "success",
    hasPolicy: true,
    policyDays,
    overdueByDays: due ? ageDays - policyDays : null,
  };
}

// ---------------------------------------------------------------------------
// Chain badges
// ---------------------------------------------------------------------------

export interface ChainBadge {
  label: string;
  tone: BadgeTone;
}

/**
 * Badges for a chain-read row (SM1): where the serving head resolves from
 * (`servesFrom`), whether it is a locked guardrail (`overridable === false`),
 * and whether it is the caller's personal overlay.
 */
export function chainBadges(
  meta: Pick<PublicSecretMetadata, "servesFrom" | "overridable" | "personal">,
): ChainBadge[] {
  const badges: ChainBadge[] = [];
  if (meta.servesFrom) {
    badges.push({ label: `serves from ${meta.servesFrom}`, tone: "default" });
  }
  if (meta.personal) {
    badges.push({ label: "personal", tone: "secondary" });
  }
  if (meta.overridable === false) {
    badges.push({ label: "Locked", tone: "warning" });
  }
  return badges;
}

// ---------------------------------------------------------------------------
// Scope-chain mini-chips (Northwind Secrets table)
// ---------------------------------------------------------------------------

/**
 * A single mini-chip in the Secrets table's "Scope chain" column.
 * `tone: "env"` renders in the info tint; `override` adds the ⌃ marker for a
 * rung that shadows a broader scope. `tone: "neutral"` covers org/repo rungs.
 */
export interface ScopeChainChip {
  label: string;
  tone: "neutral" | "env";
  override: boolean;
}

/**
 * Derive the scope-chain chips for a secret row from its metadata alone (no
 * value read). Mirrors the mock: a neutral chip for the owning org/project
 * scope, the serving rung on a chain read (env rungs tinted + marked when they
 * override a broader scope), a personal-overlay chip, and a Locked guardrail.
 */
export function scopeChainChips(
  meta: Pick<
    PublicSecretMetadata,
    "scopeKind" | "servesFrom" | "overridable" | "personal"
  >,
): ScopeChainChip[] {
  const chips: ScopeChainChip[] = [];

  switch (meta.scopeKind) {
    case "organization":
      chips.push({ label: "org", tone: "neutral", override: false });
      break;
    case "project":
      chips.push({ label: "project", tone: "neutral", override: false });
      break;
    case "environment":
      chips.push({ label: "environment", tone: "env", override: false });
      break;
    default:
      if (meta.scopeKind) chips.push({ label: meta.scopeKind, tone: "neutral", override: false });
  }

  // On a chain read the serving rung records where the head resolved. Show it
  // (tinted + marked when an environment/personal rung shadows a broader scope).
  if (meta.servesFrom && meta.servesFrom !== meta.scopeKind) {
    const env = meta.servesFrom === "environment" || meta.servesFrom === "personal";
    chips.push({
      label: meta.servesFrom,
      tone: env ? "env" : "neutral",
      override: env,
    });
  }

  if (meta.personal) chips.push({ label: "personal", tone: "env", override: true });
  if (meta.overridable === false) chips.push({ label: "locked", tone: "neutral", override: false });

  return chips;
}

// ---------------------------------------------------------------------------
// Health overview
// ---------------------------------------------------------------------------

export interface SecretHealthStats {
  /** Total secrets served at the current scope (chain rows at env scope). */
  total: number;
  /** Secrets whose rotation policy has elapsed (see `rotationStatus`). */
  rotationDue: number;
  /** Locked guardrails a lower scope cannot override (`overridable === false`). */
  locked: number;
  /** Personal overlays visible only to their owner (`personal === true`). */
  personal: number;
}

/**
 * Derive the glanceable health tiles for the Secrets console from a secrets
 * list/chain response. Metadata-only: no value is read or returned — the counts
 * come purely from the rotation policy, lock, and personal-overlay flags already
 * present on each row.
 */
export function secretHealthStats(
  secrets: Pick<
    PublicSecretMetadata,
    "rotationPolicy" | "lastRotatedAt" | "createdAt" | "overridable" | "personal"
  >[],
  now: Date,
): SecretHealthStats {
  let rotationDue = 0;
  let locked = 0;
  let personal = 0;
  for (const s of secrets) {
    if (rotationStatus(s, now).due) rotationDue += 1;
    if (s.overridable === false) locked += 1;
    if (s.personal) personal += 1;
  }
  return { total: secrets.length, rotationDue, locked, personal };
}

// ---------------------------------------------------------------------------
// Break-glass reveal reason guard
// ---------------------------------------------------------------------------

/** Minimum reason length. Stricter than the worker (non-empty) so the console
 *  nudges operators toward an audit-worthy justification. */
export const MIN_REVEAL_REASON_LENGTH = 10;

export type RevealGuardResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate the typed reveal reason. The break-glass dialog cannot submit unless
 * this returns ok — the reason is mandatory (recorded to the audit row).
 */
export function revealGuard(reasonInput: string): RevealGuardResult {
  const value = reasonInput.trim();
  if (value.length === 0) {
    return { ok: false, error: "A reason is required — this access is audited." };
  }
  if (value.length < MIN_REVEAL_REASON_LENGTH) {
    return {
      ok: false,
      error: `Add a little more detail (at least ${MIN_REVEAL_REASON_LENGTH} characters).`,
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Policy test request shaping
// ---------------------------------------------------------------------------

/** Raw, unvalidated strings from the policy-test form inputs. */
export interface PolicyTestFormValues {
  key: string;
  env: string;
  platform: string;
  subjectId: string;
  subjectKind: string;
  /** Comma-separated team slugs. */
  teams: string;
  servesFrom: string;
  componentType: string;
  componentName: string;
  componentDomain: string;
  triggerBranch: string;
  triggerDeclared: boolean;
}

export const EMPTY_POLICY_TEST_FORM: PolicyTestFormValues = {
  key: "",
  env: "",
  platform: "local-cli",
  subjectId: "",
  subjectKind: "user",
  teams: "",
  servesFrom: "",
  componentType: "",
  componentName: "",
  componentDomain: "",
  triggerBranch: "",
  triggerDeclared: false,
};

function clean(v: string): string | undefined {
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Shape the evaluate (`orun policy test`) request from the form inputs. Only
 * non-empty axes are included, so a bare form yields just `{ key, env,
 * platform }`. The request body is FLAT (facts alongside `key`) to match the
 * worker handler.
 */
export function policyTestRequest(form: PolicyTestFormValues): EvaluateSecretPolicyRequest {
  const teams = form.teams
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const subject: EvaluateSecretPolicyRequest["subject"] = {};
  const subjectId = clean(form.subjectId);
  if (subjectId) subject.id = subjectId;
  const subjectKind = clean(form.subjectKind);
  if (subjectKind === "user" || subjectKind === "service_principal" || subjectKind === "workflow") {
    subject.kind = subjectKind;
  }
  if (teams.length > 0) subject.teams = teams;

  const component: EvaluateSecretPolicyRequest["component"] = {};
  const componentType = clean(form.componentType);
  if (componentType) component.type = componentType;
  const componentName = clean(form.componentName);
  if (componentName) component.name = componentName;
  const componentDomain = clean(form.componentDomain);
  if (componentDomain) component.domain = componentDomain;

  const trigger: EvaluateSecretPolicyRequest["trigger"] = {};
  const branch = clean(form.triggerBranch);
  if (branch) trigger.branch = branch;
  if (form.triggerDeclared) trigger.declared = true;

  const platform =
    form.platform === "ci-oidc" || form.platform === "service" ? form.platform : "local-cli";

  const req: EvaluateSecretPolicyRequest = {
    key: form.key.trim(),
    env: form.env.trim(),
    platform,
  };
  if (Object.keys(subject).length > 0) req.subject = subject;
  const servesFrom = clean(form.servesFrom);
  if (
    servesFrom === "environment" ||
    servesFrom === "project" ||
    servesFrom === "workspace" ||
    servesFrom === "account"
  ) {
    req.servesFrom = servesFrom;
  }
  if (Object.keys(component).length > 0) req.component = component;
  if (Object.keys(trigger).length > 0) req.trigger = trigger;
  return req;
}

// ---------------------------------------------------------------------------
// Sync status view
// ---------------------------------------------------------------------------

export interface SyncStatusView {
  label: string;
  tone: BadgeTone;
}

/**
 * Map a sync's lifecycle status to a label + tone. `synced` is the live row;
 * `superseded` was replaced by a newer sync; `orphaned` lost its target entity.
 */
export function syncStatusView(sync: Pick<PublicSecretSync, "status">): SyncStatusView {
  switch (sync.status) {
    case "synced":
      return { label: "Synced", tone: "success" };
    case "superseded":
      return { label: "Superseded", tone: "secondary" };
    case "orphaned":
      return { label: "Orphaned", tone: "warning" };
    default:
      return { label: sync.status, tone: "secondary" };
  }
}
