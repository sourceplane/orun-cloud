import type { PublicSecurityEvent } from "@saas/contracts/security-events";
import { z } from "zod";

import { compact, cursorArg, limitArg } from "../scope.js";
import { defineTool } from "../tool.js";

import type { ListSecurityEventsQuery } from "@saas/sdk";

export const securityEventsListTool = defineTool({
  name: "security_events_list",
  title: "List security events",
  description:
    "List the calling actor's authentication/session security events (sign-ins, session lifecycle, failures), newest first. Actor-scoped — no workspace argument. For org-wide activity use `audit_search`.",
  inputSchema: z.object({
    cursor: cursorArg.optional(),
    limit: limitArg.optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (input, ctx) => {
    const page = await ctx.sdk.securityEvents.listPage(
      compact<ListSecurityEventsQuery>({ cursor: input.cursor, limit: input.limit }),
    );
    const data = {
      securityEvents: page.securityEvents,
      meta: { cursor: page.nextCursor },
    } satisfies {
      securityEvents: ReadonlyArray<PublicSecurityEvent>;
      meta: { cursor: string | null };
    };
    return { summary: `${page.securityEvents.length} security event(s)`, data };
  },
});
