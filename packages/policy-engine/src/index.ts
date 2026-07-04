import type {
  AuthorizationRequest,
  AuthorizationResponse,
  EffectivePermissionsRequest,
  EffectivePermissionsResponse,
  EffectivePermission,
  RoleAssignmentValidationRequest,
  RoleAssignmentValidationResponse,
  MembershipFact,
  OrganizationRole,
  ProjectRole,
  AccountRole,
} from "@saas/contracts/policy";

export { POLICY_VERSION } from "@saas/contracts/policy";
import { POLICY_VERSION } from "@saas/contracts/policy";

const ORG_ROLE_PERMISSIONS: Record<OrganizationRole, readonly string[]> = {
  owner: [
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
    "organization.metering.read",
    "organization.metering.write",
    "organization.integration.read",
    "organization.integration.connect",
    "organization.integration.manage",
    "organization.integration.token.issue",
    "project.repo_link.write",
    "state.run.read",
    "state.run.write",
    "state.object.read",
    "state.object.write",
    "catalog.read",
    "catalog.publish",
    "secret.read",
    "secret.write",
    "secret.value.use",
    "secret.reveal",
    "org.cli.link",
    "org.ci.trust.write",
    "team.create",
    "team.update",
    "team.delete",
    "team.member.add",
    "team.member.remove",
    "team.role.grant",
    "team.role.revoke",
    "team.owner_handle.set",
    "team.owner_handle.remove",
  ],
  admin: [
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
    "organization.config.read",
    "organization.config.write",
    "organization.webhook.read",
    "organization.webhook.write",
    "project.config.read",
    "project.config.write",
    "project.webhook.read",
    "project.webhook.write",
    "organization.metering.read",
    "organization.metering.write",
    "organization.integration.read",
    "organization.integration.connect",
    "organization.integration.manage",
    "organization.integration.token.issue",
    "project.repo_link.write",
    "state.run.read",
    "state.run.write",
    "state.object.read",
    "state.object.write",
    "catalog.read",
    "catalog.publish",
    "secret.read",
    "secret.write",
    "secret.value.use",
    "secret.reveal",
    "org.cli.link",
    "org.ci.trust.write",
    "team.create",
    "team.update",
    "team.delete",
    "team.member.add",
    "team.member.remove",
    "team.role.grant",
    "team.role.revoke",
    "team.owner_handle.set",
    "team.owner_handle.remove",
  ],
  builder: [
    "organization.read",
    "project.create",
    "project.list",
    "project.read",
    "project.update",
    "environment.create",
    "environment.read",
    "environment.update",
    "organization.config.read",
    "organization.webhook.read",
    "project.config.read",
    "project.webhook.read",
    "organization.metering.read",
    "organization.integration.read",
    "state.run.read",
    "state.run.write",
    "state.object.read",
    "state.object.write",
    "catalog.read",
    "catalog.publish",
    "secret.read",
    "secret.value.use",
    "org.cli.link",
  ],
  viewer: [
    "organization.read",
    "project.list",
    "project.read",
    "environment.read",
    "organization.config.read",
    "organization.webhook.read",
    "project.config.read",
    "project.webhook.read",
    "organization.metering.read",
    "organization.integration.read",
    "state.run.read",
    "state.object.read",
    "catalog.read",
    "secret.read",
  ],
  billing_admin: [
    "organization.read",
    "billing.read",
    "billing.manage",
  ],
};

// Account-scoped role permissions (saas-workspace-id WID6 — design §8.2).
// A role granted at scope_kind='account' on an Account cascades to authority on
// every workspace under that account. The cascade is assembled in
// membership-worker's authorization-context (account facts are remapped onto the
// target org id, so the engine's scope.orgId filter matches them); the engine
// only needs the permission catalog for the account roles. Each account role
// mirrors an existing org-role permission set:
//   * account_owner         = the full org `owner` set (account-wide incl. billing)
//   * account_admin         = the org `admin` set (no billing)
//   * account_billing_admin = the org `billing_admin` set (billing + org read)
const ACCOUNT_ROLE_PERMISSIONS: Record<AccountRole, readonly string[]> = {
  account_owner: ORG_ROLE_PERMISSIONS.owner,
  account_admin: ORG_ROLE_PERMISSIONS.admin,
  account_billing_admin: ORG_ROLE_PERMISSIONS.billing_admin,
};

const VALID_ACCOUNT_ROLES: ReadonlySet<string> = new Set([
  "account_owner",
  "account_admin",
  "account_billing_admin",
]);

function isAccountRole(role: string): role is AccountRole {
  return VALID_ACCOUNT_ROLES.has(role);
}

const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, readonly string[]> = {
  project_admin: [
    "project.repo_link.write",
    "project.read",
    "project.update",
    "project.delete",
    "environment.create",
    "environment.read",
    "environment.update",
    "environment.delete",
    "organization.api_key.create",
    "organization.api_key.list",
    "organization.api_key.revoke",
    "project.config.read",
    "project.config.write",
    "project.webhook.read",
    "project.webhook.write",
  ],
  project_builder: [
    "project.read",
    "project.update",
    "environment.create",
    "environment.read",
    "environment.update",
    "project.config.read",
    "project.webhook.read",
  ],
  project_viewer: [
    "project.read",
    "environment.read",
    "project.config.read",
    "project.webhook.read",
  ],
};

const VALID_ORG_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "builder",
  "viewer",
  "billing_admin",
]);

const VALID_PROJECT_ROLES: ReadonlySet<string> = new Set([
  "project_admin",
  "project_builder",
  "project_viewer",
]);

const PROJECT_SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  "project.repo_link.write",
  "project.read",
  "project.update",
  "project.delete",
  "environment.create",
  "environment.read",
  "environment.update",
  "environment.delete",
  "project.config.read",
  "project.config.write",
]);

// Actions that project roles can authorize when a projectId narrows the request.
// Unlike PROJECT_SCOPED_ACTIONS, these do NOT require projectId — they are org-level
// actions that project-admin can perform only when explicitly scoped to their project.
const PROJECT_GRANTABLE_ACTIONS: ReadonlySet<string> = new Set([
  "organization.api_key.create",
  "organization.api_key.list",
  "organization.api_key.revoke",
]);

const ALL_KNOWN_ACTIONS: ReadonlySet<string> = new Set([
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
  "organization.metering.read",
  "organization.metering.write",
  "organization.integration.read",
  "organization.integration.connect",
  "organization.integration.manage",
  "organization.integration.token.issue",
  "project.repo_link.write",
  // saas-orun-platform OP0 — state plane (deny-by-default; org-scoped like the
  // organization.integration.* actions). No live route consumes these yet.
  "state.run.read",
  "state.run.write",
  "state.object.read",
  "state.object.write",
  "catalog.read",
  "catalog.publish",
  "secret.read",
  "secret.write",
  "secret.value.use",
  // saas-secret-manager SM1 — elevated break-glass read (the reveal route
  // itself lands in SM6; only the action + owner/admin grants land here).
  // Org-scoped like the other secret.* actions: valid at org scope with an
  // optional projectId narrowing the resource.
  "secret.reveal",
  "org.cli.link",
  "org.ci.trust.write",
  // saas-teams TM4 — team management actions (owner/admin org roles +
  // account_owner/account_admin via the account-role catalog). Org-scoped:
  // teams are account-owned but managed on the account org / target org.
  "team.create",
  "team.update",
  "team.delete",
  "team.member.add",
  "team.member.remove",
  "team.role.grant",
  "team.role.revoke",
  // teams-ownership TO1 — manage the account-authored owner-handle → team map.
  "team.owner_handle.set",
  "team.owner_handle.remove",
]);

function isOrgRole(role: string): role is OrganizationRole {
  return VALID_ORG_ROLES.has(role);
}

function isProjectRole(role: string): role is ProjectRole {
  return VALID_PROJECT_ROLES.has(role);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function isRoleAssignmentFact(fact: unknown): fact is MembershipFact {
  if (!isRecord(fact)) return false;
  if (fact.kind !== "role_assignment" || typeof fact.role !== "string") return false;
  if (!isRecord(fact.scope)) return false;
  return typeof fact.scope.kind === "string" && typeof fact.scope.orgId === "string";
}

function buildScope(orgId: string, projectId?: string): { orgId: string; projectId?: string } {
  if (typeof projectId === "string" && projectId.length > 0) return { orgId, projectId };
  return { orgId };
}

function deny(reason: string, orgId: string, projectId?: string): AuthorizationResponse {
  return { allow: false, reason, policyVersion: POLICY_VERSION, derivedScope: buildScope(orgId, projectId) };
}

function allow(
  reason: string,
  orgId: string,
  projectId?: string,
  via?: MembershipFact["grantedVia"],
): AuthorizationResponse {
  return {
    allow: true,
    reason,
    policyVersion: POLICY_VERSION,
    derivedScope: buildScope(orgId, projectId),
    // Provenance of the permitting fact (saas-teams TM6b). Reporting only —
    // it never changes the decision (the fact was already selected above).
    ...(via ? { via } : {}),
  };
}

export function authorize(input: AuthorizationRequest): AuthorizationResponse {
  const { action, resource, context } = input;
  const orgId = resource.orgId;
  const projectId = typeof resource.projectId === "string" ? resource.projectId : undefined;

  if (!orgId) {
    return deny("invalid_scope", "");
  }

  if (!ALL_KNOWN_ACTIONS.has(action)) {
    return deny("unknown_action", orgId, projectId);
  }

  if (PROJECT_SCOPED_ACTIONS.has(action) && !projectId) {
    return deny("invalid_scope", orgId);
  }

  const relevantFacts = context.memberships.filter(isRoleAssignmentFact).filter(
    (f) => f.scope.orgId === orgId,
  );

  if (relevantFacts.length === 0) {
    return deny("no_matching_role", orgId, projectId);
  }

  for (const fact of relevantFacts) {
    if (fact.scope.kind === "organization" && isOrgRole(fact.role)) {
      const permissions = ORG_ROLE_PERMISSIONS[fact.role];
      if (permissions.includes(action)) {
        if (PROJECT_SCOPED_ACTIONS.has(action) && projectId) {
          return allow(`org_${fact.role}`, orgId, projectId, fact.grantedVia);
        }
        if (!PROJECT_SCOPED_ACTIONS.has(action) || !projectId) {
          return allow(`org_${fact.role}`, orgId, projectId, fact.grantedVia);
        }
      }
    }

    // Account-scoped facts (WID6): authority cascaded from the Account. By the
    // time the engine sees them, authorization-context assembly has already
    // remapped scope.orgId to the target org, so the scope.orgId filter above
    // matched. They confer org-level authority on the target, so they resolve
    // exactly like an organization fact does (incl. project-scoped actions when
    // a projectId narrows the request).
    if (fact.scope.kind === "account" && isAccountRole(fact.role)) {
      const permissions = ACCOUNT_ROLE_PERMISSIONS[fact.role];
      if (permissions.includes(action)) {
        if (PROJECT_SCOPED_ACTIONS.has(action) && projectId) {
          return allow(`account_${fact.role}`, orgId, projectId, fact.grantedVia);
        }
        if (!PROJECT_SCOPED_ACTIONS.has(action) || !projectId) {
          return allow(`account_${fact.role}`, orgId, projectId, fact.grantedVia);
        }
      }
    }

    if (
      fact.scope.kind === "project" &&
      isProjectRole(fact.role) &&
      (PROJECT_SCOPED_ACTIONS.has(action) || PROJECT_GRANTABLE_ACTIONS.has(action))
    ) {
      if (!projectId || fact.scope.projectId !== projectId) {
        continue;
      }
      const permissions = PROJECT_ROLE_PERMISSIONS[fact.role];
      if (permissions.includes(action)) {
        return allow(fact.role, orgId, projectId, fact.grantedVia);
      }
    }
  }

  return deny("no_matching_role", orgId, projectId);
}

export function listEffectivePermissions(
  input: EffectivePermissionsRequest,
): EffectivePermissionsResponse {
  const { resource, context } = input;
  const orgId = resource.orgId;
  const projectId = resource.projectId;

  const permissions: EffectivePermission[] = [];
  const seen = new Set<string>();

  for (const action of ALL_KNOWN_ACTIONS) {
    if (seen.has(action)) continue;

    const result = authorize({
      subject: input.subject,
      action,
      resource,
      context,
    });

    seen.add(action);
    permissions.push({
      action,
      allow: result.allow,
      reason: result.reason,
      // Provenance of the permitting fact (saas-teams TM6b), when allowed.
      ...(result.via ? { via: result.via } : {}),
    });
  }

  return {
    permissions,
    policyVersion: POLICY_VERSION,
    derivedScope: buildScope(orgId, projectId),
  };
}

export function validateRoleAssignment(
  input: RoleAssignmentValidationRequest,
): RoleAssignmentValidationResponse {
  const { role, scope } = input;

  if (typeof scope.orgId !== "string" || scope.orgId.length === 0) {
    return { valid: false, reason: "missing_org_id", policyVersion: POLICY_VERSION };
  }

  if (scope.kind === "organization") {
    if (!VALID_ORG_ROLES.has(role)) {
      return { valid: false, reason: "invalid_role_for_scope", policyVersion: POLICY_VERSION };
    }
    return { valid: true, reason: "valid_org_role", policyVersion: POLICY_VERSION };
  }

  if (scope.kind === "project") {
    if (typeof scope.projectId !== "string" || scope.projectId.length === 0) {
      return { valid: false, reason: "missing_project_id", policyVersion: POLICY_VERSION };
    }
    if (!VALID_PROJECT_ROLES.has(role)) {
      return { valid: false, reason: "invalid_role_for_scope", policyVersion: POLICY_VERSION };
    }
    return { valid: true, reason: "valid_project_role", policyVersion: POLICY_VERSION };
  }

  if (scope.kind === "account") {
    if (!VALID_ACCOUNT_ROLES.has(role)) {
      return { valid: false, reason: "invalid_role_for_scope", policyVersion: POLICY_VERSION };
    }
    return { valid: true, reason: "valid_account_role", policyVersion: POLICY_VERSION };
  }

  return { valid: false, reason: "unknown_scope_kind", policyVersion: POLICY_VERSION };
}
