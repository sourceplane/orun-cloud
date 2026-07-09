// member_invite (MCP5, design §4/§7). Deliberately the ONLY membership write
// on the MCP plane: role changes, member removal, and team/account grants are
// excluded from v1 writes (high blast radius, low agent value — design §4).

import type { InvitationRole, PublicInvitation } from "@saas/contracts/membership";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";
import { z } from "zod";

import { idempotencyKeyArg, resolveIdempotencyKey } from "../idempotency.js";
import { scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

export const memberInviteTool = defineTool({
  name: "member_invite",
  title: "Invite member",
  description:
    "Invite a person to a workspace by email with an organization role (they join once they accept). This is a WRITE: policy-gated (admin-or-higher role) and audited like any console/CLI mutation; retries are replay-safe (an Idempotency-Key is generated per call unless you supply `idempotencyKey`). The one-time accept token is NOT returned — the invitee accepts via their own signed-in session. To review members and grants use `access_explain`.",
  inputSchema: z.object({
    ...scopedShape,
    email: z.string().email().describe("Email address to invite."),
    role: z
      .enum(ORGANIZATION_ROLES)
      .describe(
        "Organization role granted on acceptance. Prefer the least-privileged role that fits (`viewer` for read-only access).",
      ),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const body = { email: input.email, role: input.role } satisfies {
      email: string;
      role: InvitationRole;
    };
    const res = await ctx.sdk.memberships.createInvitation(input.workspace, body, {
      idempotencyKey: resolveIdempotencyKey(input.idempotencyKey),
    });
    // The response may carry a one-time accept token (`delivery.token`) for
    // out-of-band delivery flows. It is credential-shaped material — never
    // hand it to an agent (design §7 posture); the invitee accepts via
    // `/v1/me/invitations` on their own session.
    const data = { invitation: res.invitation } satisfies {
      invitation: PublicInvitation;
    };
    return {
      summary: `invited ${res.invitation.email} as ${res.invitation.role} (${res.invitation.status}, expires ${res.invitation.expiresAt})`,
      data,
    };
  },
});
