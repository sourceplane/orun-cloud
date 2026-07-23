import type {
  RevokeMintedCredentialResponse,
  ListMintedCredentialsResponse,
  MintCredentialResponse,
  MintCredentialRequest,
  ListSlackChannelsResponse,
  ConnectIntegrationRequest,
  IssueIntegrationTokenRequest,
  IssueIntegrationTokenResponse,
  CreateRepoLinkRequest,
  CreateRepoLinkResponse,
  DeleteRepoLinkResponse,
  ListRepoLinksResponse,
  ListRepositoriesResponse,
  UpdateRepoLinkRequest,
  UpdateRepoLinkResponse,
  ConnectIntegrationResponse,
  GetIntegrationResponse,
  ListIntegrationsResponse,
  ProviderSecretsCapabilitiesResponse,
  IntegrationRegistryResponse,
  CreateScopeTemplateRequest,
  UpdateScopeTemplateRequest,
  ListScopeTemplatesResponse,
  ScopeTemplateResponse,
  ListInboundDeliveriesResponse,
  ReplayInboundDeliveryResponse,
  RevokeIntegrationResponse,
  UpdateConnectionRequest,
  UpdateConnectionResponse,
  ListConnectionGrantsResponse,
  CreateConnectionGrantRequest,
  CreateConnectionGrantResponse,
  RevokeConnectionGrantResponse,
} from "@saas/contracts/integrations";

import type { Transport, RequestOptions } from "./transport.js";

/**
 * Integrations resource client (GitHub App connections).
 *
 * Org-scoped: every method takes `orgId` as the first argument.
 * Maps to `apps/integrations-worker` via the api-edge `integrations-facade`.
 */
export class IntegrationsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/integrations */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListIntegrationsResponse> {
    return this.transport.request<ListIntegrationsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations`,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/integrations/registry
   *
   * The bulk Integration Registry read (saas-integration-registry IR0): every
   * provider's manifest projected per environment (connect-method liveness)
   * and org (entitlement, fail-soft). Every surface derives from this — the
   * hub, the integration spaces, Cmd-K, and the orun CLI's verb trees. Pure
   * metadata, ETag'd, static per deploy; safe to cache long.
   */
  getRegistry(orgId: string, opts: RequestOptions = {}): Promise<IntegrationRegistryResponse> {
    return this.transport.request<IntegrationRegistryResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/registry`,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/integrations/secrets-capabilities
   *
   * The bulk secret-source DESCRIBE read (saas-secrets-platform SP0c, SP-A1):
   * every capability-declaring provider's scope templates, supported modes,
   * delivery targets, and authoring style in one response. Pure metadata —
   * static per deploy, safe to cache long.
   */
  listSecretsCapabilities(
    orgId: string,
    opts: RequestOptions = {},
  ): Promise<ProviderSecretsCapabilitiesResponse> {
    return this.transport.request<ProviderSecretsCapabilitiesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/secrets-capabilities`,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/integrations/providers/:providerId/scope-templates
   *
   * The manage view (saas-secrets-platform SP4): the provider's declared
   * catalog plus every org-curated template (active AND retired).
   */
  listScopeTemplates(
    orgId: string,
    providerId: string,
    opts: RequestOptions = {},
  ): Promise<ListScopeTemplatesResponse> {
    return this.transport.request<ListScopeTemplatesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/providers/${encodeURIComponent(providerId)}/scope-templates`,
      },
      opts,
    );
  }

  /** POST …/providers/:providerId/scope-templates — create an org-curated
   *  template derived from a declared base (SP4). */
  createScopeTemplate(
    orgId: string,
    providerId: string,
    body: CreateScopeTemplateRequest,
    opts: RequestOptions = {},
  ): Promise<ScopeTemplateResponse> {
    return this.transport.request<ScopeTemplateResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/providers/${encodeURIComponent(providerId)}/scope-templates`,
        body,
      },
      opts,
    );
  }

  /** PATCH …/scope-templates/:templateId — display edits bump version;
   *  status soft-retires/reactivates. No hard delete exists (SP4). */
  updateScopeTemplate(
    orgId: string,
    providerId: string,
    templateId: string,
    body: UpdateScopeTemplateRequest,
    opts: RequestOptions = {},
  ): Promise<ScopeTemplateResponse> {
    return this.transport.request<ScopeTemplateResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/providers/${encodeURIComponent(providerId)}/scope-templates/${encodeURIComponent(templateId)}`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/integrations/:connectionId */
  get(orgId: string, connectionId: string, opts: RequestOptions = {}): Promise<GetIntegrationResponse> {
    return this.transport.request<GetIntegrationResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/:providerId/connect
   *
   * Provider-generic connect (saas-integration-registry IR1): starts the
   * connect flow for any registry provider whose primary live method is
   * install/oauth-kind — returns a pending connection plus the provider URL
   * carrying the signed single-use state (popup + poll, same as the named
   * per-provider methods this generalizes). Token/apikey-kind postures take
   * provider-specific bodies and keep their named methods.
   */
  connect(
    orgId: string,
    providerId: string,
    body: ConnectIntegrationRequest = {},
    opts: RequestOptions = {},
  ): Promise<ConnectIntegrationResponse> {
    return this.transport.request<ConnectIntegrationResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(providerId)}/connect`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/github/connect
   *
   * Returns a pending connection plus the provider install URL carrying the
   * signed single-use state; open the URL in a popup and poll `get` until the
   * connection turns `active`.
   */
  connectGithub(
    orgId: string,
    body: ConnectIntegrationRequest = {},
    opts: RequestOptions = {},
  ): Promise<ConnectIntegrationResponse> {
    return this.transport.request<ConnectIntegrationResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/github/connect`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/slack/connect
   *
   * The oauth-kind twin of `connectGithub`: returns a pending connection plus
   * the Slack authorize URL carrying the signed single-use state; open it in
   * a popup and poll `get` until the connection turns `active`.
   */
  connectSlack(
    orgId: string,
    body: ConnectIntegrationRequest = {},
    opts: RequestOptions = {},
  ): Promise<ConnectIntegrationResponse> {
    return this.transport.request<ConnectIntegrationResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/slack/connect`,
        body,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/integrations/:connectionId/slack/channels
   *
   * The slack_app channel picker (IH2): channels the workspace bot can see.
   * `query` filters by name substring; `cursor` pages the Slack list.
   */
  listSlackChannels(
    orgId: string,
    connectionId: string,
    params: { query?: string; cursor?: string } = {},
    opts: RequestOptions = {},
  ): Promise<ListSlackChannelsResponse> {
    const search = new URLSearchParams();
    if (params.query) search.set("query", params.query);
    if (params.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    return this.transport.request<ListSlackChannelsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/slack/channels${qs ? `?${qs}` : ""}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/cloudflare/connect
   *
   * Two postures (IH5 / risks D3), chosen server-side by whether the
   * environment has a Cloudflare OAuth client configured:
   *  - OAuth (preferred when configured): call with NO body; the response
   *    carries an `installUrl` for the popup/poll flow, exactly like Slack /
   *    Supabase.
   *  - Token-paste (fallback): pass `{ parentToken }`; the connection comes
   *    back already active — no popup, no polling. The token is write-only.
   */
  connectCloudflare(
    orgId: string,
    body: ConnectIntegrationRequest = {},
    opts: RequestOptions = {},
  ): Promise<ConnectIntegrationResponse> {
    return this.transport.request<ConnectIntegrationResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/cloudflare/connect`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/supabase/connect
   *
   * The oauth-kind (PKCE) connect for Supabase (IH6): returns a pending
   * connection plus the Supabase authorize URL carrying the signed single-use
   * state; open it in a popup and poll `get` until the connection turns
   * `active`.
   */
  connectSupabase(
    orgId: string,
    body: ConnectIntegrationRequest = {},
    opts: RequestOptions = {},
  ): Promise<ConnectIntegrationResponse> {
    return this.transport.request<ConnectIntegrationResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/supabase/connect`,
        body,
      },
      opts,
    );
  }

  /** POST …/integrations/:connectionId/credentials — mint (reveal-once). */
  mintCredential(
    orgId: string,
    connectionId: string,
    body: MintCredentialRequest,
    opts: RequestOptions = {},
  ): Promise<MintCredentialResponse> {
    return this.transport.request<MintCredentialResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/credentials`,
        body,
      },
      opts,
    );
  }

  /** GET …/integrations/:connectionId/credentials — the mint ledger. */
  listMintedCredentials(
    orgId: string,
    connectionId: string,
    opts: RequestOptions = {},
  ): Promise<ListMintedCredentialsResponse> {
    return this.transport.request<ListMintedCredentialsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/credentials`,
      },
      opts,
    );
  }

  /** DELETE …/credentials/:mintId — best-effort revoke; TTL is the backstop. */
  revokeMintedCredential(
    orgId: string,
    connectionId: string,
    mintId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeMintedCredentialResponse> {
    return this.transport.request<RevokeMintedCredentialResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/credentials/${encodeURIComponent(mintId)}`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/integrations/:connectionId/deliveries */
  listDeliveries(
    orgId: string,
    connectionId: string,
    opts: RequestOptions = {},
  ): Promise<ListInboundDeliveriesResponse> {
    return this.transport.request<ListInboundDeliveriesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/deliveries`,
      },
      opts,
    );
  }

  /**
   * POST .../integrations/:connectionId/deliveries/:deliveryId/replay
   *
   * Re-runs normalize/emit from the persisted inbox row — never re-trusts
   * the wire.
   */
  replayDelivery(
    orgId: string,
    connectionId: string,
    deliveryId: string,
    opts: RequestOptions = {},
  ): Promise<ReplayInboundDeliveryResponse> {
    return this.transport.request<ReplayInboundDeliveryResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
        body: {},
      },
      opts,
    );
  }

  /** GET .../integrations/:connectionId/repositories?query= */
  listRepositories(
    orgId: string,
    connectionId: string,
    query?: string,
    opts: RequestOptions = {},
  ): Promise<ListRepositoriesResponse> {
    const qs = query ? `?query=${encodeURIComponent(query)}` : "";
    return this.transport.request<ListRepositoriesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/repositories${qs}`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/projects/:projectId/repo-links */
  listRepoLinks(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<ListRepoLinksResponse> {
    return this.transport.request<ListRepoLinksResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links`,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/projects/:projectId/repo-links */
  createRepoLink(
    orgId: string,
    projectId: string,
    body: CreateRepoLinkRequest,
    opts: RequestOptions = {},
  ): Promise<CreateRepoLinkResponse> {
    return this.transport.request<CreateRepoLinkResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links`,
        body,
      },
      opts,
    );
  }

  /** PATCH .../repo-links/:repoLinkId */
  updateRepoLink(
    orgId: string,
    projectId: string,
    repoLinkId: string,
    body: UpdateRepoLinkRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateRepoLinkResponse> {
    return this.transport.request<UpdateRepoLinkResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links/${encodeURIComponent(repoLinkId)}`,
        body,
      },
      opts,
    );
  }

  /** DELETE .../repo-links/:repoLinkId (soft unlink) */
  unlinkRepoLink(
    orgId: string,
    projectId: string,
    repoLinkId: string,
    opts: RequestOptions = {},
  ): Promise<DeleteRepoLinkResponse> {
    return this.transport.request<DeleteRepoLinkResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links/${encodeURIComponent(repoLinkId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/github/token — the broker.
   *
   * Exchanges the caller's control-plane credential for a short-lived
   * (≤1h), repo-scoped GitHub installation token. Repositories must be
   * linked to projects in the organization; permissions must be within the
   * App's grant. The token is returned exactly once — handle it like a
   * password and let it expire (it is never cached platform-side).
   */
  issueGithubToken(
    orgId: string,
    body: IssueIntegrationTokenRequest,
    opts: RequestOptions = {},
  ): Promise<IssueIntegrationTokenResponse> {
    return this.transport.request<IssueIntegrationTokenResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/github/token`,
        body,
      },
      opts,
    );
  }

  /**
   * DELETE /v1/organizations/:orgId/integrations/:connectionId
   *
   * By default the revoke is BLOCKED (409 connection_in_use) when active
   * brokered secrets still bind to the connection (brokered-orphan-safety,
   * Feature 2). Pass `{ force: true }` to revoke anyway, orphaning those
   * secrets — the response then echoes the orphaned set.
   */
  revoke(
    orgId: string,
    connectionId: string,
    params: { force?: boolean } = {},
    opts: RequestOptions = {},
  ): Promise<RevokeIntegrationResponse> {
    return this.transport.request<RevokeIntegrationResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}`,
        ...(params.force ? { query: { force: "true" } } : {}),
      },
      opts,
    );
  }

  // ── Admission grants & share mode (IT8b) ──────────────────

  /** PATCH /v1/organizations/:orgId/integrations/:connectionId — set share mode. */
  update(
    orgId: string,
    connectionId: string,
    body: UpdateConnectionRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateConnectionResponse> {
    return this.transport.request<UpdateConnectionResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/integrations/:connectionId/grants */
  listGrants(
    orgId: string,
    connectionId: string,
    opts: RequestOptions = {},
  ): Promise<ListConnectionGrantsResponse> {
    return this.transport.request<ListConnectionGrantsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/grants`,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/integrations/:connectionId/grants — admit a workspace. */
  grantWorkspace(
    orgId: string,
    connectionId: string,
    body: CreateConnectionGrantRequest,
    opts: RequestOptions = {},
  ): Promise<CreateConnectionGrantResponse> {
    return this.transport.request<CreateConnectionGrantResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/grants`,
        body,
      },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/integrations/:connectionId/grants/:workspaceOrgId */
  revokeGrant(
    orgId: string,
    connectionId: string,
    workspaceOrgId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeConnectionGrantResponse> {
    return this.transport.request<RevokeConnectionGrantResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(workspaceOrgId)}`,
      },
      opts,
    );
  }
}
