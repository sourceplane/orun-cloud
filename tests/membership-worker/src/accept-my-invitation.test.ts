/// <reference types="@cloudflare/workers-types" />
/**
 * Coverage for POST /v1/me/invitations/:invitationId/accept — token-less
 * acceptance for the signed-in recipient (saas invitation login flow). Asserts:
 * a valid public invitation id is decoded and passed to the repo with the
 * actor's lower-cased email; the success body carries the accepted invitation +
 * membership; the post-commit notification targets the acceptor's own email;
 * repo error kinds map to the right status; and a malformed id 404s without
 * touching the repo.
 */
import { handleAcceptMyInvitation } from "@membership-worker/handlers/accept-my-invitation";
import { invitationPublicId } from "@membership-worker/ids";
import type { Env } from "@membership-worker/env";
import type { AcceptInvitationByIdInput } from "@saas/db/membership";
import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";

const ORG_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const INV_UUID = "11111111-2222-3333-4444-555555555555";
const MEM_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const INV_PUBLIC = invitationPublicId(INV_UUID);
const fixedNow = new Date("2026-07-15T10:00:00.000Z");

const actor = { subjectId: "usr_acceptor", subjectType: "user", email: "Invitee@Example.COM" };

function env(withNotifications = true): Env {
  return {
    PLATFORM_DB: {} as Hyperdrive,
    ENVIRONMENT: "test",
    ...(withNotifications ? { NOTIFICATIONS_WORKER: {} as Fetcher } : {}),
  } as Env;
}

function okRepo(capture?: { input?: AcceptInvitationByIdInput }) {
  return {
    acceptInvitationById: async (input: AcceptInvitationByIdInput) => {
      if (capture) capture.input = input;
      return {
        ok: true as const,
        value: {
          invitation: {
            id: INV_UUID,
            orgId: ORG_UUID,
            email: "Invitee@Example.com",
            emailLower: "invitee@example.com",
            role: "builder",
            status: "accepted",
            invitedBy: "usr_admin",
            expiresAt: new Date("2026-08-15T10:00:00.000Z"),
            acceptedAt: fixedNow,
            revokedAt: null,
            createdAt: fixedNow,
          },
          member: {
            id: MEM_UUID,
            orgId: ORG_UUID,
            subjectId: "usr_acceptor",
            subjectType: "user",
            status: "active",
            createdAt: fixedNow,
            updatedAt: fixedNow,
          },
          roleAssignment: {
            id: "ra-new-uuid",
            orgId: ORG_UUID,
            subjectId: "usr_acceptor",
            subjectType: "user",
            role: "builder",
            scopeKind: "organization",
            scopeRef: null,
            createdAt: fixedNow,
            revokedAt: null,
          },
        },
      };
    },
  };
}

function recorder() {
  const calls: EnqueueNotificationRequest[] = [];
  return {
    calls,
    fn: async (_e: unknown, _c: unknown, request: EnqueueNotificationRequest) => {
      calls.push(request);
      return { ok: true as const, notificationId: "ntf_1" };
    },
  };
}

describe("accept-my-invitation handler", () => {
  it("accepts by decoded invitation id + lower-cased actor email and returns invitation + membership", async () => {
    const cap: { input?: AcceptInvitationByIdInput } = {};
    const res = await handleAcceptMyInvitation(env(), "req_test", actor, INV_PUBLIC, {
      repo: okRepo(cap),
      now: () => fixedNow,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { invitation: { id: string; role: string; status: string }; membership: { id: string; role: string; status: string } };
    };
    expect(body.data.invitation.status).toBe("accepted");
    expect(body.data.invitation.id).toBe(INV_PUBLIC);
    expect(body.data.membership.id).toMatch(/^mem_[0-9a-f]{32}$/);
    expect(body.data.membership.role).toBe("builder");
    expect(body.data.membership.status).toBe("active");
    // Repo received the decoded UUID and the normalized email.
    expect(cap.input?.invitationId).toBe(INV_UUID);
    expect(cap.input?.emailLower).toBe("invitee@example.com");
  });

  it("enqueues invitation.accepted to the acceptor's own email after commit", async () => {
    const rec = recorder();
    await handleAcceptMyInvitation(env(), "req_test", actor, INV_PUBLIC, {
      repo: okRepo(),
      now: () => fixedNow,
      enqueueNotification: rec.fn,
    });
    expect(rec.calls).toHaveLength(1);
    const req = rec.calls[0]!;
    expect(req.category).toBe("invitation");
    expect(req.templateKey).toBe("invitation.accepted");
    expect(req.recipient.channel).toBe("email");
    expect(req.recipient.address).toBe("invitee@example.com");
    expect(req.orgId).toBe(ORG_UUID);
    expect(Object.keys(req.templateData as Record<string, unknown>).sort()).toEqual(
      ["invitationId", "memberId", "orgId", "role"].sort(),
    );
    expect(req.idempotencyKey).toMatch(/^invitation\.accepted:inv_[0-9a-f]+:mem_[0-9a-f]+$/);
  });

  it("404s a malformed invitation id without touching the repo", async () => {
    let called = false;
    const res = await handleAcceptMyInvitation(env(), "req_test", actor, "not-an-inv-id", {
      repo: {
        acceptInvitationById: async () => {
          called = true;
          return { ok: false as const, error: { kind: "not_found" as const } };
        },
      },
      now: () => fixedNow,
    });
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it("401s when the actor has no email", async () => {
    const res = await handleAcceptMyInvitation(
      env(),
      "req_test",
      { ...actor, email: "  " },
      INV_PUBLIC,
      { repo: okRepo(), now: () => fixedNow },
    );
    expect(res.status).toBe(401);
  });

  it.each([
    ["not_found", 404],
    ["expired", 404],
    ["revoked", 404],
    ["already_accepted", 404],
    ["conflict", 409],
  ] as const)("maps repo error %s to HTTP %i and does not notify", async (kind, status) => {
    const rec = recorder();
    const res = await handleAcceptMyInvitation(env(), "req_test", actor, INV_PUBLIC, {
      repo: {
        acceptInvitationById: async () => ({ ok: false as const, error: { kind } as never }),
      },
      now: () => fixedNow,
      enqueueNotification: rec.fn,
    });
    expect(res.status).toBe(status);
    expect(rec.calls).toHaveLength(0);
  });

  it("returns 200 unchanged when enqueue fails — best-effort contract", async () => {
    const res = await handleAcceptMyInvitation(env(), "req_test", actor, INV_PUBLIC, {
      repo: okRepo(),
      now: () => fixedNow,
      enqueueNotification: async () => ({ ok: false as const, reason: "non_2xx" as const }),
    });
    expect(res.status).toBe(200);
  });
});
