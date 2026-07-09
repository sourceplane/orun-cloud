import type {
  PublicWebhookDeliveryAttempt,
  PublicWebhookEndpoint,
} from "@saas/contracts/webhooks";
import { z } from "zod";

import { compact, cursorArg, encodeStateCursor, limitArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

import type { ListDeliveryAttemptsQuery } from "@saas/sdk";

export const webhookDeliveriesListTool = defineTool({
  name: "webhook_deliveries_list",
  title: "List webhook deliveries",
  description:
    "Debug webhook delivery failures: pass `endpoint` (`whep_…`) to page through that endpoint's delivery attempts, newest first; omit it to list the workspace's endpoints so you can pick one. Read-only — replay ships later.",
  inputSchema: z.object({
    ...scopedShape,
    endpoint: z
      .string()
      .min(1)
      .describe("Webhook endpoint id. Omit to list endpoints instead of deliveries.")
      .optional(),
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx) => {
    if (input.endpoint === undefined) {
      const res = await ctx.sdk.webhooks.listEndpoints(input.workspace);
      const data = {
        endpoints: res.endpoints,
        meta: { cursor: encodeStateCursor(res.nextCursor) },
      } satisfies {
        endpoints: PublicWebhookEndpoint[];
        meta: { cursor: string | null };
      };
      return {
        summary: `${res.endpoints.length} endpoint(s); pass one id as \`endpoint\` for its deliveries`,
        data,
      };
    }
    const page = await ctx.sdk.webhooks.listDeliveryAttemptsPage(
      input.workspace,
      input.endpoint,
      compact<ListDeliveryAttemptsQuery>({ cursor: input.cursor, limit: input.limit }),
    );
    const data = {
      deliveryAttempts: page.deliveryAttempts,
      meta: { cursor: page.nextCursor },
    } satisfies {
      deliveryAttempts: ReadonlyArray<PublicWebhookDeliveryAttempt>;
      meta: { cursor: string | null };
    };
    return {
      summary: `${page.deliveryAttempts.length} delivery attempt(s)`,
      data,
    };
  },
});
