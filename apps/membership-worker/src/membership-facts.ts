import type { MembershipFact, FactOrigin, TenancyRole, RoleScopeKind } from "@saas/contracts/policy";
import type { RoleAssignment } from "@saas/db/membership";

/**
 * Map role assignments to policy facts, stamping each with its provenance
 * (saas-teams TM6). `origin` is the default for non-team assignments (direct
 * grants, or the account cascade when the caller passes `{kind:'account_cascade'}`);
 * a `subject_type='team'` assignment always resolves to `{kind:'team', teamId}`
 * (the team public id lives in `subject_id`), so a batch of team grants gets its
 * per-team attribution automatically. The policy engine ignores `grantedVia`.
 */
export function mapRoleAssignmentsToFacts(
  orgId: string,
  assignments: RoleAssignment[],
  origin: FactOrigin = { kind: "direct" },
): MembershipFact[] {
  return assignments.map((ra) => {
    let scope: MembershipFact["scope"];
    if (ra.scopeKind === "project") {
      scope = { kind: "project" as RoleScopeKind, orgId, ...(ra.scopeRef ? { projectId: ra.scopeRef } : {}) };
    } else if (ra.scopeKind === "account") {
      // Account-scoped facts (saas-workspace-id WID6) are stamped with the TARGET
      // orgId so the policy engine's `scope.orgId === orgId` filter matches them
      // and the account role cascades onto the target workspace.
      scope = { kind: "account" as RoleScopeKind, orgId };
    } else {
      scope = { kind: "organization" as RoleScopeKind, orgId };
    }
    const grantedVia: FactOrigin =
      ra.subjectType === "team" ? { kind: "team", teamId: ra.subjectId } : origin;
    return { kind: "role_assignment" as const, role: ra.role as TenancyRole, scope, grantedVia };
  });
}
