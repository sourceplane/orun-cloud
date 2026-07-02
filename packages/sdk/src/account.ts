import type {
  ListAccountWorkspacesResponse,
  ListAccountMembersResponse,
  ListAccountRolesResponse,
  GrantAccountRoleRequest,
  GrantAccountRoleResponse,
  RevokeAccountRoleRequest,
  RevokeAccountRoleResponse,
} from "@saas/contracts/membership";
import type { RequestOptions, Transport } from "./transport.js";

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
}
