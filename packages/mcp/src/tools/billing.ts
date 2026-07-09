import type {
  GetBillingSummaryResponse,
  PublicEntitlement,
} from "@saas/contracts/billing";
import { z } from "zod";

import { scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

export const billingSummaryTool = defineTool({
  name: "billing_summary",
  title: "Billing summary",
  description:
    "Read a workspace's billing posture: current plan, subscription, customer status, and the full entitlement set (plan + overrides). Read-only — plan changes happen in the console, not here.",
  inputSchema: z.object({ ...scopedShape }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const [summary, entitlements] = await Promise.all([
      ctx.sdk.billing.getSummary(input.workspace),
      ctx.sdk.billing.getEntitlements(input.workspace),
    ]);
    const data = {
      summary,
      entitlements: entitlements.entitlements,
    } satisfies {
      summary: GetBillingSummaryResponse;
      entitlements: PublicEntitlement[];
    };
    return {
      summary: `plan: ${summary.plan?.name ?? "none"}; ${entitlements.entitlements.length} entitlement(s)`,
      data,
    };
  },
});
