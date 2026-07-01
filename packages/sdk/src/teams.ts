import type {
  CreateTeamRequest,
  CreateTeamResponse,
  GetTeamResponse,
  ListTeamsResponse,
  UpdateTeamRequest,
  AddTeamMemberRequest,
  AddTeamMemberResponse,
  ListTeamMembersResponse,
  GrantTeamRoleRequest,
  GrantTeamRoleResponse,
} from "@saas/contracts/membership";

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

  /** DELETE /v1/organizations/:orgId/team-roles — revoke a team grant (tuple in body). */
  revokeTeamRole(orgId: string, body: GrantTeamRoleRequest, opts: RequestOptions = {}): Promise<GrantTeamRoleResponse> {
    return this.transport.request<GrantTeamRoleResponse>(
      { method: "DELETE", path: `/v1/organizations/${encodeURIComponent(orgId)}/team-roles`, body },
      opts,
    );
  }
}
