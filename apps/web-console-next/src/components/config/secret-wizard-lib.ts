/**
 * Pure logic for the outcome-first secret wizard
 * (saas-integration-registry IR4, design §7 "Secret creation v2").
 *
 * Dependency-free (no React, no DOM) so the wizard's step machine, smart
 * defaults, and summary grammar are unit-testable in isolation
 * (tests/web-console-next). The React wiring lives in `secret-wizard.tsx`;
 * this file owns:
 *
 *   - the step sequence (incl. the single-mode skip of "How should it live?")
 *   - the forced-mode derivation for single-mode providers
 *   - the active-template projection Step 1 renders cards from
 *   - the smart key-name default (`<PROVIDER>_API_TOKEN`)
 *   - the plain-language summary line the review step shows
 *   - the "Where" step's validation, REUSED from `bind-secret-flow` — the
 *     wizard adds no validation rules of its own.
 *
 * Nothing here ever touches a secret VALUE.
 */

import type { IntegrationScopeTemplate, SecretMode } from "@saas/contracts/integrations";
import { validateBindingForm, type BindTemplateLike } from "./bind-secret-flow";

// ---------------------------------------------------------------------------
// Step machine
// ---------------------------------------------------------------------------

export type WizardStepId = "use-case" | "where" | "lifecycle" | "review";

export interface WizardStep {
  id: WizardStepId;
  label: string;
}

/** Step headings — a labeled progress list, outcome-first (design §7). */
export const WIZARD_STEP_LABELS: Record<WizardStepId, string> = {
  "use-case": "What do you need?",
  where: "Where will it be used?",
  lifecycle: "How should it live?",
  review: "Review & create",
};

/**
 * The wizard's step sequence for a provider's declared modes. Providers with
 * a single mode have nothing to decide about lifecycle — the "How should it
 * live?" step is skipped entirely (design §7).
 */
export function wizardSteps(supportedModes: readonly SecretMode[]): WizardStep[] {
  const both = supportedModes.includes("brokered") && supportedModes.includes("rotated");
  const ids: WizardStepId[] = both
    ? ["use-case", "where", "lifecycle", "review"]
    : ["use-case", "where", "review"];
  return ids.map((id) => ({ id, label: WIZARD_STEP_LABELS[id] }));
}

/**
 * The mode a single-mode provider forces (no lifecycle step); null when the
 * provider declares both and the operator chooses on the lifecycle step.
 * An empty declaration fails open to brokered — the value-less kind.
 */
export function forcedMode(supportedModes: readonly SecretMode[]): "binding" | "rotated" | null {
  const brokered = supportedModes.includes("brokered");
  const rotated = supportedModes.includes("rotated");
  if (brokered && rotated) return null;
  return rotated ? "rotated" : "binding";
}

/** The step after `current` in `steps`; null on the last (or unknown) step. */
export function nextStepId(steps: readonly WizardStep[], current: WizardStepId): WizardStepId | null {
  const i = steps.findIndex((s) => s.id === current);
  if (i < 0 || i + 1 >= steps.length) return null;
  return steps[i + 1]!.id;
}

/** The step before `current` in `steps`; null on the first (or unknown) step. */
export function prevStepId(steps: readonly WizardStep[], current: WizardStepId): WizardStepId | null {
  const i = steps.findIndex((s) => s.id === current);
  if (i <= 0) return null;
  return steps[i - 1]!.id;
}

// ---------------------------------------------------------------------------
// Step 1 — use-case cards
// ---------------------------------------------------------------------------

/**
 * The templates Step 1 renders cards from: the provider's ACTIVE catalog —
 * declared templates plus the org's custom derivations (SP4), minus retired
 * ones (soft-retire hides a template from create surfaces while existing
 * bindings keep resolving, SP-A6).
 */
export function activeTemplates(
  templates: readonly IntegrationScopeTemplate[],
): IntegrationScopeTemplate[] {
  return templates.filter((t) => (t.status ?? "active") !== "retired");
}

/**
 * Resolve a `?template=` deep-link seed against the active catalog: the id
 * when it names an active template, "" otherwise (an unknown or retired id
 * never pre-selects — the operator picks on Step 1).
 */
export function seedTemplateId(
  templates: readonly IntegrationScopeTemplate[],
  initialTemplateId: string | undefined | null,
): string {
  if (!initialTemplateId) return "";
  return activeTemplates(templates).some((t) => t.id === initialTemplateId) ? initialTemplateId : "";
}

// ---------------------------------------------------------------------------
// Review — smart key default + summary line
// ---------------------------------------------------------------------------

/**
 * The smart key-name default, derived from the provider id:
 * `<PROVIDER>_API_TOKEN` (e.g. cloudflare → CLOUDFLARE_API_TOKEN). Always
 * editable — this only seeds the input. Falls back to API_TOKEN without a
 * provider.
 */
export function defaultSecretKey(providerId: string | undefined | null): string {
  const stem = (providerId ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return stem.length > 0 ? `${stem}_API_TOKEN` : "API_TOKEN";
}

/** Human label for the chosen scope rung (mirrors the space's scope picker). */
export function scopeRungLabel(scope: { kind: "organization" | "project" | "environment" }): string {
  switch (scope.kind) {
    case "environment":
      return "environment scope";
    case "project":
      return "project scope";
    default:
      return "workspace scope";
  }
}

export interface WizardSummaryInput {
  /** The chosen use-case (Step 1 card). */
  template: Pick<IntegrationScopeTemplate, "displayName" | "description"> | null;
  /** Display name of the chosen connection; null before one is picked. */
  connectionName: string | null;
  /** Human scope label, e.g. from `scopeRungLabel`. */
  scopeLabel: string;
  mode: "binding" | "rotated";
}

/**
 * The review step's plain-language summary — built from the template's own
 * displayName + description (the honest-breadth statement, single source),
 * the connection, the scope rung, and the lifecycle. Never re-states grants
 * in new copy.
 */
export function summaryLine(input: WizardSummaryInput): string {
  const what = input.template
    ? `${input.template.displayName} — ${input.template.description.replace(/\.?\s*$/, "")}`
    : "No use case selected";
  const where = input.connectionName ? ` Minted from ${input.connectionName}` : " Minted from the connection";
  const how =
    input.mode === "rotated"
      ? "stored encrypted and re-minted on the rotation schedule"
      : "fresh per run, nothing stored";
  return `${what}.${where}, used at ${input.scopeLabel}; ${how}.`;
}

// ---------------------------------------------------------------------------
// Step 2 — validation (reused, never re-stated)
// ---------------------------------------------------------------------------

export interface WhereStepValues {
  connectionId: string;
  /** Chosen template id (Step 1). */
  template: string;
  /** Raw param inputs keyed by param name. */
  params: Record<string, string>;
}

/**
 * The "Where" step's gate: exactly the connection/template/param rules of
 * `validateBindingForm` (bind-secret-flow), probed with placeholder values
 * for the fields later steps own — so a rule change there is a rule change
 * here, by construction. Returns {} when the step may advance.
 */
export function whereStepErrors(
  values: WhereStepValues,
  templates: readonly BindTemplateLike[],
): Record<string, string> {
  const probe = validateBindingForm(
    {
      // Valid placeholders for review-step fields: only connection/template/
      // param errors can surface.
      secretKey: "WIZARD_PROBE",
      displayName: "",
      connectionId: values.connectionId,
      template: values.template,
      params: values.params,
    },
    templates,
  );
  return probe.ok ? {} : probe.errors;
}
