/**
 * Roles reference for the People & Access "Roles" tab (saas-settings-ia SI4).
 *
 * A legible, capability-area view of what each organization role can do — the
 * destination that makes "roles" more than a dropdown value. This is a
 * **display mirror** of the normative role semantics in
 * `specs/core/contracts/tenancy-and-rbac.md`; the authoritative per-action
 * catalog lives in `packages/policy-engine` (ORG_ROLE_PERMISSIONS). It is the
 * seam custom roles (teams-governance TG) plug into later.
 *
 * Dependency-free so the catalog and lookups are unit-testable.
 */

import { ORGANIZATION_ROLES } from "@saas/contracts/membership";

export type RoleLevel = "full" | "partial" | "none";

export interface RoleDef {
  /** The internal role key (matches `ORGANIZATION_ROLES`). */
  key: string;
  /** Product label — `builder` surfaces as "Developer" per tenancy-and-rbac. */
  label: string;
  /** One-line description of the role's authority. */
  summary: string;
}

export interface CapabilityArea {
  key: string;
  label: string;
}

/** The organization roles, most-privileged first, with product labels. */
export const ROLE_CATALOG: readonly RoleDef[] = [
  { key: "owner", label: "Owner", summary: "Full control, including billing, destructive actions, and role management." },
  { key: "admin", label: "Admin", summary: "Manage settings, people, projects, and integrations — everything except billing." },
  { key: "builder", label: "Developer", summary: "Create and change projects, environments, config, API keys, and webhooks." },
  { key: "viewer", label: "Viewer", summary: "Read-only access to the workspace." },
  { key: "billing_admin", label: "Billing admin", summary: "Manage the plan and invoices, without operational admin rights." },
];

/** Capability areas — the matrix rows. */
export const CAPABILITY_AREAS: readonly CapabilityArea[] = [
  { key: "read", label: "View workspace" },
  { key: "members", label: "Members & invitations" },
  { key: "roles", label: "Assign roles" },
  { key: "projects", label: "Projects & environments" },
  { key: "config", label: "Config & secrets" },
  { key: "keys", label: "API keys" },
  { key: "integrations", label: "Webhooks & integrations" },
  { key: "audit", label: "Audit & events" },
  { key: "billing", label: "Billing & plan" },
];

const F: RoleLevel = "full";
const N: RoleLevel = "none";

/**
 * role → capability-area → level. Derived from the role semantics in
 * tenancy-and-rbac.md. Kept as a capability-area summary (not the raw ~40-action
 * list) so it stays legible and low-drift.
 */
export const ROLE_MATRIX: Record<string, Record<string, RoleLevel>> = {
  owner: { read: F, members: F, roles: F, projects: F, config: F, keys: F, integrations: F, audit: F, billing: F },
  admin: { read: F, members: F, roles: F, projects: F, config: F, keys: F, integrations: F, audit: F, billing: N },
  builder: { read: F, members: N, roles: N, projects: F, config: F, keys: F, integrations: F, audit: N, billing: N },
  viewer: { read: F, members: N, roles: N, projects: N, config: N, keys: N, integrations: N, audit: N, billing: N },
  billing_admin: { read: F, members: N, roles: N, projects: N, config: N, keys: N, integrations: N, audit: N, billing: F },
};

/** The level a role has in a capability area (defaults to `none`). */
export function roleLevel(roleKey: string, areaKey: string): RoleLevel {
  return ROLE_MATRIX[roleKey]?.[areaKey] ?? "none";
}

// Guard: every catalog role is a real organization role, so the matrix can
// never drift into a phantom role. (Referenced by the roles unit test.)
export const ROLE_KEYS_MATCH_CONTRACT = ROLE_CATALOG.every((r) =>
  (ORGANIZATION_ROLES as readonly string[]).includes(r.key),
);
