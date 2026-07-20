// Auth contract types for the identity-worker API surface.

import type { OrganizationRole } from "./tenancy.js";

export interface LoginStartRequest {
  email: string;
}

export interface LoginCompleteRequest {
  challengeId: string;
  code: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  /**
   * Slug of the org the user last worked in — a cross-device default-landing
   * hint. Optional: only the profile/session read populates it.
   */
  lastOrgSlug?: string | null;
}

export interface LoginStartResponse {
  challengeId: string;
  expiresAt: string;
  delivery: {
    mode: "local_debug" | "email";
    emailHint: string;
    code?: string;
  };
}

export interface LoginCompleteResponse {
  token: string;
  tokenType: "bearer";
  expiresAt: string;
  user: AuthUser;
}

export interface SessionResponse {
  session: {
    id: string;
    expiresAt: string;
    createdAt: string;
  };
  user: AuthUser;
}

export interface LogoutResponse {
  success: true;
}

// Actor context returned by bearer resolution.
// Backward-compatible: user-session flows return actorType "user";
// API-key flows return actorType "service_principal".
export interface ActorContext {
  actorType: "user" | "service_principal";
  actorId: string;
  orgId?: string;
  projectId?: string | null;
  displayName?: string | null;
  email?: string | null;
}

// Extended session response with optional actor context.
// When `actor` is absent, the caller should infer actorType "user"
// from the existing `user` field for backward compatibility.
export interface BearerResolutionResponse {
  actor: ActorContext;
  session?: {
    id: string;
    expiresAt: string;
    createdAt: string;
  };
  user?: AuthUser;
}

// OAuth sign-in contracts.
//
// The `start` and `callback` routes are browser-redirect flows (not JSON
// endpoints), so they have no request/response body contract. The only JSON
// surface is the provider list, which lets the console render a sign-in button
// only for providers that are fully configured server-side.

export interface OAuthProviderInfo {
  /** Stable provider id used in the route path, e.g. "github". */
  id: string;
  /** Human-readable label for the sign-in button, e.g. "GitHub". */
  displayName: string;
}

export interface OAuthProvidersResponse {
  providers: OAuthProviderInfo[];
}

// Profile route contracts (self-scoped, user-session only)

export interface ProfileResponse {
  user: AuthUser;
}

export interface UpdateProfileRequest {
  /** Omit to leave unchanged (partial update). */
  displayName?: string | null;
  /** Omit to leave unchanged (partial update). */
  lastOrgSlug?: string | null;
}

// ---------------------------------------------------------------------------
// CLI session auth (saas-orun-platform OP1) — identity-worker `/v1/auth/cli/*`.
//
// Two human login doors, both resolving to the same CLI session kind:
//   - Browser loopback: `start` → console approval → single-use grant redeem.
//   - RFC-8628 device flow: `device/start` → `device/poll`.
// Plus rotating-refresh `token` (single-use; reuse ⇒ family revoked) and
// `revoke`. The access token is a short-lived (~15m) JWT; the refresh token is
// an opaque, rotating, hashed-at-rest secret (~30d). See design.md §3.1 and
// state-api-contract.md §1.
// ---------------------------------------------------------------------------

/** The org membership scope returned in a CLI session. `id` is what the CLI
 *  currently calls `allowedNamespaceIds`. */
export interface CliSessionOrg {
  /** Legacy `org_<hex>` id — kept as the back-compat namespace id. */
  id: string;
  /**
   * Durable, led-with public **Workspace ID** (`ws_…`, WID2's `public_ref`).
   * Surfaced alongside `id` so the CLI can lead with it and tokens can carry it
   * (`workspaceIds[]`). Optional for back-compat with older payloads.
   */
  workspaceRef?: string;
  slug: string;
  name: string;
  role: OrganizationRole;
}

/** Matches Orun's `SessionResponse`. The full payload returned when a CLI login
 *  completes (loopback redeem / device poll success). */
export interface CliSessionPayload {
  accessToken: string;
  expiresAt: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  orgs: CliSessionOrg[];
}

/** POST /v1/auth/cli/start — begin the browser-loopback flow. */
export interface CliStartRequest {
  /** Reported CLI host label, shown on the console approval page. */
  host?: string;
}

export interface CliStartResponse {
  /** Console page the CLI opens; the user approves there. */
  authorizeUrl: string;
  /** One-time code the CLI redeems (via `token`) after approval. */
  cliCode: string;
  expiresAt: string;
}

/** POST /v1/auth/cli/device/start — begin the RFC-8628 device flow. */
export interface CliDeviceStartRequest {
  host?: string;
}

export interface CliDeviceStartResponse {
  /** Machine-polled secret (sent back on `device/poll`). */
  deviceCode: string;
  /** Short, human-entered code the user types at the verification URL. */
  userCode: string;
  /** Console approval page where the user enters `userCode`. */
  verificationUrl: string;
  /** Suggested poll interval, seconds. */
  interval: number;
  expiresAt: string;
}

/** POST /v1/auth/cli/device/poll — poll for the device-flow result. */
export interface CliDevicePollRequest {
  deviceCode: string;
}

/** Device poll while the user has not yet approved. `error` mirrors RFC-8628
 *  (`authorization_pending` | `slow_down` | `access_denied` | `expired_token`). */
export interface CliDevicePollPendingResponse {
  status: "pending";
  error: "authorization_pending" | "slow_down";
}

export interface CliDevicePollCompleteResponse {
  status: "complete";
  session: CliSessionPayload;
}

export type CliDevicePollResponse =
  | CliDevicePollPendingResponse
  | CliDevicePollCompleteResponse;

/** POST /v1/auth/cli/token — exchange a grant or rotate a refresh token.
 *
 * Two modes:
 *   - `grantType: "cli_code"` with a `cliCode` (loopback redeem → full session).
 *   - `grantType: "refresh_token"` with a `refreshToken` (rotation).
 */
export interface CliTokenRequest {
  grantType: "cli_code" | "refresh_token";
  /** Required for grantType "cli_code". */
  cliCode?: string;
  /** Required for grantType "refresh_token". */
  refreshToken?: string;
}

/** Loopback redeem returns the full session; refresh rotation returns the new
 *  access + refresh pair. Modeled as the full session for both (the refresh
 *  response simply re-states the unchanged user/orgs). */
export type CliTokenResponse = CliSessionPayload;

/** POST /v1/auth/cli/revoke — log a CLI session out. */
export interface CliRevokeRequest {
  refreshToken: string;
}

export interface CliRevokeResponse {
  success: true;
}

/** A single CLI session for the console "Sessions & devices" surface. */
export interface CliSessionSummary {
  id: string;
  host: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ListCliSessionsResponse {
  sessions: CliSessionSummary[];
}

export interface RevokeCliSessionResponse {
  session: CliSessionSummary;
}

// ── GitHub Actions OIDC exchange (OV3) ──────────────────────

/**
 * POST /v1/auth/oidc/exchange — exchange a GitHub Actions OIDC JWT for a
 * short-lived platform workflow token. The CLI sends GitHub's OIDC token
 * (audience `orun-cloud`); the server resolves the repo to a linked
 * (org, project), gates on the link's CI settings, and mints the token.
 */
export interface OidcExchangeRequest {
  /** The GitHub Actions OIDC token (signed by token.actions.githubusercontent.com). */
  token: string;
  /**
   * Optional claimed org (slug or `org_…`) from intent.yaml, used to
   * disambiguate when the repo is linked across multiple orgs. Checked, not
   * trusted — must match one authorized link.
   */
  org?: string;
}

export interface OidcExchangeResponse {
  /** Short-lived (~15m) platform access token with actorKind "workflow". */
  accessToken: string;
  tokenType: "Bearer";
  /** Absolute expiry (ISO 8601). */
  expiresAt: string;
  /** Resolved binding (public ids). */
  orgId: string;
  /**
   * Durable Workspace ID (`ws_…`) of the resolved org, led-with alongside the
   * legacy `orgId` (WID5). Optional: omitted when the ref cannot be resolved.
   */
  workspaceId?: string;
  projectId: string;
}

/** Console-side approval of a pending loopback/device grant.
 *  POST /v1/auth/cli/grants/{grantId}/approve|deny. */
export interface CliGrantView {
  id: string;
  /** "oauth" rows back MCP3 authorization codes; they ride the same table. */
  flow: "loopback" | "device" | "oauth";
  host: string | null;
  status: "pending" | "approved" | "denied" | "redeemed" | "expired";
  expiresAt: string;
}

export interface GetCliGrantResponse {
  grant: CliGrantView;
}

export interface ApproveCliGrantResponse {
  grant: CliGrantView;
}

export interface DenyCliGrantResponse {
  grant: CliGrantView;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization for remote MCP clients (saas-mcp-server MCP3).
//
// identity-worker is the authorization server (rides the OP1 CLI-session
// machinery — an MCP grant mints a CLI-shaped session labeled `mcp:<clientId>`;
// no new token kind exists, risks R5). Client registration follows the D1
// decision (Option A, 2026-07-09): a static, code-reviewed allow-list of vetted
// PUBLIC clients — no open dynamic client registration. PKCE S256 is mandatory.
// ---------------------------------------------------------------------------

/** A vetted OAuth 2.1 public client (D1 Option A). */
export interface OAuthPublicClient {
  /** Stable client_id presented on the authorize/token requests. */
  clientId: string;
  /** Human-readable name rendered on the consent page + sessions list. */
  name: string;
  /**
   * Registered redirect URIs. Matching is EXACT, except loopback `http://`
   * URIs (host `127.0.0.1` or `localhost`), which match on any port per
   * RFC 8252 §7.3 (native apps bind an ephemeral loopback port).
   */
  redirectUris: readonly string[];
  /** Always true — the allow-list carries public (no-secret) clients only. */
  public: true;
}

/**
 * The static allow-list (D1 Option A). Amendments are ordinary code-reviewed
 * PRs; an unknown `client_id` or a non-matching `redirect_uri` is rejected
 * server-side and the user is NEVER redirected to an unregistered URI.
 */
export const OAUTH_PUBLIC_CLIENTS: readonly OAuthPublicClient[] = [
  {
    clientId: "claude-code",
    name: "Claude Code",
    // Loopback listener on an ephemeral port (RFC 8252 §7.3).
    redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    public: true,
  },
  {
    clientId: "claude-web",
    name: "Claude",
    redirectUris: [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
    ],
    public: true,
  },
  {
    clientId: "cursor",
    name: "Cursor",
    redirectUris: [
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "http://localhost/oauth/callback",
      "http://127.0.0.1/oauth/callback",
    ],
    public: true,
  },
  {
    clientId: "vscode",
    name: "Visual Studio Code",
    redirectUris: [
      "https://vscode.dev/redirect",
      "http://localhost/",
      "http://127.0.0.1/",
    ],
    public: true,
  },
  {
    // Local development / testing client — loopback only, never a hosted URI.
    clientId: "orun-cloud-dev",
    name: "Orun Cloud dev client",
    redirectUris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    public: true,
  },
];

export function findOAuthPublicClient(clientId: string): OAuthPublicClient | null {
  return OAUTH_PUBLIC_CLIENTS.find((c) => c.clientId === clientId) ?? null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Does a presented redirect_uri match a registered one? Exact string match,
 * with the single RFC 8252 §7.3 carve-out: for loopback `http://` URIs the
 * port is ignored (scheme, host, path, and query must still match exactly).
 */
export function oauthRedirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let reg: URL;
  let pres: URL;
  try {
    reg = new URL(registered);
    pres = new URL(presented);
  } catch {
    return false;
  }
  if (reg.protocol !== "http:" || pres.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.has(reg.hostname) || !LOOPBACK_HOSTS.has(pres.hostname)) return false;
  return (
    reg.hostname === pres.hostname &&
    reg.pathname === pres.pathname &&
    reg.search === pres.search &&
    pres.hash === "" &&
    reg.hash === ""
  );
}

export function isOAuthRedirectUriAllowed(client: OAuthPublicClient, redirectUri: string): boolean {
  return client.redirectUris.some((registered) => oauthRedirectUriMatches(registered, redirectUri));
}

// ---------------------------------------------------------------------------
// RFC 7591 Dynamic Client Registration (saas-mcp-server MCP11 leg B).
//
// Activates the D1 → Option B path (documented in the risks doc as "DCR behind
// rate limits + short-lived unused-client GC"): claude.ai's connector flow
// requires a `registration_endpoint`, so PUBLIC clients may now self-register
// into `identity.oauth_dynamic_clients`. Guardrails:
//   - public clients only (`token_endpoint_auth_method: "none"`; NO secrets
//     are ever minted or stored — registration mints CLIENTS, not tokens, R5);
//   - minted ids live in the `dcr_` namespace so a dynamic registration can
//     NEVER shadow a vetted static clientId (static allow-list resolves first);
//   - redirect URIs must be https non-loopback OR http loopback (RFC 8252
//     §7.3); matching reuses `oauthRedirectUriMatches` (exact, with the
//     loopback any-port carve-out only for loopback URIs);
//   - rows are TTL'd (~30d, refreshed on use) — the unused-client GC horizon;
//   - the console consent page labels dynamic clients "Unverified app".
// RFC 7592 (client update/delete management endpoints) is deliberately out of
// scope — unused registrations simply age out.
// ---------------------------------------------------------------------------

/** Namespace prefix of dynamically-registered client ids (`dcr_<hex32>`). */
export const OAUTH_DYNAMIC_CLIENT_ID_PREFIX = "dcr_";

export function isOAuthDynamicClientId(clientId: string): boolean {
  return clientId.startsWith(OAUTH_DYNAMIC_CLIENT_ID_PREFIX);
}

/** Registration limits (enforced server-side, mirrored in the DB CHECKs). */
export const OAUTH_DCR_MAX_REDIRECT_URIS = 10;
export const OAUTH_DCR_MAX_CLIENT_NAME_LENGTH = 100;
export const OAUTH_DCR_MAX_REDIRECT_URI_LENGTH = 2048;

export const OAUTH_SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
export const OAUTH_SUPPORTED_RESPONSE_TYPES = ["code"] as const;

/**
 * Is `uri` registrable by a DYNAMIC client? Stricter than the static
 * allow-list (which may carry vetted custom schemes like `cursor://`):
 * https on a non-loopback host, or http on a loopback host (RFC 8252 §7.3).
 * Fragments are forbidden (RFC 6749 §3.1.2).
 */
export function isRegistrableDynamicRedirectUri(uri: string): boolean {
  if (!uri || uri.length > OAUTH_DCR_MAX_REDIRECT_URI_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash !== "") return false;
  if (parsed.protocol === "https:") return !LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol === "http:") return LOOPBACK_HOSTS.has(parsed.hostname);
  return false;
}

/**
 * POST /v1/auth/oauth2/register — RFC 7591 §2 client metadata (the accepted
 * subset). Anything else in the body is ignored, EXCEPT a caller-chosen
 * `client_id`, which is rejected (ids are always server-minted `dcr_…`).
 */
export interface OAuthClientRegistrationRequest {
  client_name?: string;
  redirect_uris?: string[];
  /** Must be absent or "none" — public clients only. */
  token_endpoint_auth_method?: string;
  /** Must be within OAUTH_SUPPORTED_GRANT_TYPES when present. */
  grant_types?: string[];
  /** Must be within OAUTH_SUPPORTED_RESPONSE_TYPES when present. */
  response_types?: string[];
}

/** RFC 7591 §3.2.1 registration response (201, raw JSON — no envelope, and
 *  deliberately NO client_secret: public clients only). */
export interface OAuthClientRegistrationResponse {
  client_id: string;
  /** Seconds since the epoch (RFC 7591 §3.2.1). */
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

/** RFC 7591 §3.2.2 error body (400, raw JSON, `Cache-Control: no-store`). */
export type OAuthRegistrationErrorCode = "invalid_client_metadata" | "invalid_redirect_uri";

export interface OAuthRegistrationErrorResponse {
  error: OAuthRegistrationErrorCode;
  error_description?: string;
}

/**
 * GET /v1/auth/oauth2/client/{clientId} — public-safe client info for the
 * console consent page (platform envelope, unlike the raw RFC endpoints).
 * Static allow-list clients resolve first; `dcr_` ids resolve from the
 * dynamic table (unknown or expired → 404). `redirectUris` lets the console
 * keep the "never redirect to an unregistered URI" pre-check for dynamic
 * clients (the server remains the authority).
 */
export interface OAuthClientInfo {
  clientId: string;
  name: string;
  /** true when the client came from DCR — consent must render "Unverified app". */
  dynamic: boolean;
  redirectUris: string[];
}

export interface OAuthClientInfoResponse {
  client: OAuthClientInfo;
}

/**
 * POST /v1/auth/oauth2/authorize/complete — called by the console after the
 * signed-in user consents. Actor-authenticated (api-edge injects x-actor-*).
 * Mints a single-use, short-TTL (~60s) authorization code bound to
 * (clientId, redirectUri, codeChallenge, user).
 */
export interface OAuthAuthorizeCompleteRequest {
  clientId: string;
  redirectUri: string;
  /** PKCE code challenge — base64url(SHA-256(verifier)), 43 chars. */
  codeChallenge: string;
  /** Only S256 is supported (`plain` is rejected). */
  codeChallengeMethod: "S256";
  /** Requested scope, informational — OP1 tokens are workspace-agnostic. */
  scope?: string;
}

export interface OAuthAuthorizeCompleteResponse {
  /** The single-use authorization code to append to the redirect_uri. */
  code: string;
  /** Absolute code expiry (ISO 8601, ~60s). */
  expiresAt: string;
}

/**
 * POST /v1/auth/oauth2/token — the RFC 6749 token endpoint (public client,
 * `token_endpoint_auth_methods_supported: ["none"]`). The request body is
 * `application/x-www-form-urlencoded` per spec (JSON is also accepted); the
 * response is a RAW OAuth token JSON body, NOT the platform envelope.
 */
export interface OAuthTokenRequest {
  grant_type: "authorization_code" | "refresh_token";
  /** authorization_code: the code from the authorize redirect. */
  code?: string;
  /** authorization_code: must match the code's bound redirect_uri. */
  redirect_uri?: string;
  /** authorization_code: must match the code's bound client_id. */
  client_id?: string;
  /** authorization_code: the PKCE verifier for the bound S256 challenge. */
  code_verifier?: string;
  /** refresh_token: the current (single-use, rotating) refresh token. */
  refresh_token?: string;
}

export interface OAuthTokenSuccessResponse {
  /** Short-lived access JWT — same claims/TTL as the OP1 CLI access token. */
  access_token: string;
  token_type: "Bearer";
  /** Seconds until access_token expiry. */
  expires_in: number;
  /** The next rotating refresh token (single-use; reuse revokes the family). */
  refresh_token: string;
}

/** RFC 6749 §5.2 error body (400/401, `Cache-Control: no-store`). */
export type OAuthTokenErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "server_error";

export interface OAuthTokenErrorResponse {
  error: OAuthTokenErrorCode;
  error_description?: string;
}

/** GET /.well-known/oauth-authorization-server (RFC 8414), served raw (no envelope). */
export interface AuthorizationServerMetadata {
  issuer: string;
  /** The console consent page (browser navigation, not an API endpoint). */
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 7591 dynamic client registration endpoint (MCP11 leg B). */
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
}

/** GET /.well-known/oauth-protected-resource (RFC 9728) on the mcp-worker. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
}

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta: {
    requestId: string;
    cursor: string | null;
  };
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}
