import { handleResolveTeamHandle } from "@membership-worker/handlers/resolve-team-handle";
import { orgPublicId, teamPublicId } from "@membership-worker/ids";
import type { MembershipRepository, Organization, Team } from "@saas/db/membership";
import type { Env } from "@membership-worker/env";

function fakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
  };
}

const ACCOUNT_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_UUID = "00000000-0000-0000-0000-0000000000b1";
const NOW = new Date("2026-01-01T00:00:00Z");

function org(): Organization {
  return {
    id: ACCOUNT_UUID,
    name: "Acme",
    slug: "acme",
    slugLower: "acme",
    publicRef: "ws_3KF9TQ2P",
    status: "active",
    parentOrgId: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Organization;
}

function team(handle: string): Team {
  return {
    id: TEAM_UUID,
    accountOrgId: ACCOUNT_UUID,
    name: "Payments",
    slugLower: "payments",
    handle,
    description: null,
    avatarRef: null,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Team;
}

function repoWith(teamByHandle: Record<string, Team>): MembershipRepository {
  return {
    async getOrganizationById() {
      return { ok: true, value: org() };
    },
    async getTeamByHandle(_accountOrgId: string, handleLower: string) {
      const t = teamByHandle[handleLower];
      return t ? { ok: true as const, value: t } : { ok: false as const, error: { kind: "not_found" as const } };
    },
  } as unknown as MembershipRepository;
}

function req(body: unknown): Request {
  return new Request("http://membership-worker/v1/internal/membership/resolve-team-handle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("resolve-team-handle handler (TC2)", () => {
  it("resolves a handle (with or without a leading @) to a team public id", async () => {
    const repo = repoWith({ payments: team("payments") });
    const res = await handleResolveTeamHandle(req({ orgId: orgPublicId(ACCOUNT_UUID), handle: "@Payments" }), fakeEnv(), "r1", { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { teamId: string | null; handle: string | null } };
    expect(body.data.teamId).toBe(teamPublicId(TEAM_UUID));
  });

  it("returns teamId null (200) for an unknown handle", async () => {
    const repo = repoWith({});
    const res = await handleResolveTeamHandle(req({ orgId: orgPublicId(ACCOUNT_UUID), handle: "ghost" }), fakeEnv(), "r2", { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { teamId: string | null } };
    expect(body.data.teamId).toBeNull();
  });

  it("422s when handle is missing", async () => {
    const repo = repoWith({});
    const res = await handleResolveTeamHandle(req({ orgId: orgPublicId(ACCOUNT_UUID) }), fakeEnv(), "r3", { repo });
    expect(res.status).toBe(422);
  });
});
