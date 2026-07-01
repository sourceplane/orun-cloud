import type { MembershipRepository } from "@saas/db/membership";

/**
 * Stub implementations of the saas-teams (TM1/TM2) repository methods, for
 * full-`MembershipRepository` test fakes that do not exercise teams. Spread into
 * a fake literal: `{ ...teamRepoStubs(), ...methodsUnderTest }`. Keeps existing
 * fakes compiling as the interface grows without each test re-stubbing teams.
 */
export function teamRepoStubs(): Pick<
  MembershipRepository,
  | "createTeam"
  | "getTeamById"
  | "getTeamBySlug"
  | "listTeams"
  | "updateTeam"
  | "deleteTeam"
  | "addTeamMember"
  | "removeTeamMember"
  | "listTeamMembers"
  | "listTeamsForSubject"
  | "revokeTeamGrant"
  | "revokeAllTeamGrants"
> {
  const notFound = { ok: false as const, error: { kind: "not_found" as const } };
  return {
    async createTeam() { return notFound; },
    async getTeamById() { return notFound; },
    async getTeamBySlug() { return notFound; },
    async listTeams() { return { ok: true as const, value: [] }; },
    async updateTeam() { return notFound; },
    async deleteTeam() { return notFound; },
    async addTeamMember() { return notFound; },
    async removeTeamMember() { return notFound; },
    async listTeamMembers() { return { ok: true as const, value: [] }; },
    async listTeamsForSubject() { return { ok: true as const, value: [] }; },
    async revokeTeamGrant() { return notFound; },
    async revokeAllTeamGrants() { return { ok: true as const, value: [] }; },
  };
}
