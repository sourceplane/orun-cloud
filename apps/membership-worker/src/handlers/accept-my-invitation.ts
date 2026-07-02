import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { successResponse, errorResponse } from "../http.js";
import { parseInvitationPublicId, orgPublicId, invitationPublicId, memberPublicId } from "../ids.js";
import {
  enqueueNotification,
  buildIdempotencyKey,
  type EnqueueNotificationResult,
} from "@saas/notifications-client";
import type { AcceptActorContext } from "./accept-invitation.js";

export interface AcceptMyInvitationDeps {
  repo: Pick<MembershipRepository, "acceptInvitationById">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
  /**
   * Injectable notifications enqueue for tests. Mirrors the accept-invitation
   * handler: when omitted on the deps (non-transactional) path, NO enqueue is
   * attempted; the real transactional path always calls the real
   * `enqueueNotification` (best-effort; absent binding is a no-op).
   */
  enqueueNotification?: (
    env: { NOTIFICATIONS_WORKER?: Fetcher },
    ctx: {
      internalActor: string;
      actorSubjectType: string;
      actorSubjectId: string;
      requestId: string;
    },
    request: Parameters<typeof enqueueNotification>[2],
  ) => Promise<EnqueueNotificationResult>;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * POST /v1/me/invitations/:invitationId/accept — accept an invitation the
 * signed-in user discovered via `GET /v1/me/invitations`, without a one-time
 * token. Acceptance is gated on the invitation's `email_lower` matching the
 * actor's verified (magic-link) session email — equivalent proof of email
 * control to the token flow, which is required because the invitation email
 * never delivers a token. Same member + role-assignment writes, `invite.accepted`
 * event, and best-effort `invitation.accepted` notification as the token path.
 */
export async function handleAcceptMyInvitation(
  env: Env,
  requestId: string,
  actor: AcceptActorContext,
  invitationIdParam: string,
  deps?: AcceptMyInvitationDeps,
): Promise<Response> {
  const invitationUuid = parseInvitationPublicId(invitationIdParam);
  if (!invitationUuid) {
    return errorResponse("not_found", "Invitation not found", 404, requestId);
  }

  const emailLower = actor.email.trim().toLowerCase();
  if (!emailLower) {
    return errorResponse("unauthenticated", "Authentication required", 401, requestId);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const memberId = crypto.randomUUID();
  const roleAssignmentId = crypto.randomUUID();
  const genId = deps?.generateId ?? (() => randomHex(16));

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createMembershipRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const result = await txRepo.acceptInvitationById({
          invitationId: invitationUuid,
          emailLower,
          memberId,
          roleAssignmentId,
          subjectId: actor.subjectId,
          subjectType: actor.subjectType,
          acceptedAt: now,
        });

        if (!result.ok) {
          return { result };
        }

        const { invitation: inv, member } = result.value;

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "invite.accepted",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: inv.orgId,
            subjectKind: "invitation",
            subjectId: inv.id,
            requestId,
            payload: { invitationId: invitationPublicId(inv.id), role: inv.role, memberId: memberPublicId(member.id) },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Invitation ${invitationPublicId(inv.id)} accepted`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("event_append_failed");
        }

        return { result };
      });

      if (!txResult.result.ok) {
        return acceptErrorResponse(txResult.result.error, requestId);
      }

      const { invitation: inv, member, roleAssignment } = txResult.result.value;

      // Best-effort notification AFTER commit — a rolled-back acceptance must
      // never notify. Same idempotency contract as the token accept path.
      const enqueueFn = deps?.enqueueNotification ?? enqueueNotification;
      await enqueueFn(
        env,
        {
          internalActor: "membership-worker",
          actorSubjectType: actor.subjectType,
          actorSubjectId: actor.subjectId,
          requestId,
        },
        buildAcceptNotification(inv.orgId, inv.id, inv.role, member.id, emailLower, requestId),
      );

      return acceptSuccessResponse(inv, member, roleAssignment, requestId);
    }

    // Non-transactional path (unit tests with injected deps)
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const result = await repo.acceptInvitationById({
      invitationId: invitationUuid,
      emailLower,
      memberId,
      roleAssignmentId,
      subjectId: actor.subjectId,
      subjectType: actor.subjectType,
      acceptedAt: now,
    });

    if (!result.ok) {
      return acceptErrorResponse(result.error, requestId);
    }

    const { invitation: inv, member, roleAssignment } = result.value;

    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "invite.accepted",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: inv.orgId,
          subjectKind: "invitation",
          subjectId: inv.id,
          requestId,
          payload: { invitationId: invitationPublicId(inv.id), role: inv.role, memberId: memberPublicId(member.id) },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Invitation ${invitationPublicId(inv.id)} accepted`,
        },
      });

      if (!eventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    if (deps?.enqueueNotification) {
      await deps.enqueueNotification(
        env,
        {
          internalActor: "membership-worker",
          actorSubjectType: actor.subjectType,
          actorSubjectId: actor.subjectId,
          requestId,
        },
        buildAcceptNotification(inv.orgId, inv.id, inv.role, member.id, emailLower, requestId),
      );
    }

    return acceptSuccessResponse(inv, member, roleAssignment, requestId);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

function acceptErrorResponse(
  err: { kind: string },
  requestId: string,
): Response {
  switch (err.kind) {
    case "not_found":
    case "expired":
    case "revoked":
    case "already_accepted":
      return errorResponse("not_found", "Invitation not found", 404, requestId);
    case "conflict":
      return errorResponse("conflict", "Membership already exists", 409, requestId);
    default:
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}

function acceptSuccessResponse(
  inv: { id: string; email: string; role: string; invitedBy: string; expiresAt: Date; createdAt: Date; acceptedAt: Date | null; revokedAt: Date | null },
  member: { id: string; createdAt: Date; status: string },
  roleAssignment: { role: string },
  requestId: string,
): Response {
  return successResponse(
    {
      invitation: {
        id: invitationPublicId(inv.id),
        email: inv.email,
        role: inv.role,
        status: "accepted" as const,
        invitedBy: inv.invitedBy,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
        acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
        revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
      },
      membership: {
        id: memberPublicId(member.id),
        role: roleAssignment.role,
        joinedAt: member.createdAt.toISOString(),
        status: member.status,
      },
    },
    requestId,
    200,
  );
}

function buildAcceptNotification(
  orgUuid: string,
  invUuid: string,
  role: string,
  memberUuid: string,
  recipientEmail: string,
  requestId: string,
): Parameters<typeof enqueueNotification>[2] {
  return {
    orgId: orgUuid,
    category: "invitation",
    templateKey: "invitation.accepted",
    templateData: {
      invitationId: invitationPublicId(invUuid),
      role,
      memberId: memberPublicId(memberUuid),
      orgId: orgPublicId(orgUuid),
    },
    recipient: {
      channel: "email",
      // Recipient is the acceptor themselves; the invitation's email_lower was
      // verified to equal the session email before this row was written.
      address: recipientEmail,
    },
    idempotencyKey: buildIdempotencyKey(
      "invitation.accepted",
      invitationPublicId(invUuid),
      memberPublicId(memberUuid),
    ),
    correlationId: requestId,
  };
}
