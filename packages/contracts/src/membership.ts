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
  /**
   * Account-unique, case-insensitive, mentionable handle (teams-foundation TF1),
   * e.g. `payments` → `@payments`. Added additively; `null` for TM-era teams that
   * predate the profile columns. Grants bind to `id`, never this mutable handle.
   */
  handle?: string | null;
  /** Free-text profile blurb (teams-foundation TF1); `null` when unset. */
  description?: string | null;
  /** Opaque avatar reference (teams-foundation TF1); `null` → initials+colour. */
  avatar?: string | null;
  status: string;
  createdAt: string;
}

export interface PublicTeamMember {
  subjectId: string;
  subjectType: string;
  /**
   * Team-management role (teams-foundation TF2): `team_admin` or `team_member`.
   * Added additively; TM-era members read back as `team_member`.
   */
  teamRole?: string;
  status: string;
  createdAt: string;
}

export interface CreateTeamRequest {
  name: string;
  slug?: string;
  /** Optional account-unique handle (teams-foundation TF1). */
  handle?: string;
  /** Optional profile blurb (teams-foundation TF1). */
  description?: string;
  /** Optional opaque avatar reference (teams-foundation TF1). */
  avatar?: string;
}

export interface UpdateTeamRequest {
  name?: string;
  slug?: string;
  /** Rename the handle (teams-foundation TF1); omit to leave unchanged. */
  handle?: string;
  description?: string;
  avatar?: string;
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
  /** "team_admin" | "team_member" — defaults to "team_member" (teams-foundation TF2). */
  teamRole?: string;
}

export interface AddTeamMemberResponse {
  member: PublicTeamMember;
}

/** Change a member's team-management role (teams-foundation TF2). */
export interface UpdateTeamMemberRoleRequest {
  /** "team_admin" | "team_member". */
  teamRole: string;
}

export interface UpdateTeamMemberRoleResponse {
  member: PublicTeamMember;
}

export interface ListTeamMembersResponse {
  members: PublicTeamMember[];
}

// ── Owner-handle map (teams-ownership TO1) ──────────────────────────
/**
 * An account-authored owner-handle → team alias: resolves a git-authored catalog
 * `owner:` string to a team entity. Org metadata, never catalog content.
 */
export interface PublicOwnerHandle {
  ownerHandle: string;
  /** The `team_<hex>` id the handle resolves to. */
  teamId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListOwnerHandlesResponse {
  ownerHandles: PublicOwnerHandle[];
}

export interface SetOwnerHandleRequest {
  ownerHandle: string;
  teamId: string;
}

export interface SetOwnerHandleResponse {
  ownerHandle: PublicOwnerHandle;
}

/** Grant a team a role at account | organization (workspace) | project scope. */
export interface GrantTeamRoleRequest {
  teamId: string;
  role: string;
  scopeKind: "account" | "organization" | "project";
  /** Required when scopeKind is "project" — the project id. */
  scopeRef?: string;
}

/** One active grant a team holds (teams-hub TH3a), with its target org. */
export interface TeamGrant {
  role: string;
  scopeKind: string;
  scopeRef: string | null;
  orgId: string;
  createdAt: string;
}

/** GET …/teams/{teamId}/grants */
export interface ListTeamGrantsResponse {
  grants: TeamGrant[];
}

export interface GrantTeamRoleResponse {
  grant: {
    teamId: string;
    role: string;
    scopeKind: string;
    scopeRef: string | null;
  };
}

// ── Account Hub (teams-hub TH1) ─────────────────────────────────────
/**
 * One active account-scoped role assignment on the account org. Subjects may
 * be users (WID6 grants) or teams (TM2 account-scope grants), labeled by
 * `subjectType` so the hub Roles surface renders both honestly.
 */
export interface AccountRoleAssignment {
  subjectId: string;
  subjectType: string;
  role: string;
  createdAt: string;
}

/** GET /v1/organizations/{orgId}/account-roles */
export interface ListAccountRolesResponse {
  assignments: AccountRoleAssignment[];
}

/** POST /v1/organizations/{orgId}/account-roles (WID6 grant). */
export interface GrantAccountRoleRequest {
  subjectId: string;
  role: string;
}

export interface GrantAccountRoleResponse {
  assignment: {
    subjectId: string;
    role: string;
    scopeKind: string;
  };
}

/** DELETE /v1/organizations/{orgId}/account-roles — tuple in the body. */
export interface RevokeAccountRoleRequest {
  subjectId: string;
  role: string;
}

export interface RevokeAccountRoleResponse {
  assignment: {
    subjectId: string;
    role: string;
    scopeKind: string;
    revoked: boolean;
  };
}

/**
 * How a subject reaches the derived account roster (TH1b, no account_members
 * table): an active member of the account root org, a holder of an
 * account-scoped role, or both.
 */
export type AccountMemberOrigin = "member" | "account_role" | "both";

export interface AccountMemberRow {
  subjectId: string;
  subjectType: string;
  origin: AccountMemberOrigin;
  /** Present when the subject is an org member (origin member | both). */
  status?: string;
  joinedAt?: string;
  /** Account roles held (empty for plain members). */
  accountRoles: string[];
}

/** GET /v1/organizations/{orgId}/account-members */
export interface ListAccountMembersResponse {
  members: AccountMemberRow[];
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

/**
 * A pending invitation surfaced to its recipient after they sign in (saas
 * invitation login flow), carrying the inviting organization's display fields
 * so the console can name each workspace. Only still-actionable invitations
 * (pending, not revoked/accepted/expired) are returned by GET /v1/me/invitations.
 */
export interface PublicPendingInvitation {
  id: string;
  org: {
    id: string;
    name: string;
    slug: string;
    workspaceRef: string;
    status: string;
  };
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

/** GET /v1/me/invitations — the signed-in user's pending invitations. */
export interface ListMyInvitationsResponse {
  invitations: PublicPendingInvitation[];
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
