// Tenancy contract types
// Every resource must be traceable to an organization.

export interface OrgScoped {
  orgId: string;
}

export interface ProjectScoped extends OrgScoped {
  projectId: string;
}

export interface TenantContext {
  orgId: string;
  projectId?: string;
  actorId: string;
  actorKind: "user" | "service_principal" | "workflow" | "system";
}

export type OrganizationRole =
  | "owner"
  | "admin"
  | "builder"
  | "viewer"
  | "billing_admin";

export type ProjectRole =
  | "project_admin"
  | "project_builder"
  | "project_viewer";

/**
 * Account-scoped roles (epic `saas-workspace-id`, WID6 — design §8.2). Granted
 * at `scope_kind = 'account'` on an Account (the parent org), they cascade to
 * authority on every workspace under that account without per-workspace rows.
 */
export type AccountRole =
  | "account_owner"
  | "account_admin"
  | "account_billing_admin";

export type TenancyRole = OrganizationRole | ProjectRole | AccountRole;

export type RoleScopeKind = "organization" | "project" | "account";

export interface RoleAssignmentFact {
  role: TenancyRole;
  scope: {
    kind: RoleScopeKind;
    orgId: string;
    projectId?: string;
  };
  subjectId: string;
  subjectType: "user" | "service_principal";
}
