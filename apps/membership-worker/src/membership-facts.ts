import type { MembershipFact, TenancyRole, RoleScopeKind } from "@saas/contracts/policy";
import type { RoleAssignment } from "@saas/db/membership";

export function mapRoleAssignmentsToFacts(orgId: string, assignments: RoleAssignment[]): MembershipFact[] {
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
    return { kind: "role_assignment" as const, role: ra.role as TenancyRole, scope };
  });
}
