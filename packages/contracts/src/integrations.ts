// Integrations contracts — inbound provider integrations (GitHub App first).
// Owner: integrations-worker (apps/integrations-worker).
//
// Safe projections only: no installation tokens, no App credentials, no raw
// provider payloads. Raw inbound payloads stay in the integrations inbox
// (admin-worker visibility only); these shapes are what crosses the public
// API boundary and what `scm.*` events carry on the event log.
//
// Spec: specs/components/17-integrations.md, specs/epics/saas-integrations/.

// ── Provider seam ────────────────────────────────────────────

/**
 * Registry-driven provider identifier. GitHub is the first adapter, not a
 * special case; the type widens as adapters land (saas-integration-hub IH0
 * added slack/cloudflare/supabase).
 */
// `aws` and `discord` are RESERVED, dormant providers (design §8, IH10): they
// name the two archetypes' next entrants and carry compile-only adapter proofs
// (the Stripe-after-Polar discipline, per-capability). No live connect path,
// no env secrets, no console card beyond the "On the roadmap" strip — the
// registry never resolves them to a configured adapter. Listing them here is
// additive (R7) and is what lets a dormant adapter's scope templates typecheck.
export type IntegrationProviderId =
  | "github"
  | "slack"
  | "cloudflare"
  | "supabase"
  | "aws"
  | "discord";

/**
 * Provider capabilities (saas-integration-hub design §1–§2). The registry
 * exposes what an adapter implements; handlers 404 with a typed
 * `capability_not_supported` error on mismatch instead of 500ing.
 * - "connect": connection lifecycle + health (every provider).
 * - "inbound": verified ingress → durable inbox → normalized events.
 * - "scm": repo links + branch→environment mapping.
 * - "messaging": channel delivery through the ES ChannelProvider seam.
 * - "credential-broker": short-lived scoped credential minting.
 */
export type IntegrationCapability =
  | "connect"
  | "inbound"
  | "scm"
  | "messaging"
  | "credential-broker"
  // saas-secrets-platform SP0: the provider is a secret SOURCE — it declares
  // scope templates, which secret modes its mint can back, and its delivery
  // targets, so the secrets substrate derives instead of hardcoding. A
  // "secrets"-declaring provider MUST also declare "credential-broker" (you
  // cannot describe a secret source without a mint to produce it).
  | "secrets";

/**
 * Which stored/served secret modes a provider's mint can back
 * (saas-secrets-platform). `brokered` = a short-lived value fit for
 * mint-at-resolve (IH7); `rotated` = a value that can be STORED and re-minted
 * on a schedule (the provider issues a token with a settable expiry, RS1).
 */
export type SecretMode = "brokered" | "rotated";

/**
 * The DESCRIBE half of a secret-source provider (saas-secrets-platform SP0),
 * projected over the wire from `GET …/providers/{id}/secrets-capability`. The
 * substrate reads this instead of hardcoding BROKER_CAPABLE_PROVIDERS /
 * ALLOWED_ROTATION_PROVIDERS / SCOPE_TEMPLATE_CATALOG. Never a credential.
 */
export interface ProviderSecretsCapability {
  provider: IntegrationProviderId;
  /** Canonical scope-template catalog — the single source of truth. */
  scopeTemplates: readonly IntegrationScopeTemplate[];
  /** Modes this provider's mint can back. */
  supportedModes: readonly SecretMode[];
  /** Materialize target ids a rotated value can be delivered into (RS `deliver`).
   *  Empty when the provider only serves per-run consumers. */
  deliveryTargets: readonly string[];
  /** How the create experience is rendered: the substrate's default surface, or
   *  a surface the integration registers in its own space. */
  authoring: "declarative" | "custom";
}

export interface ProviderSecretsCapabilityResponse {
  capability: ProviderSecretsCapability;
}

/**
 * The org-facing BULK capability read (saas-secrets-platform SP0c, SP-A1):
 * every capability-declaring provider in one response, so the console's create
 * surfaces and the Secrets lens share a single cached read. Served at
 * `GET /v1/organizations/{orgId}/integrations/secrets-capabilities` (rides the
 * existing api-edge integrations facade). Pure metadata — never a credential.
 */
export interface ProviderSecretsCapabilitiesResponse {
  capabilities: readonly ProviderSecretsCapability[];
}

/**
 * How a provider's connect flow starts (drives the console connect UX):
 * - "install": provider-hosted app install page (GitHub App).
 * - "oauth": OAuth authorization-code flow (Slack, Supabase).
 * - "token": customer pastes a parent credential once (Cloudflare).
 */
export type IntegrationConnectKind = "install" | "oauth" | "token";

/** Static provider descriptors (marketplace cards, capability narrowing). */
export const INTEGRATION_PROVIDER_DESCRIPTORS: Record<
  IntegrationProviderId,
  {
    displayName: string;
    connectKind: IntegrationConnectKind;
    capabilities: readonly IntegrationCapability[];
  }
> = {
  github: {
    displayName: "GitHub",
    connectKind: "install",
    capabilities: ["connect", "inbound", "scm", "credential-broker"],
  },
  slack: {
    displayName: "Slack",
    connectKind: "oauth",
    capabilities: ["connect", "inbound", "messaging"],
  },
  cloudflare: {
    displayName: "Cloudflare",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],
  },
  supabase: {
    displayName: "Supabase",
    connectKind: "oauth",
    capabilities: ["connect", "credential-broker"],
  },
  // Dormant (IH10): reserved descriptors for the roadmap strip. The adapters
  // implement the capability seam but no live path exists.
  aws: {
    displayName: "AWS",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],
  },
  discord: {
    displayName: "Discord",
    connectKind: "oauth",
    capabilities: ["connect", "messaging"],
  },
} as const;

// ── Connections ─────────────────────────────────────────────

export type IntegrationConnectionStatus =
  | "pending"
  | "active"
  | "suspended"
  | "revoked";

/**
 * Ownership scope of a connection (saas-integration-tenancy IT7):
 * - "account": shared, owned at the parent account and resolved up to it by
 *   every workspace under the account (the default and the epic's core case).
 * - "workspace": private to the owning org, never resolved up — a workspace's
 *   own GitHub account, invisible to siblings and the account.
 */
export type IntegrationConnectionScope = "account" | "workspace";

/**
 * Admission posture for a shared connection (saas-integration-tenancy IT8):
 * - "auto": every workspace under the account is implicitly admitted (default,
 *   today's soft sharing).
 * - "granted": a workspace may consume the connection only if the account has
 *   granted it admission.
 */
export type IntegrationConnectionShareMode = "auto" | "granted";

/**
 * Safe projection of an org ↔ provider connection (a GitHub App
 * installation bound to an organization). Never carries installation ids,
 * tokens, or state nonces.
 */
export interface PublicConnection {
  /** Public id, `int_<32hex>`. */
  id: string;
  /** Public org id, `org_<32hex>`. */
  orgId: string;
  provider: IntegrationProviderId;
  status: IntegrationConnectionStatus;
  /**
   * Ownership scope (IT7): "account" = shared across the parent account's
   * workspaces (resolves up); "workspace" = private to the owning org, never
   * resolved up. Defaults to "account".
   */
  scope: IntegrationConnectionScope;
  /**
   * Admission posture (IT8): "auto" = all workspaces under the account may
   * consume it (default); "granted" = only granted workspaces. Meaningful only
   * for account-shared connections.
   */
  shareMode: IntegrationConnectionShareMode;
  /** Operator-facing label, defaults to the provider account login. */
  displayName: string | null;
  /** Provider-side account login (e.g. GitHub org login). */
  externalAccountLogin: string | null;
  /** Provider-side account kind, e.g. "Organization" | "User". */
  externalAccountType: string | null;
  /** Provider-side repo grant: "all" | "selected" (GitHub semantics). */
  repositorySelection: string | null;
  /** Opaque id of the actor that initiated the connect flow. */
  createdBy: string | null;
  /** ISO-8601; set when the provider-side install is verified and bound. */
  connectedAt: string | null;
  /** ISO-8601; set on platform-side revoke or provider-side uninstall. */
  revokedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * **Inherited** (saas-integration-tenancy IT10): true when this row is the
   * **Account's** shared connection seen from a **child** workspace — read-only,
   * shown for provenance. Absent/false for the org's own connections. When true,
   * `sharedByWorkspaceRef` + `sharedByName` identify the owning Account.
   */
  inherited?: boolean;
  /** Owning Account's Workspace ID (`ws_…`), led-with. Present iff `inherited`. */
  sharedByWorkspaceRef?: string | null;
  /** Owning Account's display name. Present iff `inherited`. */
  sharedByName?: string | null;
}

// ── Repo links ──────────────────────────────────────────────

export type RepoLinkStatus = "active" | "unlinked";

/**
 * Branch → environment mapping, e.g. `{"main": "prod", "staging": "stage"}`.
 * Keys are provider branch names; values are environment slugs validated
 * against the project's live environments at write time.
 */
export type BranchEnvMap = Record<string, string>;

/** Safe projection of a project ↔ repository link. */
export interface PublicRepoLink {
  /** Public id, `repl_<32hex>`. */
  id: string;
  orgId: string;
  projectId: string;
  /** Owning connection public id (`int_<32hex>`). */
  connectionId: string;
  /** Provider-side repository id (opaque string; GitHub numeric id). */
  repoExternalId: string;
  /** Provider-side full name, e.g. "acme/storefront". */
  repoFullName: string;
  defaultBranch: string | null;
  branchEnvMap: BranchEnvMap;
  status: RepoLinkStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Inbound deliveries ──────────────────────────────────────

export type InboundDeliveryStatus =
  | "received"
  | "attributed"
  | "emitted"
  | "skipped"
  | "failed";

/**
 * Safe projection of one inbound provider delivery (the durable-inbox row).
 * Never carries the raw payload — that stays in the inbox, admin-only.
 */
export interface PublicInboundDelivery {
  /** Public id, `igd_<32hex>`. */
  id: string;
  provider: IntegrationProviderId;
  /** Provider event type, e.g. "push", "pull_request", "installation". */
  eventType: string;
  /** Provider event action where applicable, e.g. "opened". */
  action: string | null;
  status: InboundDeliveryStatus;
  signatureOk: boolean;
  attempts: number;
  /** Safe failure summary; never raw provider error bodies. */
  failureReason: string | null;
  /** Event-log id of the emitted `scm.*` event, when status = "emitted". */
  emittedEventId: string | null;
  receivedAt: string;
}

// ── Cursor pagination (matches the platform list convention) ─

export interface IntegrationsCursor {
  createdAt: string;
  id: string;
}

// ── Connect flow ────────────────────────────────────────────

/**
 * POST /v1/organizations/{orgId}/integrations/{provider}/connect
 * Policy: organization.integration.connect.
 * Entitlement: feature.integrations.github.
 */
export interface ConnectIntegrationRequest {
  /** Optional operator label for the connection. */
  displayName?: string;
  /**
   * Token-kind connect (IH5 Cloudflare): the pasted parent API token.
   * WRITE-ONLY — verified, enveloped, never echoed or logged.
   */
  parentToken?: string;
}

export interface ConnectIntegrationResponse {
  connection: PublicConnection;
  /**
   * Provider install/authorize URL carrying the signed single-use state. The
   * console opens this in a popup; the provider redirects back to the
   * platform's ingress which activates the connection. ABSENT for token-kind
   * connects (IH5 Cloudflare): the paste is verified synchronously and the
   * returned connection is already active.
   */
  installUrl?: string;
}

/** GET /v1/organizations/{orgId}/integrations */
export interface ListIntegrationsResponse {
  connections: PublicConnection[];
  nextCursor: IntegrationsCursor | null;
}

/**
 * Safe custody summary for the connection detail (service-identity-bootstrap
 * SI6) — METADATA ONLY, never ciphertext or values. One entry per durable
 * custody row; transient bootstrap material (PKCE verifiers, token caches)
 * is never surfaced.
 */
export interface PublicConnectionCustody {
  /** Custody kind, e.g. "cloudflare_service_token". */
  kind: string;
  /** SI1 classes: infrastructure = org-owned operating credential;
   *  identity = user-derived (deprecated custody, pending upgrade). */
  credentialClass: "identity" | "infrastructure";
  /** True when the credential derives from a person's OAuth session — the
   *  console renders the user-tie warning on this. */
  userDerived: boolean;
  /** Last platform rotation (null = never rotated since capture). */
  rotatedAt: string | null;
  createdAt: string;
  /** Safe scope metadata (e.g. Supabase project refs with custodied keys —
   *  never the keys). */
  scopes: unknown[] | Record<string, unknown> | null;
}

/** GET /v1/organizations/{orgId}/integrations/{connectionId} */
export interface GetIntegrationResponse {
  connection: PublicConnection;
  /** Custody summary (SI6) — present for custody-holding providers. */
  custody?: PublicConnectionCustody[];
}

/** DELETE /v1/organizations/{orgId}/integrations/{connectionId} */
export interface RevokeIntegrationResponse {
  revoked: true;
  /**
   * brokered-orphan-safety (Feature 2): brokered secrets orphaned by a forced
   * revoke (`?force=true`) — echoed so the caller/console can surface the
   * casualties. Absent on a normal revoke (which is blocked while references
   * exist) and on an idempotent re-revoke.
   */
  orphaned?: Array<{ id: string; secretKey: string; scope: string }>;
}

// ── Admission grants & share mode (IT8b) ────────────────────
// Account-admin management of which workspaces may consume an account-shared
// connection. Authorized as organization.integration.manage against the
// connection's owning (account) org. A grant is identified by the admitted
// workspace org, the natural key for admission.

export interface PublicConnectionGrant {
  /** Public id of the account-shared connection (`int_<32hex>`). */
  connectionId: string;
  /** Public id of the admitted workspace org (`org_<32hex>`). */
  workspaceOrgId: string;
  /** Opaque id of the actor that granted admission. */
  grantedBy: string | null;
  status: "active" | "revoked";
  grantedAt: string;
  revokedAt: string | null;
}

/** GET /v1/organizations/{orgId}/integrations/{connectionId}/grants */
export interface ListConnectionGrantsResponse {
  grants: PublicConnectionGrant[];
}

/** POST /v1/organizations/{orgId}/integrations/{connectionId}/grants */
export interface CreateConnectionGrantRequest {
  /** Public id of the workspace org to admit (`org_<32hex>`). */
  workspaceOrgId: string;
}

export interface CreateConnectionGrantResponse {
  grant: PublicConnectionGrant;
}

/** DELETE /v1/organizations/{orgId}/integrations/{connectionId}/grants/{workspaceOrgId} */
export interface RevokeConnectionGrantResponse {
  revoked: true;
}

/** PATCH /v1/organizations/{orgId}/integrations/{connectionId} */
export interface UpdateConnectionRequest {
  /** Switch the admission posture of an account-shared connection. */
  shareMode?: IntegrationConnectionShareMode;
}

export interface UpdateConnectionResponse {
  connection: PublicConnection;
}

// ── Repository browsing (IG3) ───────────────────────────────

/** Safe projection of a provider repository visible to an installation. */
export interface PublicRepository {
  /** Provider-side repository id (opaque string). */
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  private: boolean;
}

/**
 * GET /v1/organizations/{orgId}/integrations/{connectionId}/repositories
 * Lists repositories the installation can see (via the platform's cached
 * installation token). `query` filters by substring of the full name.
 */
export interface ListRepositoriesResponse {
  repositories: PublicRepository[];
  /** True when the provider reported more pages than were fetched. */
  truncated: boolean;
}

// ── Slack channel picker (saas-integration-hub IH2, design §4.2) ──

/** A Slack conversation the bot can be asked to post to. */
export interface SlackChannelRef {
  /** Slack channel id (`C…`/`G…`) — what the notification channel stores. */
  id: string;
  name: string;
  /** Private channels need the bot invited before delivery works. */
  isPrivate: boolean;
}

/**
 * GET …/integrations/{connectionId}/slack/channels — MessagingCapability
 * `listChannels`. `query` filters by name substring; `cursor` pages through
 * Slack's `conversations.list`.
 */
export interface ListSlackChannelsResponse {
  channels: SlackChannelRef[];
  nextCursor: string | null;
}

// ── Repo link flow ──────────────────────────────────────────

/**
 * POST /v1/organizations/{orgId}/projects/{projectId}/repo-links
 * Policy: project.repo_link.write. Entitlement: limit.repo_links.
 */
export interface CreateRepoLinkRequest {
  connectionId: string;
  repoExternalId: string;
  repoFullName: string;
  defaultBranch?: string;
  branchEnvMap?: BranchEnvMap;
}

export interface CreateRepoLinkResponse {
  repoLink: PublicRepoLink;
}

export interface UpdateRepoLinkRequest {
  branchEnvMap?: BranchEnvMap;
  defaultBranch?: string;
}

export interface UpdateRepoLinkResponse {
  repoLink: PublicRepoLink;
}

export interface ListRepoLinksResponse {
  repoLinks: PublicRepoLink[];
  nextCursor: IntegrationsCursor | null;
}

export interface DeleteRepoLinkResponse {
  deleted: true;
}

// ── Delivery log + replay ───────────────────────────────────

/** GET /v1/organizations/{orgId}/integrations/{connectionId}/deliveries */
export interface ListInboundDeliveriesResponse {
  deliveries: PublicInboundDelivery[];
  nextCursor: IntegrationsCursor | null;
}

/**
 * POST .../deliveries/{deliveryId}/replay — re-runs normalize/emit from the
 * persisted inbox row; never re-trusts the wire. Body reserved for future
 * options.
 */
export interface ReplayInboundDeliveryRequest {}

export interface ReplayInboundDeliveryResponse {
  delivery: PublicInboundDelivery;
}

// ── Token broker ────────────────────────────────────────────

/**
 * POST /v1/organizations/{orgId}/integrations/github/token
 * Policy: organization.integration.token.issue.
 *
 * Requested repositories must be linked to a project the actor can access;
 * requested permissions must be ⊆ the App's granted permissions
 * (deny-by-default). The minted token is returned exactly once, never
 * cached, never logged.
 */
export interface IssueIntegrationTokenRequest {
  /** Provider-side repository ids (must each match an active repo link). */
  repositories: string[];
  /** e.g. { "contents": "read", "checks": "write" }. */
  permissions: Record<string, "read" | "write">;
}

export interface IssueIntegrationTokenResponse {
  /** Reveal-once short-lived installation token. TTL ≤ 1h. */
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  repositories: string[];
  permissions: Record<string, "read" | "write">;
}

// ── Credential broker (saas-integration-hub IH0/IH4) ────────
// Provider-generic generalization of the IG4 GitHub token broker: adapters
// publish named, versioned SCOPE TEMPLATES; a mint names a template + params;
// the adapter computes the provider-native grant (template ⊆ parent grant,
// deny-by-default), TTL is clamped, the value is revealed exactly once, and
// the LEDGER records everything except the value.

/**
 * A named, versioned credential scope an adapter can mint against, e.g.
 * Cloudflare "workers-deploy" or Supabase "db-migrate". Safe descriptor —
 * rendered in the console template catalog.
 */
export interface IntegrationScopeTemplate {
  /** Stable template id, unique per provider (e.g. "workers-deploy"). */
  id: string;
  provider: IntegrationProviderId;
  /** Code-declared templates are version 1; org-curated templates (SP4)
   *  bump on every display edit. */
  version: number;
  displayName: string;
  /** What the minted credential can do — the EFFECTIVE breadth, honestly
   *  stated (risks R5: a template that cannot be narrowed must say so). */
  description: string;
  /** Names of accepted params (e.g. ["zoneIds"], ["projectRef"]). */
  params: readonly string[];
  /** Hard TTL ceiling for this template, seconds. */
  maxTtlSeconds: number;
  /**
   * Custody-served template (service-identity-bootstrap SI4): the minted
   * value is read from THIS provider_credentials kind (an org-owned
   * infrastructure credential custodied at connect, e.g. a Supabase project
   * service key) instead of a live provider mint. No provider call, no
   * parent-token spend, no mint lock on the resolve path. `params.projectRef`
   * (when declared) selects the entry inside the custodied JSON map.
   */
  custodyKind?: string;
  /**
   * Where the template is authored (saas-secrets-platform SP4):
   * "declared" = the provider adapter's code catalog; "custom" = an
   * org-curated derivation managed at runtime in the provider's space.
   * Absent means "declared" (pre-SP4 emitters).
   */
  origin?: "declared" | "custom";
  /** For a custom template: the code-declared base supplying mint semantics. */
  baseTemplate?: string;
  /** For a custom template: soft-retire hides it from create surfaces while
   *  existing bindings keep resolving. Absent means active. */
  status?: "active" | "retired";
}

// ── Org-curated scope templates (saas-secrets-platform SP4) ──

/** POST /v1/organizations/:orgId/integrations/providers/:providerId/scope-templates */
export interface CreateScopeTemplateRequest {
  /** New template id (code-template grammar; must not collide with the
   *  provider's declared catalog or an existing custom id). */
  templateId: string;
  /** The code-declared template supplying mint semantics (custom ⊆ base). */
  baseTemplate: string;
  displayName: string;
  description?: string;
}

/** PATCH …/scope-templates/:templateId — display edits bump version;
 *  `status` soft-retires / reactivates. There is NO hard delete (SP-A6). */
export interface UpdateScopeTemplateRequest {
  displayName?: string;
  description?: string;
  status?: "active" | "retired";
}

/** GET …/scope-templates — the manage view: the provider's declared catalog
 *  plus every org-curated template (active AND retired). */
export interface ListScopeTemplatesResponse {
  templates: readonly IntegrationScopeTemplate[];
}

export interface ScopeTemplateResponse {
  template: IntegrationScopeTemplate;
}

export type IntegrationMintPurpose = "api" | "secret_resolve" | "rotation";

export type IntegrationMintRevokeStatus = "pending" | "revoked" | "expired" | "orphaned";

/**
 * Safe ledger projection of one minted credential. NEVER carries the
 * credential value — the value is revealed exactly once at mint time.
 */
export interface PublicMintedCredential {
  /** Public id, `mint_<32hex>`. */
  id: string;
  orgId: string;
  /** Owning connection public id (`int_<32hex>`). */
  connectionId: string;
  provider: IntegrationProviderId;
  template: string;
  /** Scoped-down request params — never secrets. */
  params: Record<string, unknown> | null;
  purpose: IntegrationMintPurpose;
  /** Actor public id; null for internal (secret-resolve) mints. */
  requestedBy: string | null;
  /** Run/job attribution when purpose = "secret_resolve". */
  runId: string | null;
  jobId: string | null;
  ttlSeconds: number;
  /**
   * Custody kind that authorized the mint (service-identity-bootstrap SI1),
   * e.g. "cloudflare_service_token" vs the deprecated
   * "cloudflare_refresh_token". Null for parentless providers and pre-SI1
   * ledger rows. Lets the console and audit answer "was this credential
   * minted from a user-derived token?".
   */
  parentKind: string | null;
  mintedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokeStatus: IntegrationMintRevokeStatus;
}

/**
 * POST /v1/organizations/{orgId}/integrations/{connectionId}/credentials
 * Policy: organization.integration.credential.issue.
 * Entitlement: feature.integrations.credential_broker.
 */
export interface MintCredentialRequest {
  /** Scope template id (must be published by the connection's provider). */
  template: string;
  /** Template params (validated against the template's declared params). */
  params?: Record<string, unknown>;
  /** Requested TTL; clamped to min(request, template max, provider max). */
  ttlSeconds?: number;
}

export interface MintCredentialResponse {
  /**
   * Reveal-once credential material, shape per provider (e.g. Cloudflare
   * `{ token }`, Supabase `{ accessToken }`). Never cached, never logged,
   * never retrievable again.
   */
  credential: Record<string, string>;
  mint: PublicMintedCredential;
}

/** GET /v1/organizations/{orgId}/integrations/{connectionId}/credentials */
export interface ListMintedCredentialsResponse {
  mints: PublicMintedCredential[];
  nextCursor: IntegrationsCursor | null;
}

/** DELETE .../credentials/{mintId} — best-effort provider-side revoke. */
export interface RevokeMintedCredentialResponse {
  revoked: true;
}

// ── Write-back proxy (IG9 outbound bridge — internal endpoint) ──

/** Check Run projection posted back to GitHub (mirrors the GitHub API shape). */
export interface WritebackCheckRun {
  /** Display name, e.g. "orun / affected components". */
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  /** Required when status is "completed": success | failure | neutral | … */
  conclusion?: string;
  /** Deep link to the cockpit run. */
  detailsUrl?: string;
  title: string;
  summary: string;
}

/** Commit-status projection posted back to GitHub. */
export interface WritebackCommitStatus {
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  context: string;
  description?: string;
  targetUrl?: string;
}

/**
 * POST /internal/github/writeback — state-worker drives this on a run-result
 * event (pairs with `saas-orun-platform` OV5). Service-binding only
 * (`x-internal-caller: state-worker`); integrations-worker owns the App key,
 * resolves the repo's installation, mints a SCOPED token, posts, and audits —
 * state-worker never sees the credential. The "owner/repo" GitHub path is
 * resolved server-side from the authoritative repo link (the caller supplies
 * only the rename-stable repo id), so a stale name can't redirect a post.
 * Fail-soft: a repo that is not App-linked or an App lacking the write grant
 * resolves to `skipped`; a GitHub error to `failed`. Neither ever breaks a run.
 */
export type WritebackRequest =
  | {
      kind: "check_run";
      /** Org public id (org_…). */
      orgId: string;
      /** Rename-stable provider repo id (GitHub's numeric id, as a string). */
      repoExternalId: string;
      checkRun: WritebackCheckRun;
    }
  | {
      kind: "commit_status";
      orgId: string;
      repoExternalId: string;
      status: WritebackCommitStatus;
    };

export interface WritebackResponse {
  outcome: "posted" | "skipped" | "failed";
  /** Present for skipped/failed — a stable machine-readable reason. */
  reason?: string;
  /** Present for posted — the created GitHub resource. */
  resource?: { id: number; url: string | null };
}

/** The only caller allowed to drive write-back (service-binding only). */
export const INTEGRATIONS_WRITEBACK_CALLER = "state-worker";

/** The only caller allowed to read Slack delivery credentials (IH2 —
 *  service-binding only; the bot token lives in its isolate memory ≤5 min). */
export const SLACK_CREDENTIALS_CALLER = "notifications-worker";

// ── Brokered-secret mint (IH7 — internal endpoints) ─────────

/** The only caller allowed on the internal broker routes (IH7 —
 *  service-binding only; config-worker's secret create/resolve paths). */
export const BROKERED_MINT_CALLER = "config-worker";

/**
 * POST /internal/credentials/validate-binding — config-worker validates a
 * brokered secret binding at CREATE time (design §5.4: "you cannot bind
 * authority you could not mint" — the caller has already enforced the dual
 * policy; this validates the pointer itself and returns the provider for
 * chain provenance). Raw org UUID (internal convention); public connection id
 * as stored in the binding pointer.
 */
export interface ValidateBrokerBindingRequest {
  /** Raw org UUID. */
  orgId: string;
  /** Public connection id (int_…) from the binding pointer. */
  connectionId: string;
  template: string;
  params?: Record<string, unknown>;
}

export interface ValidateBrokerBindingResponse {
  /** The connection's provider — stored for binding provenance/display. */
  provider: IntegrationProviderId;
  /** The template's TTL ceiling (informational). */
  maxTtlSeconds: number;
  /** The provider's supported secret modes (saas-secrets-platform SP0b) — the
   *  create gate rejects a mode this provider does not back, replacing the
   *  hardcoded ALLOWED_ROTATION_PROVIDERS. Empty for a provider without a
   *  secrets capability. */
  supportedModes: readonly SecretMode[];
}

/**
 * POST /internal/credentials/mint — service-binding-only mint reachable only
 * over the config→integrations service binding, never through api-edge.
 * Two internal purposes ride it (both already gated upstream by
 * config-worker; the broker still enforces its own entitlement, the per-org
 * daily mint rate limit, template validation, and ledger-before-reveal):
 *   - "secret_resolve" — brokered secret resolution (design §5.4): Layer-1
 *     bearer authz + live lease in state-worker, Layer-2 secret policy in
 *     config-worker; run attribution (runId/jobId) lands in the ledger.
 *   - "rotation" — a provider-rotated secret's stored value being produced
 *     (provider-rotated-secrets RS1 create-from-parent / RS2 engine): gated
 *     by secret.write policy in config-worker; no run/job attribution.
 */
export interface InternalMintCredentialRequest {
  /** Raw org UUID. */
  orgId: string;
  /** Public connection id (int_…) from the binding pointer. */
  connectionId: string;
  template: string;
  params?: Record<string, unknown>;
  /** Requested TTL; the broker clamps to min(request, template max, 1h). */
  ttlSeconds?: number;
  purpose: "secret_resolve" | "rotation";
  /** Ledger attribution (never an authz input). */
  requestedBy?: string | null;
  /** The verified actor kind behind requestedBy (event attribution only). */
  requestedByType?: string | null;
  runId?: string | null;
  jobId?: string | null;
}

export interface InternalMintCredentialResponse {
  /**
   * The injectable secret value (reveal-once). The broker requires the
   * provider's credential material to be a single opaque value — it is
   * returned here and NEVER retrievable again.
   */
  value: string;
  mint: PublicMintedCredential;
}

// ── Event taxonomy ──────────────────────────────────────────

/** Platform lifecycle events emitted by the integrations context. */
export const INTEGRATION_EVENT_TYPES = {
  CONNECTED: "integration.connected",
  SUSPENDED: "integration.suspended",
  REACTIVATED: "integration.reactivated",
  REVOKED: "integration.revoked",
  REPO_SELECTION_CHANGED: "integration.repo_selection_changed",
  TOKEN_ISSUED: "integration.token.issued",
  // Write-back proxy (IG9 outbound bridge).
  CHECKRUN_POSTED: "integration.checkrun.posted",
  COMMIT_STATUS_POSTED: "integration.commit_status.posted",
  // Credential broker (saas-integration-hub IH4).
  CREDENTIAL_ISSUED: "integration.credential.issued",
  CREDENTIAL_REVOKED: "integration.credential.revoked",
  CREDENTIAL_MINT_FAILED: "integration.credential.mint_failed",
  // Brokered secret bindings (saas-integration-hub IH7).
  SECRET_BINDING_CREATED: "integration.secret_binding.created",
  SECRET_BINDING_REMOVED: "integration.secret_binding.removed",
  // Service-identity bootstrap (sub-epics/service-identity-bootstrap SI3):
  // a connection's custody upgraded from a user-derived identity credential
  // to a provider-side service identity.
  CONNECTION_UPGRADED: "integration.connection.upgraded",
} as const;

export type IntegrationEventType =
  (typeof INTEGRATION_EVENT_TYPES)[keyof typeof INTEGRATION_EVENT_TYPES];

/**
 * Normalized, provider-neutral SCM events emitted onto the event log.
 * Additive-only by rule (R7): new fields and new types may be added; existing
 * fields never change meaning. Products consume these through the shipped
 * outbound-webhooks pipeline.
 */
export const SCM_EVENT_TYPES = {
  PUSH: "scm.push",
  PULL_REQUEST_OPENED: "scm.pull_request.opened",
  PULL_REQUEST_UPDATED: "scm.pull_request.updated",
  PULL_REQUEST_MERGED: "scm.pull_request.merged",
  PULL_REQUEST_CLOSED: "scm.pull_request.closed",
  CHECK_COMPLETED: "scm.check.completed",
  RELEASE_PUBLISHED: "scm.release.published",
  BRANCH_CREATED: "scm.branch.created",
  BRANCH_DELETED: "scm.branch.deleted",
  TAG_CREATED: "scm.tag.created",
  REPO_LINKED: "scm.repo.linked",
  REPO_UNLINKED: "scm.repo.unlinked",
} as const;

export type ScmEventType = (typeof SCM_EVENT_TYPES)[keyof typeof SCM_EVENT_TYPES];

// ── Versioned `scm.*` payload projections (v1) ──────────────
// Compact, documented projections — never the raw provider payload (raw stays
// in the inbox for replay/debug). Every payload carries the repo identity and
// scope; `projectId`/`environment` are set when a repo link matches.

/** Repository identity carried by every scm.* payload. */
export interface ScmRepoRef {
  provider: IntegrationProviderId;
  /** Rename-stable repo id (GitHub's numeric repository id, as a string). */
  externalId: string;
  fullName: string;
  /** Rename-stable owner account id (IG8) — the object-graph bridge federates
   *  on (provider, externalId) and records the owner id; null when absent. */
  ownerId: string | null;
}

/** Common envelope-payload base for scm.* events (version 1). */
export interface ScmEventBaseV1 {
  version: 1;
  /** Public org id. */
  orgId: string;
  /** Public project id when a repo link matched, else null. */
  projectId: string | null;
  /** Environment slug resolved from the branch → environment map, else null. */
  environment: string | null;
  repo: ScmRepoRef;
}

export interface ScmPushEventV1 extends ScmEventBaseV1 {
  ref: string;
  branch: string | null;
  beforeSha: string;
  afterSha: string;
  /** Compact commit summaries; capped, never full diffs. */
  commits: Array<{
    sha: string;
    message: string;
    authorLogin: string | null;
  }>;
  pusherLogin: string | null;
}

export interface ScmPullRequestEventV1 extends ScmEventBaseV1 {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  /** Base commit SHA (IG8) — the Merkle catalog diff bound (base↔head); "" when
   *  the provider omits it. Distinct from targetBranch (the base ref name). */
  baseSha: string;
  authorLogin: string | null;
  url: string | null;
}

export interface ScmCheckCompletedEventV1 extends ScmEventBaseV1 {
  checkName: string;
  conclusion: string | null;
  headSha: string;
  url: string | null;
}

export interface ScmReleasePublishedEventV1 extends ScmEventBaseV1 {
  tagName: string;
  releaseName: string | null;
  url: string | null;
}

export interface ScmBranchEventV1 extends ScmEventBaseV1 {
  branch: string;
}

export interface ScmTagCreatedEventV1 extends ScmEventBaseV1 {
  tag: string;
}

export interface ScmRepoLinkEventV1 extends ScmEventBaseV1 {
  repoLinkId: string;
}

// ── Normalized `messaging.*` events (saas-integration-hub IH0/IH3) ──
// The messaging-archetype twin of `scm.*`: provider-neutral projections of
// inbound messaging-platform activity (Slack first). Additive-only by rule
// (IH risks R8); raw payloads stay in the inbox for replay.

export const MESSAGING_EVENT_TYPES = {
  COMMAND_INVOKED: "messaging.command.invoked",
  ACTION_INVOKED: "messaging.action.invoked",
  CHANNEL_RENAMED: "messaging.channel.renamed",
  CHANNEL_ARCHIVED: "messaging.channel.archived",
} as const;

export type MessagingEventType =
  (typeof MESSAGING_EVENT_TYPES)[keyof typeof MESSAGING_EVENT_TYPES];

/** Common envelope-payload base for messaging.* events (version 1). */
export interface MessagingEventBaseV1 {
  version: 1;
  /** Public org id. */
  orgId: string;
  provider: IntegrationProviderId;
  /** Owning connection public id (`int_<32hex>`). */
  connectionId: string;
  /** Provider-side workspace/team id (Slack team_id). */
  workspaceExternalId: string;
}

export interface MessagingCommandInvokedEventV1 extends MessagingEventBaseV1 {
  /** Command name without the slash, e.g. "orun". */
  command: string;
  /** Sub-command / argument text as typed (may be empty). */
  text: string;
  /** Provider-side channel id the command was invoked in. */
  channelExternalId: string;
  /** Provider-side user id of the invoker (NOT a platform identity — D6). */
  invokedByExternalUser: string | null;
}

export interface MessagingActionInvokedEventV1 extends MessagingEventBaseV1 {
  /** Stable action id carried by the message, e.g. "ack", "mute_rule". */
  actionId: string;
  /** Opaque action value (e.g. the rule public id the button targets). */
  value: string | null;
  channelExternalId: string;
  invokedByExternalUser: string | null;
}

export interface MessagingChannelEventV1 extends MessagingEventBaseV1 {
  channelExternalId: string;
  /** Channel name after the change (renamed) or at archive time. */
  channelName: string | null;
}

// ── Governance constants ────────────────────────────────────

/** Policy actions evaluated by policy-worker (deny-by-default). */
export const INTEGRATION_POLICY_ACTIONS = {
  READ: "organization.integration.read",
  CONNECT: "organization.integration.connect",
  MANAGE: "organization.integration.manage",
  TOKEN_ISSUE: "organization.integration.token.issue",
  REPO_LINK_WRITE: "project.repo_link.write",
  // Credential broker (saas-integration-hub IH4; exposure posture D5).
  CREDENTIAL_ISSUE: "organization.integration.credential.issue",
  // Channel picker + notification-action administration (IH2/IH3).
  MESSAGING_MANAGE: "organization.integration.messaging.manage",
} as const;

/** Entitlement keys gating the surface (412 + upgrade UX on deny). */
export const INTEGRATION_ENTITLEMENTS = {
  GITHUB: "feature.integrations.github",
  REPO_LINKS_LIMIT: "limit.repo_links",
  // saas-integration-hub providers (plan placement: IH risks D7).
  SLACK: "feature.integrations.slack",
  CLOUDFLARE: "feature.integrations.cloudflare",
  SUPABASE: "feature.integrations.supabase",
  CREDENTIAL_BROKER: "feature.integrations.credential_broker",
  BROKERED_SECRETS_LIMIT: "limit.brokered_secrets",
  CREDENTIAL_MINTS_PER_DAY_LIMIT: "limit.credential_mints_per_day",
} as const;

// ── Integration Registry (saas-integration-registry IR0) ─────
//
// One manifest per provider, declared in code beside its adapter and served
// through the bulk registry read. Every surface — hub, integration space,
// Secrets lens, Cmd-K, docs, the orun CLI — derives from these descriptors;
// none re-encodes provider knowledge. Additive-evolution rule applies: fields
// are added, never repurposed; `version` bumps on additions; consumers ignore
// unknown fields. Pure metadata: never behavior, never a credential.

/** Hub grouping + space header vocabulary. `ai-provider` and `compute` are
 *  reserved for the IR5 re-home of the agents provider panel. */
export type IntegrationCategory =
  | "source-control"
  | "messaging"
  | "infrastructure"
  | "ai-provider"
  | "compute";

/** Lifecycle of a manifest, not of a connection: `live` renders as a
 *  connectable card, `dormant` is served for fixtures/tests but hidden from
 *  the hub outside the roadmap strip, `roadmap` renders non-interactive. */
export type IntegrationManifestStatus = "live" | "dormant" | "roadmap";

/** Standard space chrome tabs (IR2). Overview/Connections/Settings render for
 *  every provider; the rest appear per capability. */
export type IntegrationSpaceTab =
  | "overview"
  | "connections"
  | "secrets"
  | "templates"
  | "activity"
  | "settings";

/** Provider module slots the space can mount (IR6). String-typed so a module
 *  can land console-side without a contracts release; well-known ids today:
 *  "repositories" | "channels" | "accounts" | "projects" | "models"
 *  | "sandboxes". */
export type IntegrationModuleRef = string;

// ── CLI projection (IR7 / orun-integrations-cli) ─────────────

/** One positional or flag of a served CLI verb. */
export interface IntegrationCliArg {
  name: string;
  kind: "positional" | "flag";
  type: "string" | "int" | "bool" | "enum" | "kv";
  enum?: readonly string[];
  required?: boolean;
  /** May be given multiple times (repeatable flag / variadic positional). */
  repeat?: boolean;
  help: string;
}

/** The typed endpoint invocation a verb maps onto. `op` values come from a
 *  closed, compiled-in allowlist on BOTH sides (server lint + CLI mapper) —
 *  a descriptor can never reach an operation the SDK could not. */
export interface IntegrationCliInvoke {
  plane: "config" | "integrations";
  op: string;
  /** Arg name → request-field mapping. */
  bind: Readonly<Record<string, string>>;
}

/** One verb of a provider's served command tree. */
export interface IntegrationCliVerb {
  /** Path under the provider namespace, e.g. ["secret","create"]. */
  path: readonly string[];
  summary: string;
  args: readonly IntegrationCliArg[];
  invoke: IntegrationCliInvoke;
  /** The verb needs a connection: the CLI auto-resolves when the org has
   *  exactly one, prompts/errors otherwise, honors `--connection`. */
  needsConnection?: boolean;
}

/** A provider's declared CLI namespace. STANDARD verbs (connections/health/
 *  templates/secret/credentials) derive from `capabilities` and need no entry
 *  here; explicit entries extend or override the standard set (served wins). */
export interface IntegrationCliNamespace {
  verbs: readonly IntegrationCliVerb[];
}

// ── The manifest + its wire projection ───────────────────────

/** A connect method as DECLARED (ordered preference). Environment liveness is
 *  resolved server-side into the descriptor — never declared here. */
export interface IntegrationConnectMethodDecl {
  kind: IntegrationConnectKind;
}

/**
 * The Integration Manifest — the one declaration a provider owns
 * (IR design §2). Declared beside the adapter in integrations-worker;
 * conformance-linted against the adapter (manifest ⊆ adapter) so it can
 * never drift the way the console catalogs did.
 */
export interface IntegrationManifest {
  id: IntegrationProviderId;
  displayName: string;
  category: IntegrationCategory;
  /** Hub card + space header copy. */
  tagline: string;
  /** Ordered connect-method preference; the console renders the first LIVE
   *  method as primary and the rest beneath. */
  connect: readonly IntegrationConnectMethodDecl[];
  /** May an org hold more than one active connection (e.g. Cloudflare
   *  accounts, named AI-provider keys)? */
  multiConnection: boolean;
  /** Mirrors the adapter's capability objects — conformance-linted. */
  capabilities: readonly IntegrationCapability[];
  /** What the console derives for the integration's space (IR2/IR6). */
  space: {
    tabs: readonly IntegrationSpaceTab[];
    modules: readonly IntegrationModuleRef[];
    /** SP1 authoring-registry key, absorbed into the manifest. */
    authoring: "declarative" | "custom";
  };
  /** Served CLI verb tree (IR7); standard verbs derive from capabilities. */
  cli?: IntegrationCliNamespace;
  /** Entitlement key gating connect (412 + upgrade UX). */
  entitlement: string;
  /** Manifest version — bumps on additive evolution. */
  version: number;
  status: IntegrationManifestStatus;
}

/** A connect method as SERVED: declaration + this environment's readiness
 *  (the `getConfiguredProvider` gate, reported instead of hidden). */
export interface IntegrationConnectMethod extends IntegrationConnectMethodDecl {
  live: boolean;
}

/**
 * The manifest projected per environment + org — what the registry read
 * returns and every surface consumes.
 */
export interface IntegrationDescriptor
  extends Omit<IntegrationManifest, "connect"> {
  connect: readonly IntegrationConnectMethod[];
  /** Whether this org's plan currently allows connecting the provider.
   *  Omitted when the entitlement service was unavailable at read time
   *  (fail-soft — surfaces render the connect gate's own 412 on attempt). */
  entitled?: boolean;
}

/** GET /v1/organizations/{orgId}/integrations/registry (IR0). Bulk, ETag'd,
 *  static per deploy apart from the entitlement projection. */
export interface IntegrationRegistryResponse {
  registry: readonly IntegrationDescriptor[];
}
