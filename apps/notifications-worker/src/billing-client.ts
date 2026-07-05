import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

/**
 * Internal caller identity presented to billing-worker on the
 * service-binding-only entitlement-check route (saas-event-streaming ES2:
 * notification rules are entitlement-gated). Non-secret provenance: only
 * Workers bound to billing-worker over a Cloudflare service binding can
 * present this header.
 *
 * Keep in sync with billing-worker's allow-list
 * (apps/billing-worker/src/router.ts: ALLOWED_INTERNAL_CALLERS).
 */
export const INTERNAL_CALLER = "notifications-worker";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type BillingEntitlementResult =
  | { kind: "decision"; decision: CheckBillingEntitlementResponse }
  | { kind: "service_error" };

/**
 * Calls billing-worker's private entitlement-check seam over a service
 * binding. Fails closed: any network exception, non-OK HTTP status, or
 * malformed JSON envelope surfaces as `service_error`.
 */
export async function checkBillingEntitlement(
  billingWorker: Fetcher,
  orgPublicId: string,
  entitlementKey: string,
  requestId: string,
): Promise<BillingEntitlementResult> {
  let response: Response;
  try {
    response = await billingWorker.fetch(
      "http://billing-worker/v1/internal/billing/entitlements/check",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
        },
        body: JSON.stringify({ orgId: orgPublicId, entitlementKey }),
      },
    );
  } catch {
    return { kind: "service_error" };
  }

  if (!response.ok) {
    return { kind: "service_error" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "service_error" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { kind: "service_error" };
  }
  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object") {
    return { kind: "service_error" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.allowed !== "boolean") {
    return { kind: "service_error" };
  }
  if (typeof obj.orgId !== "string" || typeof obj.entitlementKey !== "string") {
    return { kind: "service_error" };
  }

  return { kind: "decision", decision: data as CheckBillingEntitlementResponse };
}
