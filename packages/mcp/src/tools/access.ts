import type { PublicMember, PublicTeam } from "@saas/contracts/membership";
import type { EffectivePermission } from "@saas/contracts/policy";
import { z } from "zod";

import { compact, projectArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

export const accessExplainTool = defineTool({
  name: "access_explain",
  title: "Explain effective access",
  description:
    "Answer \"who can do what here, and via which grant\": effective permissions with provenance (direct / team / account-cascade) plus the workspace's member and team rosters. Defaults to the caller; pass `subjectId` for someone else (needs member-list authority) and `project` to narrow scope.",
  inputSchema: z.object({
    ...scopedShape,
    project: projectArg.optional(),
    subjectId: z
      .string()
      .min(1)
      .describe("Subject to explain (`usr_…` / `sp_…`). Defaults to the caller.")
      .optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const [access, members, teams] = await Promise.all([
      ctx.sdk.teams.effectiveAccess(
        input.workspace,
        compact<{ projectId?: string; subjectId?: string }>({
          projectId: input.project,
          subjectId: input.subjectId,
        }),
      ),
      ctx.sdk.memberships.listMembers(input.workspace),
      ctx.sdk.teams.listTeams(input.workspace),
    ]);
    const allowed = access.permissions.filter((p) => p.allow).length;
    const data = {
      permissions: access.permissions,
      members: members.members,
      teams: teams.teams,
    } satisfies {
      permissions: EffectivePermission[];
      members: PublicMember[];
      teams: PublicTeam[];
    };
    return {
      summary: `${allowed}/${access.permissions.length} action(s) allowed; ${members.members.length} member(s), ${teams.teams.length} team(s)`,
      data,
    };
  },
});
