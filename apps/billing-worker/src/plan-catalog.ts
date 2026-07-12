import type { EntitlementValueType } from "@saas/db/billing";

/**
 * Provider-neutral plan catalog (Task 0128 / B11).
 *
 * Pure data + helpers (no DB, no fetch) so the catalog and the per-plan
 * entitlement set can be unit-tested in isolation. This is the single source of
 * truth for which entitlements a plan grants. The billing-worker materializes
 * these into `billing.entitlements` rows when a plan is assigned to an org
 * (see `handlers/assign-plan.ts`), so policy/product surfaces read real
 * per-org rows rather than the PR-#209 hard-coded fallback.
 *
 * Plans are global catalog rows (`billing.plans`); they are ensured idempotently
 * on first assignment (`createPlan` is `ON CONFLICT (code) DO NOTHING`), so no
 * data migration is required for the lifecycle to work. `priceAmountCents` is a
 * nominal display price only — a payment provider remains the source of truth
 * once B6 wires Stripe behind the adapter seam.
 */

export interface PlanEntitlementDef {
  entitlementKey: string;
  valueType: EntitlementValueType;
  enabled: boolean;
  /** quantity limit; null = unlimited (when enabled). boolean/feature use null. */
  limitValue: number | null;
}

export interface PlanDefinition {
  /** Stable plan row id (billing.plans.id) — exposed verbatim as the public id. */
  id: string;
  /** Stable machine code (billing.plans.code) — the assignment key. */
  code: string;
  name: string;
  description: string;
  billingInterval: "month" | "year" | "none";
  priceAmountCents: number;
  priceCurrency: string;
  entitlements: PlanEntitlementDef[];
}

/** The plan code assigned to every organization at bootstrap. */
export const DEFAULT_PLAN_CODE = "free";

/**
 * The catalog — the decided flat tiers for the `saas-multi-org-billing` epic
 * (D5: Free / Pro / Business / Enterprise; see
 * `specs/epics/saas-multi-org-billing/design.md` §3).
 *
 * Two account-level multi-org keys join the per-org limits:
 *   - `feature.multi_org` (boolean) — may an account own more than one org.
 *   - `limit.organizations` (quantity) — how many orgs the account may own.
 * Per D3 (per-org inherited limits), every other key is a per-org limit that
 * applies to each org the account owns; only `limit.organizations` is
 * account-level. Multi-org unlocks at Business.
 *
 * These keys are materialized like any other entitlement, but **nothing reads
 * them yet** — the org-creation gate is MO2 — so adding them is behavior-neutral
 * beyond the rows that get written on plan assignment.
 *
 * Integration entitlements (`feature.integrations.github`, `limit.repo_links`)
 * are granted on EVERY tier, free included: the GitHub App connect flow is an
 * activation-driving feature that should not be paywalled. The
 * integrations-worker reads `feature.integrations.github` to gate the connect
 * flow and `limit.repo_links` to cap repo links per org. Free explicitly
 * enables the GitHub integration with a single repo link; paid tiers raise the
 * repo-link cap (Enterprise = unlimited). These now materialize as real rows on
 * plan assignment, so the connect flow no longer depends on the
 * check-entitlement free-tier safety net.
 *
 * No-regress rule: never reduce a limit on an in-use plan code (every org is on
 * `free`). `free` therefore keeps `limit.environments = 3` (its current value)
 * even though the D5 table proposed 2 — raising the table value, never lowering
 * the live one. Keep `free`'s values >= the PR-#209 stopgap for the same reason.
 *
 * `priceAmountCents` is a nominal display price only; a payment provider is the
 * source of truth once the provider adapter (billing-provider-abstraction) is
 * wired. `enterprise` is sold via "contact sales", so it has no self-serve price
 * (`billingInterval: "none"`, `priceAmountCents: 0`) and no provider product.
 * For quantity limits, `enabled: true` + `limitValue: null` means unlimited.
 */
export const PLAN_CATALOG: PlanDefinition[] = [
  {
    id: "plan_free",
    code: "free",
    name: "Free",
    description: "Starter tier for new organizations.",
    billingInterval: "month",
    priceAmountCents: 0,
    priceCurrency: "usd",
    entitlements: [
      { entitlementKey: "limit.projects", valueType: "quantity", enabled: true, limitValue: 3 },
      { entitlementKey: "limit.environments", valueType: "quantity", enabled: true, limitValue: 3 },
      { entitlementKey: "limit.members", valueType: "quantity", enabled: true, limitValue: 5 },
      { entitlementKey: "feature.custom_domains", valueType: "boolean", enabled: false, limitValue: null },
      { entitlementKey: "feature.multi_org", valueType: "boolean", enabled: false, limitValue: null },
      { entitlementKey: "limit.organizations", valueType: "quantity", enabled: true, limitValue: 1 },
      // Integrations are an activation-driving feature available on every tier,
      // free included: the GitHub App connect flow is enabled and one repo link
      // is allowed. (Matches the saas-integrations D4 default and the
      // check-entitlement safety-net values, so retiring that net cannot
      // regress the free tier.)
      { entitlementKey: "feature.integrations.github", valueType: "boolean", enabled: true, limitValue: null },
      // Slack connect (saas-integration-hub IH1; risks D7 resolved to the same
      // activation posture as GitHub): available on every tier.
      { entitlementKey: "feature.integrations.slack", valueType: "boolean", enabled: true, limitValue: null },
      // Cloudflare/Supabase connect + the credential broker (saas-integration-hub
      // IH4/IH5/IH6; risks D5/D7): same activation posture — available on every
      // tier, with the mint rate limit as the D5 abuse bound.
      { entitlementKey: "feature.integrations.cloudflare", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.supabase", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.credential_broker", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.credential_mints_per_day", valueType: "quantity", enabled: true, limitValue: 200 },
      { entitlementKey: "limit.repo_links", valueType: "quantity", enabled: true, limitValue: 1 },
      // Event routing (saas-event-streaming ES2, D3 defaults): rules are an
      // activation feature — enabled on free with a conservative cap.
      { entitlementKey: "feature.event_routing", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_rules", valueType: "quantity", enabled: true, limitValue: 10 },
      { entitlementKey: "feature.notifications.slack", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_channels", valueType: "quantity", enabled: true, limitValue: 3 },
      // Custom event ingest (saas-event-streaming ES5): an activation feature —
      // enabled on every tier with a per-day quota that scales with the plan.
      { entitlementKey: "feature.events.custom_ingest", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.custom_events_per_day", valueType: "quantity", enabled: true, limitValue: 1000 },
      // Event/audit retention window (saas-event-streaming ES7, D3 placeholder
      // tiers). The retention sweep deletes past-window rows; the security
      // category floor is kept regardless of plan (compliance is not a plan
      // feature). null = unlimited (Enterprise). Config edit, not a migration.
      { entitlementKey: "limit.event_retention_days", valueType: "quantity", enabled: true, limitValue: 30 },
      // MCP server access (saas-mcp-server MCP6, design §8). The free-vs-paid
      // line is an OPEN product decision (that epic's risks D3) — default
      // posture until decided: granted on EVERY tier (seam live, gate open) so
      // adoption isn't throttled. The MCP transports additionally treat a
      // missing row as granted, so pre-existing orgs (whose rows predate this
      // key) get the same open gate; an explicit enabled:false row (plan edit
      // or override) closes it without a redeploy.
      { entitlementKey: "feature.mcp_server", valueType: "boolean", enabled: true, limitValue: null },
    ],
  },
  {
    id: "plan_pro",
    code: "pro",
    name: "Pro",
    description: "Higher limits and premium features for growing teams.",
    billingInterval: "month",
    priceAmountCents: 2000,
    priceCurrency: "usd",
    entitlements: [
      { entitlementKey: "limit.projects", valueType: "quantity", enabled: true, limitValue: 25 },
      { entitlementKey: "limit.environments", valueType: "quantity", enabled: true, limitValue: 3 },
      { entitlementKey: "limit.members", valueType: "quantity", enabled: true, limitValue: 20 },
      { entitlementKey: "feature.custom_domains", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.multi_org", valueType: "boolean", enabled: false, limitValue: null },
      { entitlementKey: "limit.organizations", valueType: "quantity", enabled: true, limitValue: 1 },
      { entitlementKey: "feature.integrations.github", valueType: "boolean", enabled: true, limitValue: null },
      // Slack connect (saas-integration-hub IH1; risks D7 resolved to the same
      // activation posture as GitHub): available on every tier.
      { entitlementKey: "feature.integrations.slack", valueType: "boolean", enabled: true, limitValue: null },
      // Cloudflare/Supabase connect + the credential broker (saas-integration-hub
      // IH4/IH5/IH6; risks D5/D7): same activation posture — available on every
      // tier, with the mint rate limit as the D5 abuse bound.
      { entitlementKey: "feature.integrations.cloudflare", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.supabase", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.credential_broker", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.credential_mints_per_day", valueType: "quantity", enabled: true, limitValue: 200 },
      { entitlementKey: "limit.repo_links", valueType: "quantity", enabled: true, limitValue: 10 },
      { entitlementKey: "feature.event_routing", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_rules", valueType: "quantity", enabled: true, limitValue: 50 },
      { entitlementKey: "feature.notifications.slack", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_channels", valueType: "quantity", enabled: true, limitValue: 10 },
      { entitlementKey: "feature.events.custom_ingest", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.custom_events_per_day", valueType: "quantity", enabled: true, limitValue: 10000 },
      { entitlementKey: "limit.event_retention_days", valueType: "quantity", enabled: true, limitValue: 90 },
      { entitlementKey: "feature.mcp_server", valueType: "boolean", enabled: true, limitValue: null },
    ],
  },
  {
    id: "plan_business",
    code: "business",
    name: "Business",
    description: "Multi-organization ownership, higher limits, and team scale.",
    billingInterval: "month",
    priceAmountCents: 9900,
    priceCurrency: "usd",
    entitlements: [
      { entitlementKey: "limit.projects", valueType: "quantity", enabled: true, limitValue: 100 },
      { entitlementKey: "limit.environments", valueType: "quantity", enabled: true, limitValue: 5 },
      { entitlementKey: "limit.members", valueType: "quantity", enabled: true, limitValue: 50 },
      { entitlementKey: "feature.custom_domains", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.multi_org", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.organizations", valueType: "quantity", enabled: true, limitValue: 5 },
      { entitlementKey: "feature.integrations.github", valueType: "boolean", enabled: true, limitValue: null },
      // Slack connect (saas-integration-hub IH1; risks D7 resolved to the same
      // activation posture as GitHub): available on every tier.
      { entitlementKey: "feature.integrations.slack", valueType: "boolean", enabled: true, limitValue: null },
      // Cloudflare/Supabase connect + the credential broker (saas-integration-hub
      // IH4/IH5/IH6; risks D5/D7): same activation posture — available on every
      // tier, with the mint rate limit as the D5 abuse bound.
      { entitlementKey: "feature.integrations.cloudflare", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.supabase", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.credential_broker", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.credential_mints_per_day", valueType: "quantity", enabled: true, limitValue: 200 },
      { entitlementKey: "limit.repo_links", valueType: "quantity", enabled: true, limitValue: 50 },
      { entitlementKey: "feature.event_routing", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_rules", valueType: "quantity", enabled: true, limitValue: 200 },
      { entitlementKey: "feature.notifications.slack", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_channels", valueType: "quantity", enabled: true, limitValue: 25 },
      { entitlementKey: "feature.events.custom_ingest", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.custom_events_per_day", valueType: "quantity", enabled: true, limitValue: 100000 },
      { entitlementKey: "limit.event_retention_days", valueType: "quantity", enabled: true, limitValue: 365 },
      { entitlementKey: "feature.mcp_server", valueType: "boolean", enabled: true, limitValue: null },
    ],
  },
  {
    id: "plan_enterprise",
    code: "enterprise",
    name: "Enterprise",
    description: "Unlimited scale with custom terms. Contact sales.",
    billingInterval: "none",
    priceAmountCents: 0,
    priceCurrency: "usd",
    entitlements: [
      { entitlementKey: "limit.projects", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "limit.environments", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "limit.members", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "feature.custom_domains", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.multi_org", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.organizations", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.github", valueType: "boolean", enabled: true, limitValue: null },
      // Slack connect (saas-integration-hub IH1; risks D7 resolved to the same
      // activation posture as GitHub): available on every tier.
      { entitlementKey: "feature.integrations.slack", valueType: "boolean", enabled: true, limitValue: null },
      // Cloudflare/Supabase connect + the credential broker (saas-integration-hub
      // IH4/IH5/IH6; risks D5/D7): same activation posture — available on every
      // tier, with the mint rate limit as the D5 abuse bound.
      { entitlementKey: "feature.integrations.cloudflare", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.supabase", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "feature.integrations.credential_broker", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.credential_mints_per_day", valueType: "quantity", enabled: true, limitValue: 200 },
      { entitlementKey: "limit.repo_links", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "feature.event_routing", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_rules", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "feature.notifications.slack", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.notification_channels", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "feature.events.custom_ingest", valueType: "boolean", enabled: true, limitValue: null },
      { entitlementKey: "limit.custom_events_per_day", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "limit.event_retention_days", valueType: "quantity", enabled: true, limitValue: null },
      { entitlementKey: "feature.mcp_server", valueType: "boolean", enabled: true, limitValue: null },
    ],
  },
];

/** Look up a plan definition by its machine code. */
export function getPlanDefinition(code: string): PlanDefinition | null {
  return PLAN_CATALOG.find((p) => p.code === code) ?? null;
}

/** Look up a plan definition by its row id (e.g. "plan_pro"). */
export function getPlanById(planId: string): PlanDefinition | null {
  return PLAN_CATALOG.find((p) => p.id === planId) ?? null;
}

/** Whether a code names a known catalog plan. */
export function isKnownPlanCode(code: string): boolean {
  return PLAN_CATALOG.some((p) => p.code === code);
}
