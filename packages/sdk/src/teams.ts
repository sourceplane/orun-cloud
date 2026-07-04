import type {
  CreateTeamRequest,
  CreateTeamResponse,
  GetTeamResponse,
  ListTeamsResponse,
  UpdateTeamRequest,
  AddTeamMemberRequest,
  AddTeamMemberResponse,
  UpdateTeamMemberRoleRequest,
  UpdateTeamMemberRoleResponse,
  ListOwnerHandlesResponse,
  SetOwnerHandleRequest,
  SetOwnerHandleResponse,
  ListTeamMembersResponse,
  GrantTeamRoleRequest,
  GrantTeamRoleResponse,
  ListTeamGrantsResponse,
} from "@saas/contracts/membership";

import type { EffectiveAccessResponse } from "@saas/contracts/policy";
import type { RequestOptions, Transport } from "./transport.js";

/**
 * Teams resource client (saas-teams TM4c).
 *
 * Covers the account-owned Teams surface served by `apps/membership-worker`
 * through the org-facade: team lifecycle, membership, and role grants. Same
 * flat-method shape as {@link MembershipsClient}.
 */
export class TeamsClient {
  constructor(private readonly transport: Transport) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** GET /v1/organizations/:orgId/teams */
  listTeams(orgId: string, opts: RequestOptions = {}): Promise<ListTeamsResponse> {
    return this.transport.request<ListTeamsResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/teams */
  createTeam(orgId: string, body: CreateTeamRequest, opts: RequestOptions = {}): Promise<CreateTeamResponse> {
    return this.transport.request<CreateTeamResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/teams/:teamId */
  getTeam(orgId: string, teamId: string, opts: RequestOptions = {}): Promise<GetTeamResponse> {
    return this.transport.request<GetTeamResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}` },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/teams/:teamId */
  updateTeam(orgId: string, teamId: string, body: UpdateTeamRequest, opts: RequestOptions = {}): Promise<GetTeamResponse> {
    return this.transport.request<GetTeamResponse>(
      { method: "PATCH", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}`, body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/teams/:teamId */
  deleteTeam(orgId: string, teamId: string, opts: RequestOptions = {}): Promise<GetTeamResponse> {
    return this.transport.request<GetTeamResponse>(
      { method: "DELETE", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}` },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /** GET /v1/organizations/:orgId/teams/:teamId/members */
  listTeamMembers(orgId: string, teamId: string, opts: RequestOptions = {}): Promise<ListTeamMembersResponse> {
    return this.transport.request<ListTeamMembersResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/teams/:teamId/members */
  addTeamMember(orgId: string, teamId: string, body: AddTeamMemberRequest, opts: RequestOptions = {}): Promise<AddTeamMemberResponse> {
    return this.transport.request<AddTeamMemberResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members`, body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/teams/:teamId/members/:subjectId */
  removeTeamMember(orgId: string, teamId: string, subjectId: string, opts: RequestOptions = {}): Promise<AddTeamMemberResponse> {
    return this.transport.request<AddTeamMemberResponse>(
      { method: "DELETE", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(subjectId)}` },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/teams/:teamId/members/:subjectId (teams-foundation TF2) */
  updateTeamMemberRole(orgId: string, teamId: string, subjectId: string, body: UpdateTeamMemberRoleRequest, opts: RequestOptions = {}): Promise<UpdateTeamMemberRoleResponse> {
    return this.transport.request<UpdateTeamMemberRoleResponse>(
      { method: "PATCH", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(subjectId)}`, body },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Owner-handle map (teams-ownership TO1)
  // -------------------------------------------------------------------------

  /** GET /v1/organizations/:orgId/owner-handles — the account's owner→team aliases. */
  listOwnerHandles(orgId: string, opts: RequestOptions = {}): Promise<ListOwnerHandlesResponse> {
    return this.transport.request<ListOwnerHandlesResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/owner-handles` },
      opts,
    );
  }

  /** PUT /v1/organizations/:orgId/owner-handles — upsert an owner→team alias. */
  setOwnerHandle(orgId: string, body: SetOwnerHandleRequest, opts: RequestOptions = {}): Promise<SetOwnerHandleResponse> {
    return this.transport.request<SetOwnerHandleResponse>(
      { method: "PUT", path: `/v1/organizations/${encodeURIComponent(orgId)}/owner-handles`, body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/owner-handles/:ownerHandle — remove an alias. */
  deleteOwnerHandle(orgId: string, ownerHandle: string, opts: RequestOptions = {}): Promise<SetOwnerHandleResponse> {
    return this.transport.request<SetOwnerHandleResponse>(
      { method: "DELETE", path: `/v1/organizations/${encodeURIComponent(orgId)}/owner-handles/${encodeURIComponent(ownerHandle)}` },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Role grants
  // -------------------------------------------------------------------------

  /** POST /v1/organizations/:orgId/team-roles — grant a team a role at a scope. */
  grantTeamRole(orgId: string, body: GrantTeamRoleRequest, opts: RequestOptions = {}): Promise<GrantTeamRoleResponse> {
    return this.transport.request<GrantTeamRoleResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/team-roles`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/teams/:teamId/grants — the team's active grants across orgs. */
  listTeamGrants(orgId: string, teamId: string, opts: RequestOptions = {}): Promise<ListTeamGrantsResponse> {
    return this.transport.request<ListTeamGrantsResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/grants` },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/team-roles — revoke a team grant (tuple in body). */
  revokeTeamRole(orgId: string, body: GrantTeamRoleRequest, opts: RequestOptions = {}): Promise<GrantTeamRoleResponse> {
    return this.transport.request<GrantTeamRoleResponse>(
      { method: "DELETE", path: `/v1/organizations/${encodeURIComponent(orgId)}/team-roles`, body },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Effective access (saas-teams TM6b)
  // -------------------------------------------------------------------------

  /**
   * GET /v1/organizations/:orgId/effective-access — "who can do what here, and
   * via which grant". Defaults to the caller's own access; pass `subjectId` to
   * view another subject's (requires member-list authority), and `projectId` to
   * narrow to a project. Each permitted action carries `via` provenance.
   */
  effectiveAccess(
    orgId: string,
    query: { projectId?: string; subjectId?: string } = {},
    opts: RequestOptions = {},
  ): Promise<EffectiveAccessResponse> {
    return this.transport.request<EffectiveAccessResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/effective-access`,
        query: { ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.subjectId ? { subjectId: query.subjectId } : {}) },
      },
      opts,
    );
  }
}
