export type {
  IntegrationsRepositoryError,
  IntegrationsResult,
  CursorPosition,
  PageQueryParams,
  PagedResult,
  ConnectionStatus,
  ConnectionScope,
  ConnectionShareMode,
  IntegrationConnection,
  CreateConnectionInput,
  ActivateConnectionInput,
  ListConnectionsQuery,
  ConnectionGrantStatus,
  ConnectionGrant,
  CreateConnectionGrantInput,
  GithubInstallation,
  UpsertGithubInstallationInput,
  RepoLinkStatus,
  RepoLink,
  CreateRepoLinkInput,
  UpdateRepoLinkInput,
  ListRepoLinksQuery,
  InboundDeliveryStatus,
  InboundDelivery,
  InsertInboundDeliveryInput,
  InsertInboundDeliveryOutcome,
  MarkInboundDeliveryInput,
  InstallationTokenCacheEntry,
  UpsertInstallationTokenInput,
  IntegrationsRepository,
} from "./types.js";

export { createIntegrationsRepository } from "./repository.js";

export type {
  OrgScopeTemplate,
  OrgScopeTemplateStatus,
  CreateOrgScopeTemplateInput,
  UpdateOrgScopeTemplateInput,
  ScopeTemplatesRepository,
} from "./scope-templates.js";
export { createScopeTemplatesRepository } from "./scope-templates.js";

// Integration-hub substrate (saas-integration-hub IH0): custody, mint ledger,
// per-provider facts. Additive module beside the IG repository.
export type {
  ProviderCredentialKind,
  ProviderCredentialClass,
  ProviderCredential,
  UpsertProviderCredentialInput,
  MintPurpose,
  MintRevokeStatus,
  MintedCredential,
  InsertMintedCredentialInput,
  MarkMintedCredentialInput,
  ListMintedCredentialsQuery,
  SlackWorkspace,
  UpsertSlackWorkspaceInput,
  CloudflareTokenStatus,
  CloudflareAccount,
  UpsertCloudflareAccountInput,
  SupabaseOrg,
  UpsertSupabaseOrgInput,
  IntegrationHubRepository,
} from "./hub.js";

export { createIntegrationHubRepository, CREDENTIAL_CLASS_BY_KIND } from "./hub.js";
