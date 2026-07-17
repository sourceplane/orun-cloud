import type { OrganizationRole, ProjectRole, AccountRole, TenancyRole, RoleScopeKind } from "./tenancy.js";

export type SubjectType = "user" | "service_principal" | "workflow" | "system";

export interface PolicySubject {
  type: SubjectType;
  id: string;
}

export interface PolicyResource {
  kind: string;
  id?: string;
  orgId: string;
  projectId?: string;
  environmentId?: string;
}

/**
 * Where a membership fact reached the actor (saas-teams TM6). Assembled by the
 * membership-worker's authorization-context builder; **ignored by the policy
 * engine** (it decides on `role`/`scope` only). Purely for legibility —
 * effective-access / provenance surfaces render it so union-over-teams + account
 * cascade stay explainable.
 */
export interface FactOrigin {
  kind: "direct" | "team" | "account_cascade";
  /** The granting team's public id (`team_<hex>`) when `kind === "team"`. */
  teamId?: string;
}

export interface MembershipFact {
  kind: "role_assignment";
  role: TenancyRole;
  scope: {
    kind: RoleScopeKind;
    orgId: string;
    projectId?: string;
  };
  /** Provenance (saas-teams TM6). Optional + engine-ignored; additive. */
  grantedVia?: FactOrigin;
}

export type PolicyMembershipFact = MembershipFact | Record<string, unknown>;

export interface PolicyContext {
  memberships: PolicyMembershipFact[];
  attributes?: Record<string, unknown>;
}

export interface AuthorizationRequest {
  subject: PolicySubject;
  action: string;
  resource: PolicyResource;
  context: PolicyContext;
}

export interface AuthorizationResponse {
  allow: boolean;
  reason: string;
  policyVersion: number;
  derivedScope: {
    orgId: string;
    projectId?: string;
  };
  /**
   * Provenance of the fact that permitted the action (saas-teams TM6b) — the
   * `grantedVia` of the winning fact. Present only when `allow` is true and the
   * permitting fact carried provenance. Undefined for denials or facts without
   * a `grantedVia`. Does not affect the decision — reporting only.
   */
  via?: FactOrigin;
}

export interface EffectivePermissionsRequest {
  subject: PolicySubject;
  resource: PolicyResource;
  context: PolicyContext;
}

export interface EffectivePermission {
  action: string;
  allow: boolean;
  reason: string;
  /** Provenance of the permitting fact (saas-teams TM6b); set only when allowed. */
  via?: FactOrigin;
}

export interface EffectivePermissionsResponse {
  permissions: EffectivePermission[];
  policyVersion: number;
  derivedScope: {
    orgId: string;
    projectId?: string;
  };
}

/**
 * "Who can do what here, and via which grant" (saas-teams TM6b). The actor's
 * effective permissions on a target org/project, each carrying `via` provenance
 * (direct / team / account cascade) for the allowed ones. Assembled by
 * membership-worker (facts + engine); surfaced by api-edge/SDK/CLI/console.
 */
export interface EffectiveAccessResponse {
  permissions: EffectivePermission[];
}

export interface RoleAssignmentValidationRequest {
  role: string;
  scope: {
    kind: string;
    orgId: string;
    projectId?: string;
  };
}

export interface RoleAssignmentValidationResponse {
  valid: boolean;
  reason: string;
  policyVersion: number;
}

export const ORGANIZATION_ACTIONS = [
  "organization.read",
  "organization.settings.update",
  "organization.invitation.create",
  "organization.invitation.list",
  "organization.invitation.revoke",
  "organization.member.list",
  "organization.member.remove",
  "organization.member.update_role",
  "organization.service_principal.binding.create",
  "organization.service_principal.binding.list",
  "organization.service_principal.binding.revoke",
  "organization.api_key.create",
  "organization.api_key.list",
  "organization.api_key.revoke",
  "project.create",
  "project.list",
  "project.read",
  "project.update",
  "project.delete",
  "environment.create",
  "environment.read",
  "environment.update",
  "environment.delete",
  "audit.read",
  "billing.read",
  "billing.manage",
  "organization.config.read",
  "organization.config.write",
  "organization.webhook.read",
  "organization.webhook.write",
  "project.config.read",
  "project.config.write",
  "project.webhook.read",
  "project.webhook.write",
  // saas-agents — the hosted-agent control plane (workspace-scoped). Providers
  // and autonomy are admin-shaped (billing-impacting compute accounts / the
  // dispatch policy dial); sessions and profiles are day-to-day work.
  "organization.agent.provider.read",
  "organization.agent.provider.write",
  "organization.agent.session.read",
  "organization.agent.session.create",
  // Steer / answer approvals on a live session (saas-agents-live AL6). Distinct
  // from read: watching a session and driving it are different grants, and
  // approval authority is the sharpest permission in the agents plane.
  "organization.agent.session.interact",
  // Converse with the Workspace Agent (saas-agents-native AN4). Deny-by-
  // default like everything else; distinct from session grants — the chat
  // brain reads the workspace and routes to gated doors, it never executes.
  "organization.agent.chat",
  "organization.agent.profile.read",
  "organization.agent.profile.write",
  "organization.agent.autonomy.read",
  "organization.agent.autonomy.write",
  // saas-agents-fleet — the workforce plane (workspace-scoped). Delegation
  // (an agent-session principal spawns children), standing routines (ops —
  // day-to-day), and budget ceilings (governance — owner/admin write).
  "organization.agent.session.spawn",
  "organization.agent.routine.read",
  "organization.agent.routine.write",
  "organization.agent.budget.read",
  "organization.agent.budget.write",
] as const;

export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];

export const POLICY_VERSION = 1;

export interface AuthorizationContextRequest {
  subject: PolicySubject;
  orgId: string;
}

export interface AuthorizationContextResponse {
  memberships: MembershipFact[];
}

export type { OrganizationRole, ProjectRole, AccountRole, TenancyRole, RoleScopeKind };
