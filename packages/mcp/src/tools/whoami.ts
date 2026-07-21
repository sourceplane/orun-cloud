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
    // The workspace list is the load-bearing call — it authenticates via the
    // same tool-plane path as every other tool, so any real auth/permission
    // failure surfaces here.
    const workspaces = await ctx.sdk.workspaces.list();
    // The human profile (email/displayName) is BEST-EFFORT: `getProfile`
    // (/v1/auth/profile) resolves only interactive SESSION credentials, but on
    // the remote transport the caller is an `sk_` API key or an MCP OAuth
    // CLI-JWT — valid for every tool, yet with no user-profile endpoint. Rather
    // than fail orientation entirely, degrade to `user: null` and still return
    // the workspaces (a partial answer beats an error for the "call this first"
    // tool). A genuine profile error for a session credential is likewise
    // tolerated — the workspace list already proved the credential is good.
    let user: AuthUser | null = null;
    try {
      user = (await ctx.sdk.auth.getProfile()).user;
    } catch {
      user = null;
    }
    const data = {
      user,
      workspaces: workspaces.organizations,
    } satisfies { user: AuthUser | null; workspaces: PublicOrganization[] };
    const who = user
      ? user.email
      : "authenticated (API key or MCP token — no user profile)";
    return {
      summary: `${who} — member of ${workspaces.organizations.length} workspace(s)`,
      data,
    };
  },
});
