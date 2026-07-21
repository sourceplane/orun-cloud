// Cloudflare adapter (saas-integration-hub IH5) — the credential-broker
// archetype, live. Two connect postures share ONE mint model (scoped child
// account-owned tokens: template-shaped policies, expires_on = now + clamped
// TTL, named `orun/{org}/{template}/{mintId}` for the IH9 orphan sweep):
//
//   connectKind "token"  — the customer pastes an account-scoped parent API
//     token once; the worker verifies it, discovers the account, the paste is
//     never re-shown. The durable credential is the pasted parent token.
//   connectKind "oauth"  — Cloudflare shipped OAuth clients for the API
//     (risks D3 resolved), so when an OAuth client is registered for the
//     environment the connect posture upgrades to OAuth 2 (PKCE), exactly like
//     Supabase (IH6). The durable credential is the OAuth REFRESH token; each
//     mint derives a short-lived access token from it (`grant_type=
//     refresh_token`) and uses THAT as the API bearer for the child-token
//     create — the access token is never stored durable.
//
// Custody rule (both postures): the durable credential (pasted parent token OR
// OAuth refresh token) lives ONLY as a provider_credentials envelope;
// everything minted from it is short-lived, scoped-down, ledgered, and
// revocable. The adapter never holds it — the broker handler decrypts custody
// per call and passes it as ParentCredentialContext. Where Cloudflare rotates
// the refresh token on use, the adapter surfaces the rotated token via
// `rotatedParentCredential` so the broker re-envelopes custody (a dropped
// rotation surfaces as parent_grant_insufficient on the NEXT mint — an IH9
// health concern, not data loss, the same tolerance as Supabase).

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import type { FetchLike } from "../github-app.js";
import type {
  CloudflareOauthCredentials,
  CredentialBrokerCapability,
  IntegrationProvider,
  MintCredentialOutcome,
  ParentCredentialContext,
  ProvisionCapability,
  ProvisionOutcome,
} from "./types.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare's OAuth-client authorization server (risks D3). The authorize
// screen lives on the dashboard; the token endpoint is the API host. These
// must match the redirect URL configured on the OAuth client.
const OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

/** Requesting a refresh token requires this scope; Cloudflare returns only an
 *  access token without it, and Orun's exchange fails closed with no refresh
 *  token to escrow. The adapter always ensures it is present. */
const OAUTH_OFFLINE_ACCESS_SCOPE = "offline_access";

/**
 * Dot-form OAuth scope per service-identity permission group. Cloudflare's
 * "OAuth scope names correspond to API token permission names" — observed
 * convention: kebab-case the group name, suffix `.read`/`.write` (the shipped
 * pair `account-settings.read`/`memberships.read` established it). The
 * provisioning bootstrap can only SEE the permission groups its scopes
 * grant, so the authorize request must carry the scope twin of every group
 * `serviceIdentityPermissionGroups()` requires — a narrower consent is what
 * makes provisioning fail `bootstrap_grant_insufficient` even for an account
 * owner.
 */
export const OAUTH_SCOPE_BY_PERMISSION_GROUP: Record<string, string | null> = {
  // VERIFIED against the live OAuth scope catalog (GET /client/v4/oauth/scopes,
  // 2026-07-17): the catalog has NO token-administration scope AT ALL — an
  // OAuth grant structurally cannot create API tokens, which is the final
  // SI-D1 answer: token-paste is Cloudflare's bootstrap; OAuth cannot be.
  "Account API Tokens Write": null,
  "Workers Scripts Write": "workers-scripts.write",
  "Workers KV Storage Write": "workers-kv-storage.write",
  "Pages Write": "page.write",
  "DNS Write": "dns.write",
  "Workers R2 Storage Write": "workers-r2.write",
  "Account Settings Read": "account-settings.read",
};

/** Whether a Cloudflare OAuth grant could ever provision the service
 *  identity: true only if EVERY required permission group has a scope twin
 *  in the catalog. False today (no token-administration scope exists) — the
 *  connect surfaces must offer token-paste as the bootstrap, and this flag
 *  flips the OAuth affordances back on if Cloudflare ever ships the scope. */
export const CLOUDFLARE_OAUTH_CAN_PROVISION = Object.values(
  OAUTH_SCOPE_BY_PERMISSION_GROUP,
).every((scope) => scope !== null);

/**
 * Fallback scope when `CLOUDFLARE_OAUTH_SCOPE` is unset.
 *
 * Cloudflare self-managed clients grant the access token ONLY the scopes the
 * authorize request asks for (the token does NOT auto-inherit the client's full
 * scope set — the live SI-D1 incident: a 2-permission consent made an account
 * OWNER's grant unable to create tokens). Scope strings are the client's own
 * dot-form (`account-settings.read`), NOT wrangler's colon-form (`account:read`
 * → invalid_scope). `openid`/`offline_access` are protocol scopes; we request
 * `offline_access` to obtain the refresh token used inside the bootstrap.
 *
 * The default therefore requests the FULL provisioning set: account discovery
 * (`account-settings.read` + `memberships.read`) plus the scope twin of every
 * service-identity permission group — so an unset `CLOUDFLARE_OAUTH_SCOPE`
 * yields a consent whose grant can actually provision. The requested scopes
 * must be registered on the OAuth client; a client registered narrower fails
 * the authorize redirect with `invalid_scope`, and `CLOUDFLARE_OAUTH_SCOPE`
 * remains the per-environment override to narrow (or correct) the request.
 */
export const CLOUDFLARE_DEFAULT_OAUTH_SCOPE = [
  ...new Set([
    "account-settings.read",
    "memberships.read",
    ...Object.values(OAUTH_SCOPE_BY_PERMISSION_GROUP).filter((s): s is string => s !== null),
  ]),
].join(" ");

/**
 * Normalize a requested scope string into the exact `scope` value to send:
 * trim, collapse whitespace, drop duplicates, and guarantee `offline_access`
 * is present (appended last so the ordering stays stable for tests). Falsy or
 * blank input falls back to the minimal mint-only default.
 */
export function resolveCloudflareOauthScope(requested?: string): string {
  const base = requested && requested.trim() ? requested : CLOUDFLARE_DEFAULT_OAUTH_SCOPE;
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const token of base.split(/\s+/)) {
    if (!token || token === OAUTH_OFFLINE_ACCESS_SCOPE || seen.has(token)) continue;
    seen.add(token);
    scopes.push(token);
  }
  scopes.push(OAUTH_OFFLINE_ACCESS_SCOPE);
  return scopes.join(" ");
}

/** Default mint TTL (risks D5): 15 minutes; hard ceiling one hour. */
export const CLOUDFLARE_DEFAULT_TTL_SECONDS = 15 * 60;
export const CLOUDFLARE_MAX_TTL_SECONDS = 60 * 60;

/**
 * The v1 template catalog (design §5.2). Descriptions state the EFFECTIVE
 * breadth honestly (risks R5). Minted tokens are named
 * `orun/{org}/{template}/{mintId}` provider-side so the IH9 orphan sweep can
 * reconcile ledger truth against the Cloudflare account.
 */
export const CLOUDFLARE_SCOPE_TEMPLATES: readonly IntegrationScopeTemplate[] = [
  {
    id: "workers-deploy",
    provider: "cloudflare",
    version: 1,
    displayName: "Deploy Workers",
    description:
      "Edit Workers scripts and KV in the connected account, plus account read. No DNS, no R2, no billing.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "pages-deploy",
    provider: "cloudflare",
    version: 1,
    displayName: "Deploy Pages",
    description: "Edit Pages projects in the connected account, plus account read.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "dns-edit",
    provider: "cloudflare",
    version: 1,
    displayName: "Edit DNS",
    description: "Edit DNS records in the named zones only (zoneIds param required).",
    params: ["zoneIds"],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "r2-data",
    provider: "cloudflare",
    version: 1,
    displayName: "R2 data access",
    description: "Read/write R2 objects in the connected account's buckets.",
    params: ["buckets"],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "account-read",
    provider: "cloudflare",
    version: 1,
    displayName: "Account read",
    description: "Read-only access to account settings, Workers, and zones.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
] as const;

/** Verified parent-token facts (`GET /user/tokens/verify`). Null = the
 *  paste is not a live Cloudflare token — callers fail closed. */
export interface CloudflareTokenVerification {
  tokenId: string;
  status: string;
  expiresOn: string | null;
}

async function verifyTokenAt(
  url: string,
  bearer: string,
  fetchImpl: FetchLike,
): Promise<CloudflareTokenVerification | null> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      result?: { id?: unknown; status?: unknown; expires_on?: unknown };
    };
    if (body.success !== true || typeof body.result?.id !== "string") return null;
    return {
      tokenId: body.result.id,
      status: typeof body.result.status === "string" ? body.result.status : "unknown",
      expiresOn: typeof body.result.expires_on === "string" ? body.result.expires_on : null,
    };
  } catch {
    return null;
  }
}

export async function verifyCloudflareParentToken(
  parentToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareTokenVerification | null> {
  return verifyTokenAt(`${API_BASE}/user/tokens/verify`, parentToken, fetchImpl);
}

/** ACCOUNT-OWNED tokens cannot call `/user/*` — they verify via the account
 *  endpoint. Cloudflare has two parallel API-token surfaces (user-owned vs
 *  account-owned); a paste may be either, and the org-owned account kind is
 *  the better fit for the service-identity model. */
export async function verifyCloudflareAccountToken(
  parentToken: string,
  accountId: string,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareTokenVerification | null> {
  return verifyTokenAt(`${API_BASE}/accounts/${accountId}/tokens/verify`, parentToken, fetchImpl);
}

/** Verify a pasted token of EITHER ownership: user endpoint first (the
 *  historical posture), then the account endpoint (account-owned tokens get
 *  401 from `/user/*`). Callers supply the account id from discovery. */
export async function verifyCloudflareTokenEitherOwnership(
  parentToken: string,
  accountId: string,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareTokenVerification | null> {
  const asUserToken = await verifyCloudflareParentToken(parentToken, fetchImpl);
  if (asUserToken) return asUserToken;
  return verifyCloudflareAccountToken(parentToken, accountId, fetchImpl);
}

/** The account behind the parent token (`GET /accounts`) — the connection's
 *  external anchor. Null when the token can see no account. */
export async function discoverCloudflareAccount(
  parentToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accountExternalId: string; accountName: string | null } | null> {
  try {
    const response = await fetchImpl(`${API_BASE}/accounts?per_page=1`, {
      method: "GET",
      headers: { authorization: `Bearer ${parentToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      result?: Array<{ id?: unknown; name?: unknown }>;
    };
    const account = Array.isArray(body.result) ? body.result[0] : undefined;
    if (body.success !== true || typeof account?.id !== "string") return null;
    return {
      accountExternalId: account.id,
      accountName: typeof account.name === "string" ? account.name : null,
    };
  } catch {
    return null;
  }
}

/** Orphan sweep (IH9): the platform-named tokens on the account. Paginated;
 *  null on any API failure — callers leave the ledger untouched. */
export async function listCloudflareAccountTokens(
  parent: ParentCredentialContext,
  fetchImpl: FetchLike = fetch,
): Promise<Array<{ id: string; name: string; status: string; expiresOn: string | null }> | null> {
  const accountId = parent.externalRef;
  if (!accountId) return null;
  const tokens: Array<{ id: string; name: string; status: string; expiresOn: string | null }> = [];
  try {
    // Defensive page cap: 10 pages × 50 tokens is far beyond any real sweep.
    for (let page = 1; page <= 10; page++) {
      const response = await fetchImpl(
        `${API_BASE}/accounts/${accountId}/tokens?page=${page}&per_page=50`,
        { method: "GET", headers: { authorization: `Bearer ${parent.credential}` } },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as {
        success?: boolean;
        result?: Array<{ id?: unknown; name?: unknown; status?: unknown; expires_on?: unknown }>;
        result_info?: { page?: unknown; total_pages?: unknown };
      };
      if (body.success !== true || !Array.isArray(body.result)) return null;
      for (const token of body.result) {
        if (typeof token.id !== "string") continue;
        tokens.push({
          id: token.id,
          name: typeof token.name === "string" ? token.name : "",
          status: typeof token.status === "string" ? token.status : "unknown",
          expiresOn: typeof token.expires_on === "string" ? token.expires_on : null,
        });
      }
      const totalPages =
        typeof body.result_info?.total_pages === "number" ? body.result_info.total_pages : 1;
      if (page >= totalPages) break;
    }
    return tokens;
  } catch {
    return null;
  }
}

/** Health cron (IH9): best-effort read of the parent token's own policy set
 *  (`GET /user/tokens/{id}`, falling back to the account-scoped twin for
 *  ACCOUNT-OWNED tokens). Null = leave granted_policies unchanged. */
export async function getCloudflareTokenPolicies(
  parentToken: string,
  tokenId: string,
  fetchImpl: FetchLike = fetch,
  accountId?: string | null,
): Promise<unknown[] | null> {
  const endpoints = [
    `${API_BASE}/user/tokens/${tokenId}`,
    ...(accountId ? [`${API_BASE}/accounts/${accountId}/tokens/${tokenId}`] : []),
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { authorization: `Bearer ${parentToken}` },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        success?: boolean;
        result?: { policies?: unknown };
      };
      if (body.success !== true || !Array.isArray(body.result?.policies)) continue;
      return body.result.policies;
    } catch {
      // try the next surface
    }
  }
  return null;
}

// ── OAuth connect (connectKind "oauth", risks D3) ───────────

/**
 * The PKCE authorize URL carrying our signed single-use state. The
 * `cloudflare_account ↔ org_id` keystone rides this state, never inference —
 * the same discipline as Supabase (IH6).
 */
export function buildCloudflareAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri: string;
  codeChallenge?: string;
  /** Requested scopes; normalized via `resolveCloudflareOauthScope` (which
   *  guarantees `offline_access`). Cloudflare rejects a scope-less request. */
  scope?: string;
}): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", resolveCloudflareOauthScope(input.scope));
  url.searchParams.set("state", input.state);
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Verified grant from the PKCE code exchange. The refresh token is
 *  custody-envelope material ONLY; the access token is short-lived. */
export interface CloudflareOauthGrant {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function parseCloudflareTokenResponse(
  payload: Record<string, unknown>,
): CloudflareOauthGrant | null {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }
  return { accessToken, refreshToken, expiresIn };
}

/**
 * Exchange the callback's code for the token pair (`POST` the OAuth token
 * endpoint, PKCE: the code_verifier must match the challenge the authorize
 * URL carried). Null on any failure — callers fail closed.
 */
export async function exchangeCloudflareOauthCode(
  credentials: CloudflareOauthCredentials,
  input: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareOauthGrant | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  try {
    const response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) return null;
    return parseCloudflareTokenResponse((await response.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Derive a fresh short-lived access token from the refresh token
 * (`grant_type=refresh_token`). Cloudflare MAY rotate the refresh token on
 * use — the returned `refreshToken` is the rotated one (falling back to the
 * input when the response omits it) and MUST replace custody when it differs.
 * Null = the provider refused (the grant was revoked provider-side) — callers
 * fail closed.
 */
export async function refreshCloudflareAccess(
  credentials: CloudflareOauthCredentials,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareOauthGrant | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
  });
  let payload: Record<string, unknown>;
  try {
    const response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) return null;
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }
  const rotated = payload.refresh_token;
  return {
    accessToken,
    refreshToken: typeof rotated === "string" && rotated ? rotated : refreshToken,
    expiresIn,
  };
}

/** Permission-group NAMES per template. Resolved to ids at mint time via the
 *  parent token's own permission-group listing — never hardcoded ids. A name
 *  the account cannot see is a `parent_grant_insufficient` (deny-by-default:
 *  template ⊄ parent grant). */
const TEMPLATE_PERMISSION_GROUPS: Record<string, readonly string[]> = {
  "workers-deploy": ["Workers Scripts Write", "Workers KV Storage Write", "Account Settings Read"],
  "pages-deploy": ["Pages Write", "Account Settings Read"],
  "dns-edit": ["DNS Write"],
  "r2-data": ["Workers R2 Storage Write"],
  "account-read": ["Account Settings Read"],
};

function templateResources(
  template: string,
  params: Record<string, unknown>,
  accountExternalId: string,
): Record<string, string> | null {
  if (template === "dns-edit") {
    const zoneIds = Array.isArray(params.zoneIds)
      ? params.zoneIds.filter((z): z is string => typeof z === "string" && /^[0-9a-f]{32}$/.test(z))
      : [];
    if (zoneIds.length === 0) return null;
    const resources: Record<string, string> = {};
    for (const zoneId of zoneIds) resources[`com.cloudflare.api.account.zone.${zoneId}`] = "*";
    return resources;
  }
  return { [`com.cloudflare.api.account.${accountExternalId}`]: "*" };
}

/**
 * Compact, secret-free failure detail for a Cloudflare API error: the HTTP
 * status plus EVERY error message Cloudflare returned (not just the first),
 * bounded to 600 chars. Fed into the `mint_failed` event (operator telemetry);
 * never contains a token or value. Widened from the earlier 120-char, first-
 * message-only form, which truncated Cloudflare's "these rules must pass for
 * …" policy-validation text mid-sentence and hid which rule failed.
 */
function cfErrorDetail(status: number, errors?: Array<{ message?: unknown }>): string {
  const msgs = (errors ?? [])
    .map((e) => (typeof e?.message === "string" ? e.message : ""))
    .filter(Boolean)
    .join("; ");
  return `http_${status}${msgs ? `: ${msgs}` : ""}`.slice(0, 600);
}

async function mintCloudflareToken(
  input: {
    template: string;
    params: Record<string, unknown>;
    ttlSeconds: number;
    nowMs: number;
    parent: ParentCredentialContext;
    mintRef: string;
  },
  fetchImpl: FetchLike,
): Promise<MintCredentialOutcome> {
  const accountId = input.parent.externalRef;
  if (!accountId) return { ok: false, reason: "provider_error", detail: "no account anchor" };

  const groupNames = TEMPLATE_PERMISSION_GROUPS[input.template];
  if (!groupNames) return { ok: false, reason: "template_unknown" };
  const resources = templateResources(input.template, input.params, accountId);
  if (!resources) {
    return { ok: false, reason: "provider_error", detail: "dns-edit requires zoneIds (32-hex ids)" };
  }

  // Resolve the template's group NAMES against what the parent can see —
  // the template ⊆ parent-grant check, deny-by-default. The user endpoint
  // serves user-owned bearers; ACCOUNT-OWNED tokens 401 there and answer on
  // the account-scoped twin, so try both.
  let groups: Array<{ id: string; name: string }> | null = null;
  let lastDetail = "permission_groups unavailable";
  for (const endpoint of [
    `${API_BASE}/user/tokens/permission_groups`,
    `${API_BASE}/accounts/${accountId}/tokens/permission_groups`,
  ]) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { authorization: `Bearer ${input.parent.credential}` },
      });
      if (!response.ok) {
        lastDetail = `permission_groups http_${response.status}`;
        continue;
      }
      const body = (await response.json()) as {
        success?: boolean;
        result?: Array<{ id?: unknown; name?: unknown }>;
      };
      if (body.success !== true || !Array.isArray(body.result)) {
        lastDetail = "permission_groups unavailable";
        continue;
      }
      groups = body.result.filter(
        (g): g is { id: string; name: string } => typeof g.id === "string" && typeof g.name === "string",
      );
      break;
    } catch {
      lastDetail = "permission_groups network_error";
    }
  }
  if (groups === null) {
    return { ok: false, reason: "provider_error", detail: lastDetail };
  }
  const byName = new Map(groups.map((g) => [g.name, g.id]));
  const missing = groupNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return { ok: false, reason: "parent_grant_insufficient", detail: `missing: ${missing.join(", ")}` };
  }

  const expiresOn = new Date(input.nowMs + input.ttlSeconds * 1000);
  try {
    const response = await fetchImpl(`${API_BASE}/accounts/${accountId}/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.parent.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: input.mintRef,
        expires_on: expiresOn.toISOString(),
        policies: [
          {
            effect: "allow",
            resources,
            permission_groups: groupNames.map((name) => ({ id: byName.get(name)! })),
          },
        ],
      }),
    });
    const body = (await response.json()) as {
      success?: boolean;
      result?: { id?: unknown; value?: unknown };
      errors?: Array<{ message?: unknown }>;
    };
    if (!response.ok || body.success !== true || typeof body.result?.value !== "string") {
      const detail = cfErrorDetail(response.status, body.errors);
      // A 403 on token creation is the parent grant refusing (needs
      // "Account API Tokens: Edit") — surface it as such, not as a 5xx.
      return response.status === 403
        ? { ok: false, reason: "parent_grant_insufficient", detail }
        : { ok: false, reason: "provider_error", detail };
    }
    return {
      ok: true,
      value: {
        credential: { token: body.result.value },
        providerRef: typeof body.result.id === "string" ? body.result.id : null,
        expiresAt: expiresOn,
      },
    };
  } catch {
    return { ok: false, reason: "provider_error", detail: "mint network_error" };
  }
}

// ── Service-identity provisioning (SI2, sub-epics/service-identity-bootstrap) ──

/** The permission the service identity needs ON TOP of the template union so
 *  it can mint child tokens and roll its own value — the paste-posture
 *  "Account API Tokens: Edit" requirement, provisioned instead of asked for. */
const SERVICE_IDENTITY_ADMIN_GROUP = "Account API Tokens Write";

/** Every permission-group NAME the service identity must carry: the union of
 *  the template catalog (so `template ⊆ parent grant` holds for all published
 *  templates) plus token administration. */
export function serviceIdentityPermissionGroups(): readonly string[] {
  const names = new Set<string>([SERVICE_IDENTITY_ADMIN_GROUP]);
  for (const groups of Object.values(TEMPLATE_PERMISSION_GROUPS)) {
    for (const name of groups) names.add(name);
  }
  return [...names];
}

/**
 * Create the durable ACCOUNT-OWNED service token from a bootstrap bearer (the
 * OAuth access token): resolve the required permission-group names against
 * what the bootstrap grant can see (deny-by-default — a missing name is
 * `bootstrap_grant_insufficient`, the SI-D1 guided-paste branch, NEVER a
 * partial identity), then `POST /accounts/{id}/tokens` with NO expiry (the
 * platform rotates it on schedule) and verify the result.
 */
export async function provisionCloudflareServiceIdentity(
  input: {
    bootstrapCredential: string;
    externalRef: string | null;
    identityRef: string;
    nowMs: number;
  },
  fetchImpl: FetchLike = fetch,
): Promise<ProvisionOutcome> {
  const accountId = input.externalRef;
  if (!accountId) return { ok: false, reason: "provider_error", detail: "no account anchor" };

  let byName: Map<string, string>;
  try {
    const response = await fetchImpl(`${API_BASE}/user/tokens/permission_groups`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.bootstrapCredential}` },
    });
    if (!response.ok) {
      // The bootstrap bearer cannot even enumerate groups — treat as an
      // insufficient grant (fall back to refresh custody), not an outage.
      return response.status === 401 || response.status === 403
        ? { ok: false, reason: "bootstrap_grant_insufficient", detail: `permission_groups http_${response.status}` }
        : { ok: false, reason: "provider_error", detail: `permission_groups http_${response.status}` };
    }
    const body = (await response.json()) as {
      success?: boolean;
      result?: Array<{ id?: unknown; name?: unknown }>;
    };
    if (body.success !== true || !Array.isArray(body.result)) {
      return { ok: false, reason: "provider_error", detail: "permission_groups unavailable" };
    }
    byName = new Map(
      body.result
        .filter((g): g is { id: string; name: string } => typeof g.id === "string" && typeof g.name === "string")
        .map((g) => [g.name, g.id]),
    );
  } catch {
    return { ok: false, reason: "provider_error", detail: "permission_groups network_error" };
  }

  const required = serviceIdentityPermissionGroups();
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "bootstrap_grant_insufficient",
      detail: `missing: ${missing.join(", ")}`.slice(0, 200),
    };
  }

  try {
    const response = await fetchImpl(`${API_BASE}/accounts/${accountId}/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.bootstrapCredential}`,
        "content-type": "application/json",
      },
      // Deliberately NO expires_on: the identity is durable and rotated by
      // the platform (SI5 cron), never re-consented by a human.
      body: JSON.stringify({
        name: input.identityRef,
        policies: [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            permission_groups: required.map((name) => ({ id: byName.get(name)! })),
          },
        ],
      }),
    });
    const body = (await response.json()) as {
      success?: boolean;
      result?: { id?: unknown; value?: unknown };
      errors?: Array<{ message?: unknown }>;
    };
    if (!response.ok || body.success !== true || typeof body.result?.value !== "string") {
      const detail = cfErrorDetail(response.status, body.errors);
      return response.status === 403
        ? { ok: false, reason: "bootstrap_grant_insufficient", detail }
        : { ok: false, reason: "provider_error", detail };
    }
    return {
      ok: true,
      value: {
        credential: body.result.value,
        kind: "cloudflare_service_token",
        // Custody anchors on the ACCOUNT (the mint path's bearer anchor);
        // the token's own id goes to provider facts for verify/rotate/revoke.
        externalRef: accountId,
        providerRef: typeof body.result.id === "string" ? body.result.id : null,
        expiresAt: null,
        scopes: required as unknown[],
      },
    };
  } catch {
    return { ok: false, reason: "provider_error", detail: "provision network_error" };
  }
}

/** Roll the service token's secret value in place
 *  (`PUT /accounts/{id}/tokens/{tokenId}/value`) using the CURRENT value as
 *  the bearer — scheduled rotation, no human, same token id. */
export async function rotateCloudflareServiceIdentity(
  input: { current: ParentCredentialContext; providerRef: string; nowMs: number },
  fetchImpl: FetchLike = fetch,
): Promise<ProvisionOutcome> {
  const accountId = input.current.externalRef;
  if (!accountId) return { ok: false, reason: "provider_error", detail: "no account anchor" };
  try {
    const response = await fetchImpl(
      `${API_BASE}/accounts/${accountId}/tokens/${input.providerRef}/value`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${input.current.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    const body = (await response.json()) as {
      success?: boolean;
      result?: unknown;
      errors?: Array<{ message?: unknown }>;
    };
    if (!response.ok || body.success !== true || typeof body.result !== "string") {
      const detail = cfErrorDetail(response.status, body.errors);
      return { ok: false, reason: "provider_error", detail };
    }
    return {
      ok: true,
      value: {
        credential: body.result,
        kind: "cloudflare_service_token",
        externalRef: accountId,
        providerRef: input.providerRef,
        expiresAt: null,
      },
    };
  } catch {
    return { ok: false, reason: "provider_error", detail: "rotate network_error" };
  }
}

/** Fail-fast template/param validation that must run BEFORE any OAuth refresh —
 *  a refresh may rotate (consume) the parent, so a doomed mint must be refused
 *  before spending it. Returns a failure outcome, or null when the request is
 *  shaped correctly. Mirrors the checks mintCloudflareToken makes internally. */
function precheckMintInput(
  template: string,
  params: Record<string, unknown>,
  accountExternalId: string | null,
): MintCredentialOutcome | null {
  if (!CLOUDFLARE_SCOPE_TEMPLATES.some((t) => t.id === template)) {
    return { ok: false, reason: "template_unknown" };
  }
  if (!TEMPLATE_PERMISSION_GROUPS[template]) {
    return { ok: false, reason: "template_unknown" };
  }
  if (!accountExternalId) {
    return { ok: false, reason: "provider_error", detail: "no account anchor" };
  }
  if (templateResources(template, params, accountExternalId) === null) {
    return { ok: false, reason: "provider_error", detail: "dns-edit requires zoneIds (32-hex ids)" };
  }
  return null;
}

/**
 * Create the Cloudflare adapter. When `oauthCredentials` is supplied the
 * environment has a registered OAuth client (risks D3), so the adapter is
 * OAuth-kind: connect runs PKCE and the durable custody credential is the
 * OAuth refresh token. Without it the adapter is token-paste kind (the pasted
 * parent token is the durable credential). Both postures mint the SAME scoped
 * child tokens — only the API bearer's source differs.
 */
export function createCloudflareProvider(
  fetchImpl: FetchLike = fetch,
  oauthCredentials?: CloudflareOauthCredentials,
): IntegrationProvider {
  const broker: CredentialBrokerCapability = {
    scopeTemplates() {
      return CLOUDFLARE_SCOPE_TEMPLATES;
    },
    async mintCredential(input) {
      const known = CLOUDFLARE_SCOPE_TEMPLATES.some((t) => t.id === input.template);
      if (!known) return { ok: false, reason: "template_unknown" };
      if (!input.parent) {
        return { ok: false, reason: "provider_error", detail: "parent credential missing" };
      }

      // Posture dispatch is PER CREDENTIAL KIND (SI2), never per environment:
      // a provisioned service token and a pasted parent token ARE the API
      // bearer; only the deprecated refresh-token custody enters the refresh
      // flow. An un-kinded parent (legacy callers/tests) keeps the historic
      // environment-driven behavior.
      const directBearer =
        input.parent.kind === "cloudflare_service_token" ||
        input.parent.kind === "cloudflare_parent_token" ||
        (!oauthCredentials && input.parent.kind === undefined);
      if (directBearer) {
        return mintCloudflareToken(
          {
            template: input.template,
            params: input.params,
            ttlSeconds: input.ttlSeconds,
            nowMs: input.nowMs,
            parent: input.parent,
            mintRef: input.mintRef ?? "orun/unnamed-mint",
          },
          fetchImpl,
        );
      }
      if (!oauthCredentials) {
        // A refresh-token custody row without an OAuth client cannot be
        // exercised — surface as the parent being unusable.
        return { ok: false, reason: "parent_grant_insufficient", detail: "no oauth client for refresh custody" };
      }

      // OAuth posture: the parent credential is the REFRESH token. Validate the
      // request BEFORE the refresh (which may rotate/consume the parent), then
      // derive a short-lived access token and use it as the API bearer.
      const precheck = precheckMintInput(input.template, input.params, input.parent.externalRef);
      if (precheck) return precheck;

      const refreshed = await refreshCloudflareAccess(
        oauthCredentials,
        input.parent.credential,
        fetchImpl,
      );
      if (!refreshed) {
        // A refused refresh means the grant was revoked provider-side — the
        // parent can no longer cover ANY template.
        return { ok: false, reason: "parent_grant_insufficient", detail: "refresh refused" };
      }

      const outcome = await mintCloudflareToken(
        {
          template: input.template,
          params: input.params,
          ttlSeconds: input.ttlSeconds,
          nowMs: input.nowMs,
          // The freshly-derived access token is the API bearer; the account
          // anchor rides through from custody.
          parent: { credential: refreshed.accessToken, externalRef: input.parent.externalRef },
          mintRef: input.mintRef ?? "orun/unnamed-mint",
        },
        fetchImpl,
      );

      // Surface a rotated refresh token so the broker re-envelopes custody.
      if (outcome.ok && refreshed.refreshToken !== input.parent.credential) {
        outcome.value.rotatedParentCredential = refreshed.refreshToken;
      }
      return outcome;
    },
    async revokeCredential(providerRef, _nowMs, parent): Promise<boolean> {
      if (!parent?.externalRef) return false;
      // Child tokens are account-owned; deleting them needs an account-scoped
      // API bearer. Service/parent tokens hand one directly (kind dispatch,
      // SI2); only refresh custody must derive one first (best-effort — TTL
      // is the backstop).
      let apiToken = parent.credential;
      const isRefresh =
        parent.kind === "cloudflare_refresh_token" ||
        (parent.kind === undefined && Boolean(oauthCredentials));
      if (isRefresh) {
        if (!oauthCredentials) return false;
        const refreshed = await refreshCloudflareAccess(oauthCredentials, parent.credential, fetchImpl);
        if (!refreshed) return false;
        apiToken = refreshed.accessToken;
      }
      try {
        const response = await fetchImpl(
          `${API_BASE}/accounts/${parent.externalRef}/tokens/${providerRef}`,
          { method: "DELETE", headers: { authorization: `Bearer ${apiToken}` } },
        );
        return response.ok;
      } catch {
        return false;
      }
    },
  };

  // Service-identity lifecycle (SI2): the bootstrap bearer provisions the
  // durable account-owned token; rotation rolls it in place; revoke deletes
  // it provider-side (which also kills every outstanding child).
  const provision: ProvisionCapability = {
    provisionServiceIdentity(input) {
      return provisionCloudflareServiceIdentity(input, fetchImpl);
    },
    rotateServiceIdentity(input) {
      return rotateCloudflareServiceIdentity(input, fetchImpl);
    },
    async revokeServiceIdentity(current, providerRef) {
      if (!current.externalRef) return false;
      try {
        const response = await fetchImpl(
          `${API_BASE}/accounts/${current.externalRef}/tokens/${providerRef}`,
          { method: "DELETE", headers: { authorization: `Bearer ${current.credential}` } },
        );
        return response.ok;
      } catch {
        return false;
      }
    },
  };

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    connectKind: oauthCredentials ? "oauth" : "token",
    capabilities: ["connect", "credential-broker"],

    broker,
    provision,

    ...(oauthCredentials
      ? {
          buildAuthorizeUrl(input) {
            return buildCloudflareAuthorizeUrl({
              clientId: oauthCredentials.clientId,
              state: input.state,
              redirectUri: input.redirectUri,
              ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}),
              ...(oauthCredentials.scope ? { scope: oauthCredentials.scope } : {}),
            });
          },
        }
      : {}),
  };
}
