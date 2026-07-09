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
  /**
   * Durable Workspace IDs (`ws_…`) for the same orgs as `orgIds`, in the same
   * order (WID5). Carried ALONGSIDE `orgIds` (which is kept until in-flight
   * tokens age out). Optional for back-compat with tokens minted before WID5.
   */
  workspaceIds?: string[];
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
  input: { sub: string; sessionId: string; orgIds: string[]; workspaceIds?: string[]; now: Date },
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
    ...(input.workspaceIds ? { workspaceIds: input.workspaceIds } : {}),
    iat,
    exp,
  };
  const payloadB64 = stringToBase64url(JSON.stringify(claims));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSign(signingInput, secret);
  return { token: `${signingInput}.${sig}`, expiresAt: new Date(exp * 1000) };
}

// ── Workflow access token (OV3) ─────────────────────────────
// A CI workflow's short-lived access token, minted by the OIDC exchange. It is
// the SAME HS256 envelope as the CLI access token (so the api-edge bearer path
// and `looksLikeCliAccessToken` treat both uniformly) but carries actorKind
// "workflow" and the resolved (org, project) binding instead of a user session —
// the credential-agnostic ActorContext{org, project} the design unifies on.

export const WORKFLOW_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface WorkflowAccessClaims {
  /** Subject: the GitHub OIDC `sub` (e.g. repo:owner/repo:ref:refs/heads/main). */
  sub: string;
  actorKind: "workflow";
  /** Public org id the workflow is bound to (resolved from the workspace link). */
  orgId: string;
  /**
   * Durable Workspace ID (`ws_…`) of the bound org, carried alongside `orgId`
   * (WID5). Optional: omitted when it cannot be resolved (kept fail-soft so a
   * membership hiccup never blocks the mint).
   */
  workspaceId?: string;
  /** Public project id the workflow is bound to. */
  projectId: string;
  iat: number;
  exp: number;
}

/**
 * Mint a workflow access JWT (OV3 OIDC exchange). Throws when the signing key is
 * unavailable — the caller surfaces a 503, never a silent grant.
 */
export async function mintWorkflowAccessToken(
  env: Env,
  input: { sub: string; orgId: string; workspaceId?: string; projectId: string; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const secret = getCliSigningKey(env);
  if (!secret) {
    throw new Error("CLI_JWT_SIGNING_KEY is not configured");
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = Math.floor((input.now.getTime() + WORKFLOW_ACCESS_TOKEN_TTL_MS) / 1000);
  const claims: WorkflowAccessClaims = {
    sub: input.sub,
    actorKind: "workflow",
    orgId: input.orgId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    projectId: input.projectId,
    iat,
    exp,
  };
  const payloadB64 = stringToBase64url(JSON.stringify(claims));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSign(signingInput, secret);
  return { token: `${signingInput}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/**
 * Verify a workflow access JWT and return its claims, or null when malformed,
 * mis-signed, expired, the wrong actor kind, or the signing key is unavailable.
 */
export async function verifyWorkflowAccessToken(
  env: Env,
  token: string,
  now: Date,
): Promise<WorkflowAccessClaims | null> {
  const secret = getCliSigningKey(env);
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts as [string, string, string];
  if (headerB64 !== HEADER_B64) return null;

  const expected = await hmacSign(`${headerB64}.${payloadB64}`, secret);
  if (!timingSafeEqual(sig, expected)) return null;

  let claims: WorkflowAccessClaims;
  try {
    claims = JSON.parse(base64urlToString(payloadB64)) as WorkflowAccessClaims;
  } catch {
    return null;
  }

  if (
    typeof claims.sub !== "string" ||
    claims.actorKind !== "workflow" ||
    typeof claims.orgId !== "string" ||
    typeof claims.projectId !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp * 1000 <= now.getTime()) return null;

  return claims;
}

// ── Agent-session access token (saas-agents AG6 §3.2) ──────────
// A hosted agent session's short-lived credential: the SAME HS256 envelope as
// the CLI/workflow tokens (one bearer path, one signing key), carrying
// actorKind "agent_session" with the profile's service principal as subject
// and the session id for audit. resolve-bearer resolves it to a plain
// service_principal ActorContext — no new identity plane; policy is unchanged.
// The short TTL is the kill switch: a lapsed lease stops the refresh chain and
// a runaway sandbox's credential dies within one TTL.

export const AGENT_SESSION_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface AgentSessionClaims {
  /** Subject: the profile's service principal (`sp_…`). */
  sub: string;
  actorKind: "agent_session";
  /** Public org id (workspace) the session belongs to. */
  orgId: string;
  /** The agent session (`as_…`) this credential is bound to — the audit fact. */
  sessionId: string;
  iat: number;
  exp: number;
}

/**
 * Mint an agent-session access JWT (AG6). Throws when the signing key is
 * unavailable — the caller surfaces a 503, never a silent grant.
 */
export async function mintAgentSessionToken(
  env: Env,
  input: { principalId: string; orgId: string; sessionId: string; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const secret = getCliSigningKey(env);
  if (!secret) {
    throw new Error("CLI_JWT_SIGNING_KEY is not configured");
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = Math.floor((input.now.getTime() + AGENT_SESSION_TOKEN_TTL_MS) / 1000);
  const claims: AgentSessionClaims = {
    sub: input.principalId,
    actorKind: "agent_session",
    orgId: input.orgId,
    sessionId: input.sessionId,
    iat,
    exp,
  };
  const payloadB64 = stringToBase64url(JSON.stringify(claims));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sig = await hmacSign(signingInput, secret);
  return { token: `${signingInput}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/**
 * Verify an agent-session access JWT and return its claims, or null when
 * malformed, mis-signed, expired, the wrong actor kind, or the key is unset.
 */
export async function verifyAgentSessionToken(
  env: Env,
  token: string,
  now: Date,
): Promise<AgentSessionClaims | null> {
  const secret = getCliSigningKey(env);
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts as [string, string, string];
  if (headerB64 !== HEADER_B64) return null;

  const expected = await hmacSign(`${headerB64}.${payloadB64}`, secret);
  if (!timingSafeEqual(sig, expected)) return null;

  let claims: AgentSessionClaims;
  try {
    claims = JSON.parse(base64urlToString(payloadB64)) as AgentSessionClaims;
  } catch {
    return null;
  }

  if (
    typeof claims.sub !== "string" ||
    claims.actorKind !== "agent_session" ||
    typeof claims.orgId !== "string" ||
    typeof claims.sessionId !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp * 1000 <= now.getTime()) return null;

  return claims;
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
