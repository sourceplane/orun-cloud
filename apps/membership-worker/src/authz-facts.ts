import type { MembershipRepository, RoleAssignment } from "@saas/db/membership";
import type { MembershipFact } from "@saas/contracts/policy";
import { effectiveBillingOrgId } from "@saas/db/membership";
import { asUuid, type Uuid } from "@saas/db/ids";
import { mapRoleAssignmentsToFacts } from "./membership-facts.js";
import { teamPublicId } from "./ids.js";

/**
 * All active grants held by a set of subjects on one org. Prefers the batched
 * `listRoleAssignmentsForSubjects` (one query, PERF3); falls back to per-subject
 * `listRoleAssignments` when a repo/fake omits the batch method.
 */
async function grantsForSubjects(
  repo: MembershipRepository,
  orgUuid: Uuid,
  subjectIds: string[],
): Promise<RoleAssignment[]> {
  if (subjectIds.length === 0) return [];
  if (repo.listRoleAssignmentsForSubjects) {
    const res = await repo.listRoleAssignmentsForSubjects(orgUuid, subjectIds);
    if (!res.ok) return [];
    return Array.from(res.value.values()).flat();
  }
  const out: RoleAssignment[] = [];
  for (const sid of subjectIds) {
    const res = await repo.listRoleAssignments(orgUuid, sid);
    if (res.ok) out.push(...res.value);
  }
  return out;
}

/**
 * Assemble an actor's effective policy facts on a target org (saas-teams TM3/TM6):
 * direct grants + the WID6 account cascade + team-derived grants, each stamped
 * with `grantedVia` provenance. Shared by the authorization-context builder and
 * the effective-access read so both see identical facts. Throws if the direct
 * role query fails; the account/team enrichment is fail-soft (returns just the
 * direct facts on error), matching the original hot-path behavior.
 */
export async function assembleAuthorizationFacts(
  repo: MembershipRepository,
  subjectId: string,
  targetOrgId: string,
): Promise<MembershipFact[]> {
  const targetOrgUuid = asUuid(targetOrgId);
  const rolesResult = await repo.listRoleAssignments(targetOrgUuid, subjectId);
  if (!rolesResult.ok) {
    throw new Error("assembleAuthorizationFacts: direct role query failed");
  }

  // Org/project facts held directly on the target org. Any account-scoped rows
  // returned here (the case where the target IS the account root) are preserved
  // by the mapper and cascade onto the target via the engine's account catalog.
  const memberships = mapRoleAssignmentsToFacts(targetOrgId, rolesResult.value);

  // Account cascade (WID6) + team-derived facts (TM3). Fail-soft: on any error
  // fall back to the direct facts only.
  try {
    const orgResult = await repo.getOrganizationById(targetOrgUuid);
    if (orgResult.ok) {
      const accountUuid = effectiveBillingOrgId(orgResult.value);
      const isChild = accountUuid !== targetOrgUuid;

      // (A) User account-scope cascade (WID6) — child workspaces only.
      if (isChild) {
        const accountRolesResult = await repo.listRoleAssignments(asUuid(accountUuid), subjectId);
        if (accountRolesResult.ok) {
          const accountAssignments = accountRolesResult.value.filter((ra) => ra.scopeKind === "account");
          memberships.push(...mapRoleAssignmentsToFacts(targetOrgId, accountAssignments, { kind: "account_cascade" }));
        }
      }

      // (B) Team-derived facts (TM3). Short-circuit when the actor is in no team.
      const teamsResult = await repo.listTeamsForSubject(asUuid(accountUuid), subjectId);
      if (teamsResult.ok && teamsResult.value.length > 0) {
        const teamPublicIds = teamsResult.value.map((t) => teamPublicId(t.id));

        const targetTeamGrants = await grantsForSubjects(repo, targetOrgUuid, teamPublicIds);
        memberships.push(...mapRoleAssignmentsToFacts(targetOrgId, targetTeamGrants));

        if (isChild) {
          const accountTeamGrants = (
            await grantsForSubjects(repo, asUuid(accountUuid), teamPublicIds)
          ).filter((ra) => ra.scopeKind === "account");
          memberships.push(...mapRoleAssignmentsToFacts(targetOrgId, accountTeamGrants));
        }
      }
    }
  } catch {
    // Fail-soft — keep direct org/project facts only.
  }

  return memberships;
}
