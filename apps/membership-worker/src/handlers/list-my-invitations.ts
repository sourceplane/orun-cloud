import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository } from "@saas/db/membership";
import { successResponse, errorResponse } from "../http.js";
import { orgPublicId, invitationPublicId } from "../ids.js";

export interface ListMyInvitationsDeps {
  repo: Pick<MembershipRepository, "listPendingInvitationsByEmail">;
}

/**
 * GET /v1/me/invitations — every still-actionable invitation addressed to the
 * signed-in actor's verified email, across all organizations. This is the
 * discovery half of the invitation login flow: the invitation email carries no
 * token link and tells the recipient to "sign in with this email address to
 * view and accept the invitation," so this endpoint (keyed on the session's
 * `x-actor-email`) is how they find those invitations. No org scope and no
 * policy check — a user is always allowed to see invitations sent to their own
 * verified address.
 */
export async function handleListMyInvitations(
  env: Env,
  requestId: string,
  actorEmail: string,
  deps?: ListMyInvitationsDeps,
): Promise<Response> {
  const emailLower = actorEmail.trim().toLowerCase();
  if (!emailLower) {
    return errorResponse("unauthenticated", "Authentication required", 401, requestId);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);
    const result = await repo.listPendingInvitationsByEmail(emailLower);
    if (!result.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    const invitations = result.value.map(({ invitation, org }) => ({
      id: invitationPublicId(invitation.id),
      org: {
        id: orgPublicId(org.id),
        name: org.name,
        slug: org.slug,
        workspaceRef: org.publicRef,
        status: org.status,
      },
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    }));

    return successResponse({ invitations }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
