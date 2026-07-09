// OAuth 2.1 consent-page logic (saas-mcp-server MCP3), kept pure for tests.
//
// The console's `/oauth/authorize` page is the authorization endpoint named in
// the RFC 8414 metadata: an MCP client sends the user here with the standard
// query params; after login + consent the page calls
// `auth.oauthAuthorizeComplete` and redirects back with `code` + `state`.
//
// Validation here is a UX pre-check against the SAME vetted allow-list the
// server enforces (D1 Option A) — the server remains the authority. Per the
// OAuth spec the user agent is NEVER redirected to an unregistered
// redirect_uri: an unknown client or a non-matching redirect renders an error
// instead of redirecting.

import {
  findOAuthPublicClient,
  isOAuthRedirectUriAllowed,
  type OAuthPublicClient,
} from "@saas/contracts/auth";

export interface OAuthAuthorizeRequestParams {
  clientId: string;
  redirectUri: string;
  /** Echoed back verbatim on the redirect (CSRF binding is the client's). */
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string | null;
}

export type ParsedAuthorizeRequest =
  | { ok: true; client: OAuthPublicClient; params: OAuthAuthorizeRequestParams }
  | { ok: false; error: string };

const S256_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function parseAuthorizeRequest(searchParams: URLSearchParams | null): ParsedAuthorizeRequest {
  if (!searchParams) return { ok: false, error: "Missing authorization request parameters." };
  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const responseType = searchParams.get("response_type");
  const codeChallenge = searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = searchParams.get("code_challenge_method") ?? "";

  if (!clientId) return { ok: false, error: "Missing client_id." };
  const client = findOAuthPublicClient(clientId);
  if (!client) {
    return { ok: false, error: `Unknown client "${clientId}" — it is not on the vetted client list.` };
  }
  if (!redirectUri || !isOAuthRedirectUriAllowed(client, redirectUri)) {
    return { ok: false, error: "The redirect_uri is not registered for this client." };
  }
  if (responseType !== null && responseType !== "code") {
    return { ok: false, error: "Only response_type=code is supported." };
  }
  if (codeChallengeMethod !== "S256") {
    return { ok: false, error: "PKCE is required and only code_challenge_method=S256 is supported." };
  }
  if (!S256_CHALLENGE_RE.test(codeChallenge)) {
    return { ok: false, error: "Malformed code_challenge (expected a base64url SHA-256 digest)." };
  }

  return {
    ok: true,
    client,
    params: {
      clientId,
      redirectUri,
      state: searchParams.get("state"),
      codeChallenge,
      codeChallengeMethod: "S256",
      scope: searchParams.get("scope"),
    },
  };
}

/** Approve: redirect_uri?code=…&state=… (state echoed only when present). */
export function buildApproveRedirect(redirectUri: string, code: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

/** Deny: redirect_uri?error=access_denied&state=… (RFC 6749 §4.1.2.1). */
export function buildDenyRedirect(redirectUri: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  if (state !== null) url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Sessions-list label for a session's `host` field. OP1 CLI sessions carry the
 * reported device host; MCP OAuth grants carry `mcp:<clientId>` (stamped by
 * identity-worker), rendered as the vetted client's display name.
 */
export function sessionClientLabel(host: string | null): { label: string; kind: "cli" | "mcp" } {
  if (host && host.startsWith("mcp:")) {
    const clientId = host.slice(4);
    const client = findOAuthPublicClient(clientId);
    return { label: client ? client.name : clientId, kind: "mcp" };
  }
  return { label: host ?? "Unknown device", kind: "cli" };
}
