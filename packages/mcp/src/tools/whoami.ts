import type { AuthUser, PublicOrganization } from "@saas/sdk";
import { z } from "zod";

import { defineTool } from "../tool.js";

export const whoamiTool = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Identify the authenticated actor and list the workspaces they belong to (with roles where the API reports them). Call this first to orient before any workspace-scoped tool; it takes no arguments.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (_input, ctx) => {
    const [profile, workspaces] = await Promise.all([
      ctx.sdk.auth.getProfile(),
      ctx.sdk.workspaces.list(),
    ]);
    const data = {
      user: profile.user,
      workspaces: workspaces.organizations,
    } satisfies { user: AuthUser; workspaces: PublicOrganization[] };
    return {
      summary: `${profile.user.email} — member of ${workspaces.organizations.length} workspace(s)`,
      data,
    };
  },
});
