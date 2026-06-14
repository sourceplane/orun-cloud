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
  id: string;
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

/** Console-side approval of a pending loopback/device grant.
 *  POST /v1/auth/cli/grants/{grantId}/approve|deny. */
export interface CliGrantView {
  id: string;
  flow: "loopback" | "device";
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
