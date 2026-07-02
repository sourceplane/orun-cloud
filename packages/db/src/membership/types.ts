import type { Uuid } from "../ids/index.js";

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";

export type MembershipRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "already_accepted" }
  | { kind: "removed" }
  | { kind: "internal"; message: string };

export type MembershipResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MembershipRepositoryError };

export interface Organization {
  id: string;
  name: string;
  slug: string;
  slugLower: string;
  /**
   * Immutable public Workspace ID (epic `saas-workspace-id`, WID2) of the form
   * `ws_<8 Crockford-base32>` (e.g. `ws_3KF9TQ2P`). Minted once at creation and
   * never reissued — safe to commit/quote forever, unlike the mutable `slug`.
   */
  publicRef: string;
  status: string;
  /**
   * Optional billing parent (epic `saas-multi-org-billing`, MO1). When set, this
   * organization rolls its billing up to the referenced (default/parent) org;
   * NULL means standalone (bills for itself) — the case for every existing org.
   * Resolve with `effectiveBillingOrgId`.
   */
  parentOrgId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMember {
  id: string;
  orgId: string;
  subjectId: string;
  subjectType: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** An organization plus the resolved org-level role for a given subject (OP1). */
export interface OrganizationWithRole extends Organization {
  role: string;
}

export interface OrganizationInvitation {
  id: string;
  orgId: string;
  email: string;
  emailLower: string;
  role: string;
  status: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * A pending invitation for a given email, joined with the inviting
 * organization's display fields (saas invitation login flow). Only pending,
 * non-revoked, non-accepted, non-expired invitations are returned by
 * `listPendingInvitationsByEmail`, so the signed-in recipient sees exactly the
 * invitations they can still act on.
 */
export interface PendingInvitationForEmail {
  invitation: OrganizationInvitation;
  org: {
    id: string;
    name: string;
    slug: string;
    publicRef: string;
    status: string;
  };
}

export interface RoleAssignment {
  id: string;
  orgId: string;
  subjectId: string;
  subjectType: string;
  role: string;
  scopeKind: string;
  scopeRef: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/**
 * An account-owned Team (saas-teams TM1): a named principal-group a role can be
 * granted to. `id` is the internal UUID; the public id is `team_<hex>` (the UUID
 * rendered via `teamPublicId`, decodable back with `parseTeamPublicId`) — grants
 * bind to the public id, never the slug.
 */
export interface Team {
  id: string;
  accountOrgId: string;
  name: string;
  slugLower: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A team membership fact (saas-teams TM1): a subject in a team. */
export interface TeamMember {
  teamId: string;
  subjectId: string;
  subjectType: string;
  status: string;
  createdAt: Date;
}

export interface CreateTeamInput {
  id: string;
  accountOrgId: Uuid;
  name: string;
  slugLower: string;
  createdAt: Date;
}

export interface UpdateTeamInput {
  name?: string;
  slugLower?: string;
  updatedAt: Date;
}

export interface CreateTeamMemberInput {
  teamId: Uuid;
  subjectId: string;
  subjectType: string;
  createdAt: Date;
}

export interface CreateOrganizationInput {
  id: string;
  name: string;
  slug: string;
  slugLower: string;
  /**
   * Immutable public Workspace ID (`ws_…`, WID2), minted by the caller via
   * `generateWorkspaceRef()`. The DB column has a default backstop, but the app
   * always supplies it so the value is known at creation time.
   */
  publicRef: string;
  /** Optional billing parent (MO3). NULL/absent = standalone org. */
  parentOrgId?: string | null;
  createdAt: Date;
}

export interface CreateOrganizationMemberInput {
  id: string;
  orgId: Uuid;
  subjectId: string;
  subjectType: string;
  createdAt: Date;
}

export interface CreateInvitationInput {
  id: string;
  orgId: Uuid;
  email: string;
  emailLower: string;
  role: string;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateRoleAssignmentInput {
  id: string;
  orgId: Uuid;
  subjectId: string;
  subjectType: string;
  role: string;
  scopeKind: string;
  scopeRef?: string | null;
  createdAt: Date;
}

export interface BootstrapOrganizationInput {
  org: CreateOrganizationInput;
  member: CreateOrganizationMemberInput;
  roleAssignment: CreateRoleAssignmentInput;
}

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

export interface AcceptInvitationInput {
  tokenHash: string;
  orgId: Uuid;
  emailLower: string;
  memberId: string;
  roleAssignmentId: string;
  subjectId: string;
  subjectType: string;
  acceptedAt: Date;
}

/**
 * Accept an invitation by its id, authorizing on the signed-in actor's verified
 * email instead of a one-time token (saas invitation login flow). The email of
 * the authenticated (magic-link) session must equal invitation.email_lower —
 * equivalent proof of email control to the token path, which is why no token is
 * required here. `orgId` is derived from the invitation row, not supplied.
 */
export interface AcceptInvitationByIdInput {
  invitationId: string;
  emailLower: string;
  memberId: string;
  roleAssignmentId: string;
  subjectId: string;
  subjectType: string;
  acceptedAt: Date;
}

export interface MembershipRepository {
  createOrganization(input: CreateOrganizationInput): Promise<MembershipResult<Organization>>;
  getOrganizationById(id: string): Promise<MembershipResult<Organization>>;
  /**
   * Batched lookup of organizations by id, returning just `{ id, publicRef }`
   * for each found row (missing ids are simply absent). Used to resolve the
   * parent (account) `public_ref` for a page of orgs in one query, avoiding the
   * per-row N+1 of `getOrganizationById` when projecting `accountId` (WID4).
   */
  getOrganizationsByIds(ids: string[]): Promise<MembershipResult<Array<{ id: string; publicRef: string }>>>;
  getOrganizationBySlug(slugLower: string): Promise<MembershipResult<Organization>>;
  /**
   * Look up an org by its immutable public Workspace ID (`ws_…`, WID2) stored in
   * the `public_ref` column. Backs the api-edge org-ref resolver (WID3), which
   * rewrites a `ws_`/slug path segment to the canonical `org_<hex>` at the edge.
   */
  getOrganizationByPublicRef(publicRef: string): Promise<MembershipResult<Organization>>;
  /** Child orgs whose billing parent is `parentOrgId` (MO3), oldest first. */
  listChildOrganizations(parentOrgId: string): Promise<MembershipResult<Organization[]>>;
  /** Set an org's lifecycle status (e.g. freeze a child to 'suspended', MO3). */
  setOrganizationStatus(orgId: string, status: string, updatedAt: Date): Promise<MembershipResult<Organization>>;
  listOrganizationsForSubject(subjectId: string): Promise<MembershipResult<Organization[]>>;
  listOrganizationsForSubjectPaged(subjectId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<Organization>>>;
  /**
   * Orgs a subject belongs to, joined with their highest org-level role. Backs
   * the CLI session payload's `orgs:[{id,slug,name,role}]` (OP1) in one query
   * instead of an N+1 over `listRoleAssignments`. Members with no org-scoped
   * role assignment fall back to 'viewer'.
   */
  listOrganizationsWithRoleForSubject(subjectId: string): Promise<MembershipResult<OrganizationWithRole[]>>;

  bootstrapOrganization(input: BootstrapOrganizationInput): Promise<MembershipResult<{ org: Organization; member: OrganizationMember; roleAssignment: RoleAssignment }>>;

  createMember(input: CreateOrganizationMemberInput): Promise<MembershipResult<OrganizationMember>>;
  getMemberById(orgId: Uuid, memberId: string): Promise<MembershipResult<OrganizationMember>>;
  listMembers(orgId: Uuid): Promise<MembershipResult<OrganizationMember[]>>;
  listMembersPaged(orgId: Uuid, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationMember>>>;
  removeMember(orgId: Uuid, memberId: string, updatedAt: Date): Promise<MembershipResult<OrganizationMember>>;

  createInvitation(input: CreateInvitationInput): Promise<MembershipResult<OrganizationInvitation>>;
  getInvitationById(orgId: Uuid, invitationId: string): Promise<MembershipResult<OrganizationInvitation>>;
  getInvitationByTokenHash(tokenHash: string): Promise<MembershipResult<OrganizationInvitation>>;
  listInvitations(orgId: Uuid): Promise<MembershipResult<OrganizationInvitation[]>>;
  listInvitationsPaged(orgId: Uuid, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationInvitation>>>;
  /**
   * Every pending, still-actionable invitation for a normalized email, joined
   * with the inviting org's display fields. Powers the /v1/me/invitations
   * discovery path so a signed-in user finds invitations sent to their address
   * across all organizations. Newest first.
   */
  listPendingInvitationsByEmail(emailLower: string): Promise<MembershipResult<PendingInvitationForEmail[]>>;
  revokeInvitation(orgId: Uuid, invitationId: string, revokedAt: Date): Promise<MembershipResult<OrganizationInvitation>>;
  acceptInvitation(input: AcceptInvitationInput): Promise<MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>>;
  /**
   * Accept an invitation by id, matched on the actor's verified email (no
   * token). Same member + role-assignment writes as `acceptInvitation`.
   */
  acceptInvitationById(input: AcceptInvitationByIdInput): Promise<MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>>;

  // ── Teams (saas-teams TM1) ──────────────────────────────────────
  /** Create an account-owned team. Conflicts on (account_org_id, slug_lower). */
  createTeam(input: CreateTeamInput): Promise<MembershipResult<Team>>;
  getTeamById(id: string): Promise<MembershipResult<Team>>;
  /** Look up a team by its slug within an account (case-insensitive). */
  getTeamBySlug(accountOrgId: Uuid, slugLower: string): Promise<MembershipResult<Team>>;
  /** All active teams owned by an account, oldest first. */
  listTeams(accountOrgId: Uuid): Promise<MembershipResult<Team[]>>;
  updateTeam(id: string, input: UpdateTeamInput): Promise<MembershipResult<Team>>;
  /** Soft-delete a team (status='deleted'); frees its slug for reuse. */
  deleteTeam(id: string, updatedAt: Date): Promise<MembershipResult<Team>>;

  addTeamMember(input: CreateTeamMemberInput): Promise<MembershipResult<TeamMember>>;
  removeTeamMember(teamId: Uuid, subjectId: string): Promise<MembershipResult<TeamMember>>;
  listTeamMembers(teamId: Uuid): Promise<MembershipResult<TeamMember[]>>;
  /** Active teams (within an account) a subject is an active member of. */
  listTeamsForSubject(accountOrgId: Uuid, subjectId: string): Promise<MembershipResult<Team[]>>;

  // ── Team grants (saas-teams TM2) ────────────────────────────────
  /**
   * Revoke a single team grant identified by its full tuple (org + team public
   * id + role + scope). The partial-unique index makes at most one active row
   * match. Returns not_found when no active grant matches.
   */
  revokeTeamGrant(
    orgId: Uuid,
    teamPublicId: string,
    role: string,
    scopeKind: string,
    scopeRef: string | null,
    revokedAt: Date,
  ): Promise<MembershipResult<RoleAssignment>>;
  /**
   * Cascade-revoke every active grant for a team across ALL orgs (delete-cascade,
   * TM2). Team public ids are globally unique, so filtering by subject_id +
   * subject_type='team' is exact. Returns the revoked assignments.
   */
  revokeAllTeamGrants(teamPublicId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment[]>>;
  /**
   * All ACTIVE grants held by a team across every org (teams-hub TH3a) —
   * "what can this team do, and where". Same exact subject filter as the
   * cascade revoke; oldest first.
   */
  listTeamGrants(teamPublicId: string): Promise<MembershipResult<RoleAssignment[]>>;

  createRoleAssignment(input: CreateRoleAssignmentInput): Promise<MembershipResult<RoleAssignment>>;
  listRoleAssignments(orgId: Uuid, subjectId: string): Promise<MembershipResult<RoleAssignment[]>>;

  // ── Account roles (teams-hub TH1a — closes WID6's deferred list/revoke) ──
  /**
   * All ACTIVE account-scoped role assignments on an account org — every
   * subject type (users and teams), oldest first. Backs the Account Hub
   * "Roles" roster: "who holds account-wide authority here".
   */
  listAccountRoleAssignments(accountOrgId: Uuid): Promise<MembershipResult<RoleAssignment[]>>;
  /**
   * Revoke a USER's active account-scoped role, identified by (subject, role).
   * Team account grants are revoked through `revokeTeamGrant` (the /team-roles
   * surface) — this method deliberately matches `subject_type='user'` only.
   * Returns not_found when no active row matches.
   */
  revokeAccountRole(accountOrgId: Uuid, subjectId: string, role: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment>>;
  /**
   * Batched reverse lookup: all active role assignments for a set of subjects in
   * one query, returned as a `subjectId -> RoleAssignment[]` map (every queried
   * subject is present, possibly empty). Avoids the per-member N+1 in member
   * listing (PERF3 / task 0132). Optional so callers/fakes degrade gracefully to
   * per-subject `listRoleAssignments`; the live repository always implements it.
   */
  listRoleAssignmentsForSubjects?(orgId: Uuid, subjectIds: string[]): Promise<MembershipResult<Map<string, RoleAssignment[]>>>;
  revokeRoleAssignment(orgId: Uuid, assignmentId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment>>;
  revokeAllRoleAssignments(orgId: Uuid, subjectId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment[]>>;
  countActiveOwners(orgId: Uuid): Promise<MembershipResult<number>>;

  /**
   * Counts billable members for an organization for the purposes of the
   * `limit.members` billing entitlement. The count includes:
   *   - active organization members (membership.organization_members.status = 'active'); and
   *   - pending invitations whose `expires_at > now` and that have neither
   *     been accepted nor revoked.
   *
   * Accepted invitations are not counted here because accepting an invitation
   * already inserts an `organization_members` row and the active member is
   * counted via the first clause; counting the accepted invitation again
   * would double-count.
   *
   * Revoked invitations and expired pending invitations are excluded so
   * that revoking or letting an invite expire frees a seat back up.
   *
   * The helper performs the count in a single parameterized SQL statement
   * to avoid paging entire tables for billing decisions.
   */
  countBillableMembers(orgId: Uuid, now: Date): Promise<MembershipResult<number>>;
}
