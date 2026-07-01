/// <reference types="@cloudflare/workers-types" />
/**
 * Coverage for GET /v1/me/invitations — the signed-in recipient's pending
 * invitation discovery (saas invitation login flow). Asserts the handler keys
 * the lookup on the actor's lower-cased email, projects org display fields +
 * public ids, and rejects a missing email as unauthenticated.
 */
import { handleListMyInvitations } from "@membership-worker/handlers/list-my-invitations";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, PendingInvitationForEmail } from "@saas/db/membership";

function fakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
  } as unknown as Env;
}

const ORG_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const INV_UUID = "11111111-2222-3333-4444-555555555555";

function pending(over: Partial<PendingInvitationForEmail["invitation"]> = {}): PendingInvitationForEmail {
  return {
    invitation: {
      id: INV_UUID,
      orgId: ORG_UUID,
      email: "Invitee@Example.com",
      emailLower: "invitee@example.com",
      role: "builder",
      status: "pending",
      invitedBy: "usr_admin",
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      ...over,
    },
    org: {
      id: ORG_UUID,
      name: "Acme",
      slug: "acme",
      publicRef: "ws_ACME0001",
      status: "active",
    },
  };
}

function repoWith(
  items: PendingInvitationForEmail[],
): { repo: Pick<MembershipRepository, "listPendingInvitationsByEmail">; emails: string[] } {
  const emails: string[] = [];
  return {
    emails,
    repo: {
      async listPendingInvitationsByEmail(emailLower: string) {
        emails.push(emailLower);
        return { ok: true as const, value: items };
      },
    },
  };
}

describe("list-my-invitations handler", () => {
  it("projects org public id, workspaceRef, role and normalizes the actor email", async () => {
    const { repo, emails } = repoWith([pending()]);
    const res = await handleListMyInvitations(fakeEnv(), "r1", "Invitee@Example.com", { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        invitations: Array<{
          id: string;
          role: string;
          email: string;
          org: { id: string; name: string; slug: string; workspaceRef: string; status: string };
        }>;
      };
    };
    const list = body.data.invitations;
    expect(list).toHaveLength(1);
    const inv = list[0]!;
    expect(inv.id).toMatch(/^inv_[0-9a-f]{32}$/);
    expect(inv.org.id).toMatch(/^org_[0-9a-f]{32}$/);
    expect(inv.org.name).toBe("Acme");
    expect(inv.org.slug).toBe("acme");
    expect(inv.org.workspaceRef).toBe("ws_ACME0001");
    expect(inv.role).toBe("builder");
    expect(inv.email).toBe("Invitee@Example.com");
    // The lookup is keyed on the lower-cased address, not the raw header.
    expect(emails).toEqual(["invitee@example.com"]);
  });

  it("returns an empty list when the user has no pending invitations", async () => {
    const { repo } = repoWith([]);
    const res = await handleListMyInvitations(fakeEnv(), "r1", "nobody@example.com", { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { invitations: unknown[] } };
    expect(body.data.invitations).toEqual([]);
  });

  it("401s when no actor email is present", async () => {
    const { repo, emails } = repoWith([pending()]);
    const res = await handleListMyInvitations(fakeEnv(), "r1", "   ", { repo });
    expect(res.status).toBe(401);
    expect(emails).toHaveLength(0);
  });

  it("500s when the repository fails", async () => {
    const repo: Pick<MembershipRepository, "listPendingInvitationsByEmail"> = {
      async listPendingInvitationsByEmail() {
        return { ok: false as const, error: { kind: "internal" as const, message: "boom" } };
      },
    };
    const res = await handleListMyInvitations(fakeEnv(), "r1", "invitee@example.com", { repo });
    expect(res.status).toBe(500);
  });
});
