// OAuth 2.1 authorization-server endpoints for remote MCP clients
// (saas-mcp-server MCP3).
//
// Three surfaces, all riding the shipped OP1 CLI-session machinery — an MCP
// grant IS a CLI-shaped session with an `mcp:<clientId>` label (risks R5: no
// second token plane):
//   - GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata; raw
//     JSON, public, no envelope)
//   - POST /v1/auth/oauth2/authorize/complete       (internal, console-called
//     after consent; actor-authenticated like the other session routes;
//     platform envelope)
//   - POST /v1/auth/oauth2/token                    (RFC 6749 token endpoint;
//     public client — auth method "none"; form-encoded request, RAW OAuth
//     JSON response, errors per §5.2)
//
// Client registration (MCP11 leg B — D1 → Option B activated on its
// documented path): the vetted public-client allow-list (Option A) remains
// and ALWAYS resolves first; `POST /v1/auth/oauth2/register` (RFC 7591)
// additionally mints `dcr_…` PUBLIC clients into
// `identity.oauth_dynamic_clients` (TTL'd, unused-client GC; no secrets —
// registration mints clients, not tokens, risks R5). PKCE S256 is mandatory.
// Codes/verifiers/tokens are NEVER logged; redirect URIs are never logged at
// error level.

import type { Env } from "../env.js";
import type {
  AuthorizationServerMetadata,
  OAuthAuthorizeCompleteResponse,
  OAuthClientInfoResponse,
  OAuthClientRegistrationRequest,
  OAuthClientRegistrationResponse,
  OAuthRegistrationErrorCode,
  OAuthTokenErrorCode,
  OAuthTokenSuccessResponse,
} from "@saas/contracts/auth";
import {
  OAUTH_DCR_MAX_CLIENT_NAME_LENGTH,
  OAUTH_DCR_MAX_REDIRECT_URIS,
  OAUTH_SUPPORTED_GRANT_TYPES,
  OAUTH_SUPPORTED_RESPONSE_TYPES,
  isRegistrableDynamicRedirectUri,
} from "@saas/contracts/auth";
import { successResponse, errorResponse, validationError } from "../http.js";
import { consoleBaseUrl } from "../services/cli-auth.js";
import { isValidCodeVerifier, isValidS256Challenge } from "../oauth2/pkce.js";
import {
  OAUTH_DYNAMIC_CLIENT_GC_LIMIT,
  OAUTH_DYNAMIC_CLIENT_TTL_MS,
  resolveOAuthClient,
  resolvedRedirectUriAllowed,
} from "../oauth2/clients.js";
import { generateOAuthDynamicClientId } from "../cli/secrets.js";
import { extractRequestContext } from "../request-context.js";
import { generateSecurityEventId, parseSubjectUuid } from "../ids.js";
import { withRepo, makeService, type CliAuthDeps } from "./cli-auth.js";

/** The public issuer identifier: the api-edge origin fronting this worker
 *  (RFC 8414 — metadata is served at issuer + /.well-known/...). */
function issuerBaseUrl(env: Env): string | null {
  const raw = env.OAUTH_REDIRECT_BASE_URL;
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// GET /.well-known/oauth-authorization-server (RFC 8414)
// ---------------------------------------------------------------------------

export function handleOAuth2AuthorizationServerMetadata(env: Env, requestId: string): Response {
  const issuer = issuerBaseUrl(env);
  if (!issuer) {
    return errorResponse("internal_error", "OAuth authorization server is not configured", 503, requestId);
  }
  const metadata: AuthorizationServerMetadata = {
    issuer,
    // Browser navigation target: the console consent page (design: console-
    // rendered consent; the console calls authorize/complete after approval).
    authorization_endpoint: `${consoleBaseUrl(env)}/oauth/authorize`,
    token_endpoint: `${issuer}/v1/auth/oauth2/token`,
    // RFC 7591 DCR (MCP11 leg B) — claude.ai's connector flow requires this.
    registration_endpoint: `${issuer}/v1/auth/oauth2/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
  // Raw RFC 8414 JSON — deliberately NOT the platform envelope (clients
  // resolve this by spec shape). Cacheable: it only changes on deploy.
  return Response.json(metadata, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/oauth2/authorize/complete (console-internal, authenticated)
// ---------------------------------------------------------------------------

export async function handleOAuth2AuthorizeComplete(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CliAuthDeps,
): Promise<Response> {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) {
    return errorResponse("unauthorized", "Unauthorized", 401, requestId);
  }
  const actorUuid = parseSubjectUuid(subjectId);
  if (!actorUuid || subjectType !== "user") {
    return errorResponse("forbidden", "Only users can authorize MCP clients", 403, requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  if (body === null || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be an object"] });
  }

  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : "";
  const codeChallenge = typeof body.codeChallenge === "string" ? body.codeChallenge : "";
  const codeChallengeMethod = body.codeChallengeMethod;

  if (codeChallengeMethod !== "S256") {
    return validationError(requestId, { codeChallengeMethod: ["Only S256 is supported"] });
  }
  if (!isValidS256Challenge(codeChallenge)) {
    return validationError(requestId, { codeChallenge: ["Must be a base64url-encoded SHA-256 digest"] });
  }

  return withRepo(env, deps, async (repo) => {
    // Client resolution (MCP11 leg B): static vetted allow-list FIRST, then
    // the dynamic-registration table (dcr_ ids only; expired = unknown). NEVER
    // an unregistered redirect_uri (per OAuth spec the user agent must not be
    // redirected there — the console renders these as errors instead of
    // redirecting).
    const client = await resolveOAuthClient(repo, clientId, new Date());
    if (!client) {
      return validationError(requestId, { clientId: ["Unknown client_id (not a vetted or registered client)"] });
    }
    if (!redirectUri || !resolvedRedirectUriAllowed(client, redirectUri)) {
      return validationError(requestId, { redirectUri: ["redirect_uri is not registered for this client"] });
    }

    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.oauthAuthorizeComplete({
      clientId,
      redirectUri,
      codeChallenge,
      approverUserUuid: actorUuid,
    });
    if ("error" in r) {
      const status = r.error === "not_found" ? 401 : 503;
      const code = r.error === "not_found" ? "unauthenticated" : "internal_error";
      return errorResponse(code, r.message, status, requestId);
    }
    const payload: OAuthAuthorizeCompleteResponse = {
      code: r.code,
      expiresAt: r.expiresAt.toISOString(),
    };
    return successResponse(payload, requestId, 201);
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/oauth2/token (public; RFC 6749 §4.1.3 / §6)
// ---------------------------------------------------------------------------

/** RFC 6749 §5.2 error response: raw OAuth JSON, never the platform envelope. */
function oauthErrorResponse(error: OAuthTokenErrorCode, description: string, status: number): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
    },
  );
}

/** Token requests arrive form-encoded per spec; JSON is accepted too. */
async function readTokenParams(request: Request): Promise<Record<string, string> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      if (body === null || typeof body !== "object") return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    const text = await request.text();
    const out: Record<string, string> = {};
    new URLSearchParams(text).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  } catch {
    return null;
  }
}

export async function handleOAuth2Token(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CliAuthDeps,
): Promise<Response> {
  const params = await readTokenParams(request);
  if (!params) return oauthErrorResponse("invalid_request", "Malformed request body", 400);

  const grantType = params["grant_type"];
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthErrorResponse(
      "unsupported_grant_type",
      "grant_type must be authorization_code or refresh_token",
      400,
    );
  }

  if (grantType === "authorization_code") {
    const code = params["code"] ?? "";
    const clientId = params["client_id"] ?? "";
    const redirectUri = params["redirect_uri"] ?? "";
    const codeVerifier = params["code_verifier"] ?? "";
    if (!code || !clientId || !redirectUri || !codeVerifier) {
      return oauthErrorResponse(
        "invalid_request",
        "code, client_id, redirect_uri, and code_verifier are required",
        400,
      );
    }
    if (!isValidCodeVerifier(codeVerifier)) {
      return oauthErrorResponse("invalid_request", "Malformed code_verifier (RFC 7636 §4.1)", 400);
    }

    const result = await withRepo(env, deps, async (repo) => {
      // Static-first resolution (MCP11 leg B) — same order as authorize.
      const now = new Date();
      const client = await resolveOAuthClient(repo, clientId, now);
      if (!client) return oauthErrorResponse("invalid_client", "Unknown client_id", 401);
      if (!resolvedRedirectUriAllowed(client, redirectUri)) {
        return oauthErrorResponse("invalid_grant", "redirect_uri is not registered for this client", 400);
      }

      const svc = makeService(env, request, requestId, deps, repo);
      const r = await svc.oauthRedeemCode({ code, clientId, redirectUri, codeVerifier });
      if ("error" in r) return oauthRedeemErrorResponse(r.error, r.message);
      if (client.dynamic) {
        // Successful redemption = the client is in use: stamp last_used_at and
        // push the unused-client GC horizon forward (best-effort — a failed
        // touch never fails the token response).
        await repo.touchOAuthDynamicClientUsed(
          client.clientId,
          now,
          new Date(now.getTime() + OAUTH_DYNAMIC_CLIENT_TTL_MS),
        );
      }
      return tokenSuccessResponse(r.accessToken, r.expiresAt, r.refreshToken);
    });
    return result;
  }

  // grant_type=refresh_token → the unchanged OP1 rotation path (single-use,
  // reuse-detection → family revoke), re-shaped as an OAuth response.
  const refreshToken = params["refresh_token"] ?? "";
  if (!refreshToken) {
    return oauthErrorResponse("invalid_request", "refresh_token is required", 400);
  }
  return withRepo(env, deps, async (repo) => {
    const svc = makeService(env, request, requestId, deps, repo);
    const r = await svc.refresh(refreshToken);
    if ("error" in r) {
      if (r.error === "signing_unavailable" || r.error === "internal_error") {
        return oauthErrorResponse("server_error", "Token service unavailable", 503);
      }
      if (r.error === "invalid_request") {
        return oauthErrorResponse("invalid_request", r.message, 400);
      }
      // not_found (invalid/reused → family revoked) and expired are both
      // "the presented grant is no longer valid" per RFC 6749 §5.2.
      return oauthErrorResponse("invalid_grant", r.message, 400);
    }
    return tokenSuccessResponse(r.accessToken, r.expiresAt, r.refreshToken);
  });
}

function oauthRedeemErrorResponse(
  error: "invalid_grant" | "invalid_request" | "internal_error" | "signing_unavailable",
  message: string,
): Response {
  if (error === "signing_unavailable" || error === "internal_error") {
    return oauthErrorResponse("server_error", "Token service unavailable", 503);
  }
  return oauthErrorResponse(error, message, 400);
}

// ---------------------------------------------------------------------------
// POST /v1/auth/oauth2/register (public; RFC 7591 — MCP11 leg B, D1 Option B)
// ---------------------------------------------------------------------------

/** RFC 7591 §3.2.2 error body: 400, raw OAuth JSON, never the platform
 *  envelope. Descriptions must never echo redirect URIs (never logged or
 *  reflected at error level with user data). */
function registrationErrorResponse(error: OAuthRegistrationErrorCode, description: string): Response {
  return Response.json(
    { error, error_description: description },
    {
      status: 400,
      headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
    },
  );
}

type ValidatedRegistration = { clientName: string; redirectUris: string[] };

/** Pure RFC 7591 metadata validation; returns an error Response or the
 *  normalized registration. Public-clients-only is enforced here. */
function validateRegistrationMetadata(body: Record<string, unknown>): ValidatedRegistration | Response {
  // Ids are ALWAYS server-minted `dcr_…` — a caller-chosen client_id could
  // otherwise aim at (or collide with) the static vetted namespace.
  if ("client_id" in body) {
    return registrationErrorResponse("invalid_client_metadata", "client_id is server-assigned and cannot be chosen");
  }
  const meta = body as OAuthClientRegistrationRequest;

  const authMethod = meta.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return registrationErrorResponse(
      "invalid_client_metadata",
      'Only public clients are supported (token_endpoint_auth_method must be "none")',
    );
  }
  // No secret is ever issued, so a confidential-client registration must be
  // rejected rather than silently downgraded when it asks for secret-based auth.
  if ("client_secret" in body) {
    return registrationErrorResponse("invalid_client_metadata", "client_secret is not supported (public clients only)");
  }

  const clientName = typeof meta.client_name === "string" ? meta.client_name.trim() : "";
  if (!clientName || clientName.length > OAUTH_DCR_MAX_CLIENT_NAME_LENGTH) {
    return registrationErrorResponse(
      "invalid_client_metadata",
      `client_name is required (1-${OAUTH_DCR_MAX_CLIENT_NAME_LENGTH} characters)`,
    );
  }

  const grantTypes = meta.grant_types;
  if (grantTypes !== undefined) {
    const supported: readonly string[] = OAUTH_SUPPORTED_GRANT_TYPES;
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || grantTypes.some((g) => !supported.includes(g as string))) {
      return registrationErrorResponse(
        "invalid_client_metadata",
        `grant_types must be within [${supported.join(", ")}]`,
      );
    }
  }
  const responseTypes = meta.response_types;
  if (responseTypes !== undefined) {
    const supported: readonly string[] = OAUTH_SUPPORTED_RESPONSE_TYPES;
    if (!Array.isArray(responseTypes) || responseTypes.length === 0 || responseTypes.some((r) => !supported.includes(r as string))) {
      return registrationErrorResponse(
        "invalid_client_metadata",
        `response_types must be within [${supported.join(", ")}]`,
      );
    }
  }

  const redirectUris = meta.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return registrationErrorResponse("invalid_redirect_uri", "redirect_uris is required (at least one URI)");
  }
  if (redirectUris.length > OAUTH_DCR_MAX_REDIRECT_URIS) {
    return registrationErrorResponse(
      "invalid_redirect_uri",
      `At most ${OAUTH_DCR_MAX_REDIRECT_URIS} redirect_uris are allowed`,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isRegistrableDynamicRedirectUri(uri)) {
      return registrationErrorResponse(
        "invalid_redirect_uri",
        "Each redirect_uri must be https (non-loopback) or http on a loopback host (RFC 8252 §7.3)",
      );
    }
  }

  return { clientName, redirectUris };
}

export async function handleOAuth2Register(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CliAuthDeps,
): Promise<Response> {
  // RFC 7591 §2: the request body is a JSON client-metadata document.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return registrationErrorResponse("invalid_client_metadata", "Request body must be a JSON object");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return registrationErrorResponse("invalid_client_metadata", "Request body must be a JSON object");
  }

  const validated = validateRegistrationMetadata(body as Record<string, unknown>);
  if (validated instanceof Response) return validated;

  return withRepo(env, deps, async (repo) => {
    const now = new Date();

    // Opportunistic unused-client GC (D1 Option B): the identity plane has no
    // scheduled sweep, so expired registrations are deleted here, bounded,
    // piggybacked on the (rate-limited) registration write path. Best-effort.
    await repo.deleteExpiredOAuthDynamicClients(now, OAUTH_DYNAMIC_CLIENT_GC_LIMIT);

    // Mint the `dcr_` id. A collision of a fresh 128-bit id is astronomically
    // unlikely, but the create is conflict-guarded anyway (PK): retry once
    // with a fresh id, then fail closed — never overwrite an existing row.
    let created = null;
    for (let attempt = 0; attempt < 2 && !created; attempt++) {
      const clientId = generateOAuthDynamicClientId();
      const r = await repo.createOAuthDynamicClient({
        clientId,
        clientName: validated.clientName,
        redirectUris: validated.redirectUris,
        createdAt: now,
        expiresAt: new Date(now.getTime() + OAUTH_DYNAMIC_CLIENT_TTL_MS),
      });
      if (r.ok) {
        created = r.value;
      } else if (r.error.kind !== "conflict") {
        // Raw OAuth-shaped 503 (mirrors the token endpoint's server_error
        // posture) — 7591 defines no server-error code, so the RFC 6749 §5.2
        // vocabulary is reused pragmatically.
        return Response.json(
          { error: "server_error", error_description: "Registration service unavailable" },
          { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }
    }
    if (!created) {
      return Response.json(
        { error: "server_error", error_description: "Registration service unavailable" },
        { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    }

    // Audit trail: who registered what (name + URI count only — redirect URIs
    // are user-supplied data and stay out of the event stream).
    const ctx = extractRequestContext(request, requestId);
    await repo.recordSecurityEvent({
      id: generateSecurityEventId(),
      eventType: "oauth.client.registered",
      outcome: "success",
      requestId: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      occurredAt: now,
      metadata: {
        clientId: created.clientId,
        clientName: created.clientName,
        redirectUriCount: created.redirectUris.length,
        expiresAt: created.expiresAt.toISOString(),
      },
    });

    // RFC 7591 §3.2.1 response: raw JSON (no envelope), 201, no-store —
    // and deliberately NO client_secret (public clients only).
    const payload: OAuthClientRegistrationResponse = {
      client_id: created.clientId,
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
      client_name: created.clientName,
      redirect_uris: created.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: [...OAUTH_SUPPORTED_GRANT_TYPES],
      response_types: [...OAUTH_SUPPORTED_RESPONSE_TYPES],
    };
    return Response.json(payload, {
      status: 201,
      headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
    });
  });
}

// ---------------------------------------------------------------------------
// GET /v1/auth/oauth2/client/{clientId} (public; console consent client info)
// ---------------------------------------------------------------------------

/**
 * Public-safe client lookup for the console consent page: the static
 * allow-list renders from `@saas/contracts` directly, so the console only
 * calls this for `dcr_` ids — but static ids resolve too (same static-first
 * resolver as authorize/token). Platform envelope (SDK-consumed), unlike the
 * raw RFC endpoints. Unknown/expired → 404.
 */
export async function handleOAuth2ClientInfo(
  request: Request,
  env: Env,
  requestId: string,
  deps?: CliAuthDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/v1\/auth\/oauth2\/client\/([^/]+)$/);
  const clientId = m ? decodeURIComponent(m[1]!) : "";
  if (!clientId) return validationError(requestId, { clientId: ["Required"] });

  return withRepo(env, deps, async (repo) => {
    const client = await resolveOAuthClient(repo, clientId, new Date());
    if (!client) return errorResponse("not_found", "Unknown OAuth client", 404, requestId);
    const payload: OAuthClientInfoResponse = {
      client: {
        clientId: client.clientId,
        name: client.name,
        dynamic: client.dynamic,
        redirectUris: [...client.redirectUris],
      },
    };
    return successResponse(payload, requestId, 200);
  });
}

function tokenSuccessResponse(accessToken: string, expiresAtIso: string, refreshToken: string): Response {
  const expiresIn = Math.max(1, Math.floor((Date.parse(expiresAtIso) - Date.now()) / 1000));
  const payload: OAuthTokenSuccessResponse = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
  };
  // Raw RFC 6749 §5.1 token response (no envelope), never cacheable.
  return Response.json(payload, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
  });
}
