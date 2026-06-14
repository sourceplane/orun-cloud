// CLI access-token JWT (saas-orun-platform OP1).
//
// The CLI access token is a compact HS256 JWT (~15 min) carrying the claims the
// api-edge bearer path needs to resolve an ActorContext without a DB hop on the
// happy path: `sub`, `actorKind`, `sessionId`, `orgIds`. It is signed with the
// `CLI_JWT_SIGNING_KEY` Worker secret.
//
// Secret discipline mirrors `oauth/state.ts`: the key is OPTIONAL at boot (so a
// missing secret never breaks the deploy/verify), and we only fail at MINT time
// when it is absent or too weak. Verification likewise fails closed if the key
// is unset.

import type { Env } from "../env.js";

export const CLI_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface CliAccessClaims {
  /** Subject: the public user id (`usr_<hex>`). */
  sub: string;
  /** Actor kind — always "user" for human CLI sessions. */
  actorKind: "user";
  /** The CLI session (public) id this token belongs to. */
  sessionId: string;
  /** Public org ids the user is a member of (the CLI's allowedNamespaceIds). */
  orgIds: string[];
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * The HS256 signing key, or null when unset/too weak. Callers that mint MUST
 * treat null as a hard error; the verify path treats null as "cannot verify"
 * (fail closed). 32 chars min keeps a generated 32-byte hex key valid while
 * rejecting trivially short values.
 */
export function getCliSigningKey(env: Env): string | null {
  const key = env.CLI_JWT_SIGNING_KEY;
  if (typeof key !== "string" || key.length < 32) return null;
  return key;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringToBase64url(s: string): string {
  return bytesToBase64url(new TextEncoder().encode(s));
}

function base64urlToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64url(new Uint8Array(sig));
}

/** Constant-time string compare (avoid leaking signature bytes via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

const HEADER_B64 = stringToBase64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** Quick discriminator: does this bearer look like a CLI access JWT we minted?
 *  Three base64url segments with our exact header. Cheap pre-check before the
 *  signature verify (and lets the resolver skip the session/api-key paths). */
export function looksLikeCliAccessToken(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts[0] === HEADER_B64;
}

/**
 * Mint a CLI access JWT. Throws when the signing key is unavailable — callers
 * must surface this as a 503 (service misconfigured), never a silent grant.
 */
export async function mintCliAccessToken(
  env: Env,
  input: { sub: string; sessionId: string; orgIds: string[]; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const secret = getCliSigningKey(env);
  if (!secret) {
    throw new Error("CLI_JWT_SIGNING_KEY is not configured");
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = Math.floor((input.now.getTime() + CLI_ACCESS_TOKEN_TTL_MS) / 1000);
  const claims: CliAccessClaims = {
    sub: input.sub,
    actorKind: "user",
    sessionId: input.sessionId,
    orgIds: input.orgIds,
    iat,
    exp,
  };
  const payloadB64 = stringToBase64url(JSON.stringify(claims));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSign(signingInput, secret);
  return { token: `${signingInput}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/**
 * Verify a CLI access JWT and return its claims, or null when the token is
 * malformed, mis-signed, expired, or the signing key is unavailable.
 */
export async function verifyCliAccessToken(
  env: Env,
  token: string,
  now: Date,
): Promise<CliAccessClaims | null> {
  const secret = getCliSigningKey(env);
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts as [string, string, string];
  if (headerB64 !== HEADER_B64) return null;

  const expected = await hmacSign(`${headerB64}.${payloadB64}`, secret);
  if (!timingSafeEqual(sig, expected)) return null;

  let claims: CliAccessClaims;
  try {
    claims = JSON.parse(base64urlToString(payloadB64)) as CliAccessClaims;
  } catch {
    return null;
  }

  if (
    typeof claims.sub !== "string" ||
    claims.actorKind !== "user" ||
    typeof claims.sessionId !== "string" ||
    !Array.isArray(claims.orgIds) ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp * 1000 <= now.getTime()) return null;

  return claims;
}
