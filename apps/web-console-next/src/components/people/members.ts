/**
 * Pure helpers for the Members panel (saas-settings-ia SI3). Dependency-free so
 * the role logic is unit-testable independent of React.
 */

import { ORGANIZATION_ROLES } from "@saas/contracts/membership";

/** The org roles a member can hold, in privilege order (for the role picker). */
export const MEMBER_ROLE_OPTIONS: readonly string[] = ORGANIZATION_ROLES;

/**
 * The single role to show (and edit) for a member that may hold several.
 * `owner` wins so the most-privileged grant is what an admin sees and edits;
 * otherwise the first assigned role, falling back to `viewer` for a member with
 * no explicit role fact.
 */
export function primaryRole(roles: ReadonlyArray<{ role: string }>): string {
  if (roles.some((r) => r.role === "owner")) return "owner";
  return roles[0]?.role ?? "viewer";
}

/** Whether changing a member from `current` to `next` is a real change worth a PATCH. */
export function isRoleChange(current: string, next: string): boolean {
  return next !== current && (MEMBER_ROLE_OPTIONS as string[]).includes(next);
}
