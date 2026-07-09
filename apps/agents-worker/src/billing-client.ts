// Billing entitlement gate for agent dispatch (saas-agents AG10, design §8).
// Mirrors the projects/events/notifications billing-client idiom: the
// service-binding-only check seam, fail-closed transport, pure decision
// logic. The `feature.agents` posture follows the MCP6 D3 default — the gate
// is OPEN unless billing explicitly disables it (`not_configured` allows),
// so metering lands before monetization flips the default.

import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

export const INTERNAL_CALLER = "agents-worker";
const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type BillingEntitlementResult =
  | { kind: "decision"; decision: CheckBillingEntitlementResponse }
  | { kind: "service_error" };

export async function checkBillingEntitlement(
  billingWorker: Fetcher,
  orgPublicId: string,
  entitlementKey: string,
  requestId: string,
): Promise<BillingEntitlementResult> {
  let response: Response;
  try {
    response = await billingWorker.fetch("http://billing-worker/v1/internal/billing/entitlements/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
      },
      body: JSON.stringify({ orgId: orgPublicId, entitlementKey }),
    });
  } catch {
    return { kind: "service_error" };
  }
  if (!response.ok) return { kind: "service_error" };
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "service_error" };
  }
  const data =
    parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data: unknown }).data : null;
  if (!data || typeof data !== "object") return { kind: "service_error" };
  const obj = data as Record<string, unknown>;
  if (typeof obj.allowed !== "boolean" || typeof obj.orgId !== "string" || typeof obj.entitlementKey !== "string") {
    return { kind: "service_error" };
  }
  return { kind: "decision", decision: data as CheckBillingEntitlementResponse };
}

export type AgentsEntitlementGate = { kind: "allow" } | { kind: "deny"; message: string };

/**
 * Pure decision for the `feature.agents` gate. OPEN by default (D3): only an
 * explicit `disabled` denies; `not_configured` and transport errors allow —
 * a billing hiccup must never park the fleet before the feature is priced.
 */
export function decideAgentsFeature(result: BillingEntitlementResult): AgentsEntitlementGate {
  if (result.kind === "service_error") return { kind: "allow" };
  const d = result.decision;
  if (!d.allowed && d.reason === "disabled") {
    return {
      kind: "deny",
      message: "Hosted agent sessions are disabled by your current plan — upgrade to dispatch agents",
    };
  }
  return { kind: "allow" };
}
