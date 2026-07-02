import type {
  ListAccountWorkspacesResponse,
  ListAccountMembersResponse,
  ListAccountRolesResponse,
  GrantAccountRoleRequest,
  GrantAccountRoleResponse,
  RevokeAccountRoleRequest,
  RevokeAccountRoleResponse,
} from "@saas/contracts/membership";
import type { AccountCatalogResponse, AccountRunsResponse } from "@saas/contracts/state";
import type { RequestOptions, Transport } from "./transport.js";

/** Filters forwarded verbatim to every per-workspace read of the fan-out. */
export interface AccountCatalogQuery {
  kind?: string;
  owner?: string;
  q?: string;
  environment?: string;
  limit?: number;
}

export interface AccountRunsQuery {
  status?: string;
  environment?: string;
  branch?: string;
  source?: string;
  limit?: number;
}

/**
 * Account resource client (teams-hub TH1c).
 *
 * The Account Hub read/manage surface served by `apps/membership-worker`
 * through the org-facade: the account's child workspaces (IT12), the derived
 * account-member roster (TH1b), and account-role grant/list/revoke (WID6 +
 * TH1a). Every method accepts the account org's id — or any child workspace's
 * id, which the worker resolves up to the owning account.
 */
export class AccountClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/workspaces — child workspaces under the account. */
  workspaces(orgId: string, opts: RequestOptions = {}): Promise<ListAccountWorkspacesResponse> {
    return this.transport.request<ListAccountWorkspacesResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/workspaces` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/account-members — the derived roster (origin-tagged). */
  members(orgId: string, opts: RequestOptions = {}): Promise<ListAccountMembersResponse> {
    return this.transport.request<ListAccountMembersResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/account-members` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/account-roles — active account-scope assignments. */
  roles(orgId: string, opts: RequestOptions = {}): Promise<ListAccountRolesResponse> {
    return this.transport.request<ListAccountRolesResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/account-roles` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/account-roles — grant a user an account role. */
  grantRole(orgId: string, body: GrantAccountRoleRequest, opts: RequestOptions = {}): Promise<GrantAccountRoleResponse> {
    return this.transport.request<GrantAccountRoleResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/account-roles`, body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/account-roles — revoke by (subject, role) tuple in body. */
  revokeRole(orgId: string, body: RevokeAccountRoleRequest, opts: RequestOptions = {}): Promise<RevokeAccountRoleResponse> {
    return this.transport.request<RevokeAccountRoleResponse>(
      { method: "DELETE", path: `/v1/organizations/${encodeURIComponent(orgId)}/account-roles`, body },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Cross-workspace reads (teams-hub TH2) — bounded fan-out over the
  // account's workspace set; rows arrive tagged with their workspace and a
  // per-workspace status (ok | denied | error).
  // -------------------------------------------------------------------------

  /** GET /v1/organizations/:orgId/account-catalog — catalog entities across the account. */
  catalog(orgId: string, query: AccountCatalogQuery = {}, opts: RequestOptions = {}): Promise<AccountCatalogResponse> {
    return this.transport.request<AccountCatalogResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/account-catalog`,
        query: { kind: query.kind, owner: query.owner, q: query.q, environment: query.environment, limit: query.limit },
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/account-runs — the runs feed across the account. */
  runs(orgId: string, query: AccountRunsQuery = {}, opts: RequestOptions = {}): Promise<AccountRunsResponse> {
    return this.transport.request<AccountRunsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/account-runs`,
        query: { status: query.status, environment: query.environment, branch: query.branch, source: query.source, limit: query.limit },
      },
      opts,
    );
  }
}
