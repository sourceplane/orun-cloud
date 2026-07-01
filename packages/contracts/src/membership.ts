export interface PublicOrganization {
  /**
   * Legacy primary key of the form `org_<hex>` (epic `saas-workspaces`, D2/D4).
   * Retained indefinitely as the back-compat Workspace ID. The durable, led-with
   * public id is `workspaceRef` (`ws_…`); `id`'s value is unchanged (W2 Option B).
   */
  id: string;
  name: string;
  slug: string;
  /**
   * Immutable, led-with public **Workspace ID** of the form `ws_…` (epic
   * `saas-workspace-id`, WID2's `public_ref`). Safe to commit/quote/automate —
   * unlike the mutable `slug` and the legacy `id`. Added additively (W2 Option B):
   * it does not change `id`'s value, which stays the legacy `org_<hex>` key.
   */
  workspaceRef?: string;
  /**
   * The owning **Account's** public Workspace ID (`ws_…`) — the AWS-account-id
   * analog every Workspace carries. For an Account root it equals this org's own
   * `workspaceRef`; for a child it is the parent (account) org's `workspaceRef`.
   * Invariant: `accountId === workspaceRef` ⟺ this org is an Account root.
   * Derived from `effectiveBillingOrgId` (= `parentOrgId ?? id`).
   */
  accountId?: string;
  /**
   * Derived role of this org in the Account/Workspace graph. `account` when the
   * org is a parent/standalone (`parentOrgId` is null), otherwise `workspace`.
   * Per the model a parent is BOTH, but the DTO reports the root as `account`.
   * Never encoded in or parsed from an id — role lives in the graph (WID4 W1d).
   */
  kind?: "account" | "workspace";
  /** True when this org is an Account root (`parentOrgId` is null). */
  isAccountRoot?: boolean;
  /**
   * Lifecycle status (e.g. 'active', 'suspended'). Optional — populated by the
   * organization list so the console can surface a frozen-child warning (MO3);
   * other endpoints may omit it.
   */
  status?: string;
  createdAt: string;
}

export interface CreateOrganizationRequest {
  name: string;
  slug?: string;
}

export interface CreateOrganizationResponse {
  organization: PublicOrganization;
  membership: {
    role: string;
    joinedAt: string;
  };
}

export interface ListOrganizationsResponse {
  organizations: PublicOrganization[];
}

/** A child workspace under an Account (saas-integration-tenancy IT12). */
export interface PublicWorkspaceSummary {
  /** Legacy public org id (`org_…`). */
  orgId: string;
  /** Led-with Workspace ID (`ws_…`, WID2). */
  workspaceRef: string;
  name: string;
}

/** GET /v1/organizations/{accountId}/workspaces */
export interface ListAccountWorkspacesResponse {
  workspaces: PublicWorkspaceSummary[];
}

export interface GetOrganizationResponse {
  organization: PublicOrganization;
}

export interface PublicMemberRoleAssignment {
  role: string;
  scopeKind: string;
}

export interface PublicMember {
  id: string;
  subjectType: string;
  subjectId: string;
  status: string;
  joinedAt: string;
  roles: PublicMemberRoleAssignment[];
}

export interface ListMembersResponse {
  members: PublicMember[];
}

// ── Teams (saas-teams TM4c) ─────────────────────────────────────────
/** Public shape of an account-owned Team. `id` is the `team_<hex>` public id. */
export interface PublicTeam {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

export interface PublicTeamMember {
  subjectId: string;
  subjectType: string;
  status: string;
  createdAt: string;
}

export interface CreateTeamRequest {
  name: string;
  slug?: string;
}

export interface UpdateTeamRequest {
  name?: string;
  slug?: string;
}

export interface CreateTeamResponse {
  team: PublicTeam;
}

export interface GetTeamResponse {
  team: PublicTeam;
}

export interface ListTeamsResponse {
  teams: PublicTeam[];
}

export interface AddTeamMemberRequest {
  subjectId: string;
  /** "user" | "service_principal" — defaults to "user". */
  subjectType?: string;
}

export interface AddTeamMemberResponse {
  member: PublicTeamMember;
}

export interface ListTeamMembersResponse {
  members: PublicTeamMember[];
}

/** Grant a team a role at account | organization (workspace) | project scope. */
export interface GrantTeamRoleRequest {
  teamId: string;
  role: string;
  scopeKind: "account" | "organization" | "project";
  /** Required when scopeKind is "project" — the project id. */
  scopeRef?: string;
}

export interface GrantTeamRoleResponse {
  grant: {
    teamId: string;
    role: string;
    scopeKind: string;
    scopeRef: string | null;
  };
}

export const ORGANIZATION_ROLES = ["owner", "admin", "builder", "viewer", "billing_admin"] as const;
export type InvitationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Account-scoped roles (epic `saas-workspace-id`, WID6). Granted at
 * `scope_kind = 'account'` on an Account (parent org); cascade to authority on
 * every workspace under the account.
 */
export const ACCOUNT_ROLES = ["account_owner", "account_admin", "account_billing_admin"] as const;
export type AccountRoleName = (typeof ACCOUNT_ROLES)[number];

export interface CreateInvitationRequest {
  email: string;
  role: InvitationRole;
}

export interface PublicInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface CreateInvitationResponse {
  invitation: PublicInvitation;
  delivery?: { mode: string; token: string };
}

export interface ListInvitationsResponse {
  invitations: PublicInvitation[];
}

export interface RevokeInvitationResponse {
  invitation: PublicInvitation;
}

export interface UpdateMemberRoleRequest {
  role: string;
}

export interface UpdateMemberRoleResponse {
  member: PublicMember;
}

export interface RemoveMemberResponse {
  member: PublicMember;
}

export interface AcceptInvitationRequest {
  token: string;
}

export interface AcceptInvitationResponse {
  invitation: PublicInvitation;
  membership: {
    id: string;
    role: string;
    joinedAt: string;
    status: string;
  };
}
