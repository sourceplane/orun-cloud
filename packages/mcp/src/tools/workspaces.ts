import type { PublicOrganization } from "@saas/sdk";
import { z } from "zod";

import { defineTool } from "../tool.js";

export const workspacesListTool = defineTool({
  name: "workspaces_list",
  title: "List workspaces",
  description:
    "List the workspaces the caller is a member of: slugs, `ws_…` refs, and kind (account/workspace). Use the returned slug or ref as the `workspace` argument of every scoped tool; not needed if `whoami` was already called.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (_input, ctx) => {
    const res = await ctx.sdk.workspaces.list();
    const data = { workspaces: res.organizations } satisfies {
      workspaces: PublicOrganization[];
    };
    return {
      summary: `${res.organizations.length} workspace(s)`,
      data,
    };
  },
});
