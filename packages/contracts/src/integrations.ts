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
 * special case; the type widens ("gitlab" | "bitbucket") as adapters land.
 */
export type IntegrationProviderId = "github";

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
}

export interface ConnectIntegrationResponse {
  connection: PublicConnection;
  /**
   * Provider install URL carrying the signed single-use state. The console
   * opens this in a popup; the provider redirects back to the platform's
   * setup ingress which activates the connection.
   */
  installUrl: string;
}

/** GET /v1/organizations/{orgId}/integrations */
export interface ListIntegrationsResponse {
  connections: PublicConnection[];
  nextCursor: IntegrationsCursor | null;
}

/** GET /v1/organizations/{orgId}/integrations/{connectionId} */
export interface GetIntegrationResponse {
  connection: PublicConnection;
}

/** DELETE /v1/organizations/{orgId}/integrations/{connectionId} */
export interface RevokeIntegrationResponse {
  revoked: true;
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

// ── Governance constants ────────────────────────────────────

/** Policy actions evaluated by policy-worker (deny-by-default). */
export const INTEGRATION_POLICY_ACTIONS = {
  READ: "organization.integration.read",
  CONNECT: "organization.integration.connect",
  MANAGE: "organization.integration.manage",
  TOKEN_ISSUE: "organization.integration.token.issue",
  REPO_LINK_WRITE: "project.repo_link.write",
} as const;

/** Entitlement keys gating the surface (412 + upgrade UX on deny). */
export const INTEGRATION_ENTITLEMENTS = {
  GITHUB: "feature.integrations.github",
  REPO_LINKS_LIMIT: "limit.repo_links",
} as const;
