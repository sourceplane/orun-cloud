// GitHub Actions OIDC verification (OV3).
//
// Verifies the OIDC JWT a GitHub Actions job mints (signed by
// token.actions.githubusercontent.com, RS256) using remote JWKS. The codebase
// has no JWT library, so this implements RS256 verification directly on
// crypto.subtle (the same primitive cli/jwt.ts uses for HS256). The JWKS fetch
// is injectable so tests verify against an in-test keypair without network.

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URI = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

/** The subset of GitHub Actions OIDC claims OV3 consumes. */
export interface GitHubOidcClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat?: number;
  nbf?: number;
  /** "owner/repo". */
  repository: string;
  /** Rename-stable numeric repo id (string in the JWT). */
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  /** e.g. "refs/heads/main" — present on most events. */
  ref?: string;
  /** Deployment environment, when the job targets one. */
  environment?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

/** A JWKS document. Injectable so tests bypass the network. */
export type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

interface VerifyOptions {
  audience: string;
  now: Date;
  /** Defaults to fetching GitHub's well-known JWKS. */
  fetchJwks?: JwksFetcher | undefined;
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64urlToJson<T>(s: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(s))) as T;
  } catch {
    return null;
  }
}

async function defaultFetchJwks(): Promise<{ keys: Jwk[] }> {
  const res = await fetch(GITHUB_JWKS_URI, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
}

/**
 * Verify a GitHub Actions OIDC token and return its claims, or null when the
 * token is malformed, mis-signed (no matching JWK / bad signature), issued by
 * the wrong issuer, addressed to the wrong audience, or expired. Fails closed.
 */
export async function verifyGitHubOidcToken(
  token: string,
  opts: VerifyOptions,
): Promise<GitHubOidcClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = base64urlToJson<{ alg?: string; kid?: string; typ?: string }>(headerB64);
  if (!header || header.alg !== "RS256" || !header.kid) return null;

  const claims = base64urlToJson<GitHubOidcClaims>(payloadB64);
  if (!claims) return null;

  // Claim gates (cheap, before the crypto): issuer, audience, expiry.
  if (claims.iss !== GITHUB_OIDC_ISSUER) return null;
  if (claims.aud !== opts.audience) return null;
  const nowSec = Math.floor(opts.now.getTime() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + 60) return null;
  if (typeof claims.repository_id !== "string" || claims.repository_id.length === 0) return null;

  // Resolve the signing key by kid and verify RS256 over header.payload.
  let jwks: { keys: Jwk[] };
  try {
    jwks = await (opts.fetchJwks ?? defaultFetchJwks)();
  } catch {
    return null;
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64urlToBytes(sigB64) as BufferSource,
      signed as BufferSource,
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  return claims;
}
