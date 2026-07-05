import { handleInternalTeamMembers } from "@membership-worker/handlers/internal-team-members";
import { teamPublicId } from "@membership-worker/ids";
import type { MembershipRepository, TeamMember } from "@saas/db/membership";
import type { Env } from "@membership-worker/env";

function fakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
  };
}

const TEAM_UUID = "00000000-0000-0000-0000-0000000000b1";
const NOW = new Date("2026-01-01T00:00:00Z");

function member(subjectId: string, over: Partial<TeamMember> = {}): TeamMember {
  return { teamId: TEAM_UUID, subjectId, subjectType: "user", teamRole: "team_member", status: "active", createdAt: NOW, ...over };
}

function repoWith(members: TeamMember[]): MembershipRepository {
  return {
    async listTeamMembers() {
      return { ok: true, value: members };
    },
  } as unknown as MembershipRepository;
}

function req(teamId: unknown): Request {
  return new Request("http://membership-worker/v1/internal/membership/team-members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId }),
  });
}

describe("internal team-members handler (TC1)", () => {
  it("returns the active roster with subject id, type, and team role", async () => {
    const res = await handleInternalTeamMembers(req(teamPublicId(TEAM_UUID)), fakeEnv(), "r1", {
      repo: repoWith([member("usr_a"), member("sp_bot", { subjectType: "service_principal" }), member("usr_c", { teamRole: "team_admin" })]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { members: Array<{ subjectId: string; subjectType: string; teamRole: string }> };
    };
    expect(body.data.members).toHaveLength(3);
    expect(body.data.members.map((m) => m.subjectId)).toEqual(["usr_a", "sp_bot", "usr_c"]);
    expect(body.data.members[1]!.subjectType).toBe("service_principal");
    expect(body.data.members[2]!.teamRole).toBe("team_admin");
  });

  it("404s on an unparseable team id", async () => {
    const res = await handleInternalTeamMembers(req("not-a-team"), fakeEnv(), "r2", { repo: repoWith([]) });
    expect(res.status).toBe(404);
  });

  it("422s when teamId is missing", async () => {
    const res = await handleInternalTeamMembers(req(undefined), fakeEnv(), "r3", { repo: repoWith([]) });
    expect(res.status).toBe(422);
  });
});
