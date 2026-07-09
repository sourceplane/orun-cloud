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
// Client registration is the vetted public-client allow-list (risks D1,
// Option A — no open dynamic client registration). PKCE S256 is mandatory.
// Codes/verifiers/tokens are NEVER logged.

import type { Env } from "../env.js";
import type {
  AuthorizationServerMetadata,
  OAuthAuthorizeCompleteResponse,
  OAuthTokenErrorCode,
  OAuthTokenSuccessResponse,
} from "@saas/contracts/auth";
import { findOAuthPublicClient, isOAuthRedirectUriAllowed } from "@saas/contracts/auth";
import { successResponse, errorResponse, validationError } from "../http.js";
import { consoleBaseUrl } from "../services/cli-auth.js";
import { isValidCodeVerifier, isValidS256Challenge } from "../oauth2/pkce.js";
import { parseSubjectUuid } from "../ids.js";
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

  // D1 Option A: only vetted public clients, and NEVER an unregistered
  // redirect_uri (per OAuth spec the user agent must not be redirected there —
  // the console renders these as errors instead of redirecting).
  const client = findOAuthPublicClient(clientId);
  if (!client) {
    return validationError(requestId, { clientId: ["Unknown client_id (not on the vetted allow-list)"] });
  }
  if (!redirectUri || !isOAuthRedirectUriAllowed(client, redirectUri)) {
    return validationError(requestId, { redirectUri: ["redirect_uri is not registered for this client"] });
  }
  if (codeChallengeMethod !== "S256") {
    return validationError(requestId, { codeChallengeMethod: ["Only S256 is supported"] });
  }
  if (!isValidS256Challenge(codeChallenge)) {
    return validationError(requestId, { codeChallenge: ["Must be a base64url-encoded SHA-256 digest"] });
  }

  return withRepo(env, deps, async (repo) => {
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
    const client = findOAuthPublicClient(clientId);
    if (!client) return oauthErrorResponse("invalid_client", "Unknown client_id", 401);
    if (!isOAuthRedirectUriAllowed(client, redirectUri)) {
      return oauthErrorResponse("invalid_grant", "redirect_uri is not registered for this client", 400);
    }
    if (!isValidCodeVerifier(codeVerifier)) {
      return oauthErrorResponse("invalid_request", "Malformed code_verifier (RFC 7636 §4.1)", 400);
    }

    const result = await withRepo(env, deps, async (repo) => {
      const svc = makeService(env, request, requestId, deps, repo);
      const r = await svc.oauthRedeemCode({ code, clientId, redirectUri, codeVerifier });
      if ("error" in r) return oauthRedeemErrorResponse(r.error, r.message);
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
