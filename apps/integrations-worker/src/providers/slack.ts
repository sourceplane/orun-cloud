// Slack adapter (saas-integration-hub IH1–IH3) — the messaging archetype.
//
// IH1 wires the OAuth v2 connect flow end-to-end: authorize URL → signed
// single-use state → `oauth.v2.access` code exchange → bot-token custody.
// The registry still gates the adapter on the per-environment Slack App
// credentials (risks D1) — without them every Slack surface parks typed.
//
// Custody rule: the bot token this adapter's connect flow obtains lives ONLY
// as a provider_credentials envelope; delivery stays behind the ES
// ChannelProvider seam in notifications-worker (design §4.2).

import type { FetchLike } from "../github-app.js";
import type { InboundCapability, IntegrationProvider, SlackAppCredentials } from "./types.js";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const AUTH_REVOKE_URL = "https://slack.com/api/auth.revoke";

/**
 * Bot scope set (risks D2, minimal two-way default): post/update messages,
 * channel picker, slash commands, unfurls, workspace facts. Deliberately
 * excludes chat:write.public, users:read, and every history scope.
 */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
  "commands",
  "links:read",
  "links:write",
  "team:read",
] as const;

/** Slack's replay-defense window for signed requests: ±300s (risks R2). */
export const SLACK_SIGNATURE_WINDOW_SECONDS = 300;

/** Constant-time hex compare (signature verification, R2). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Slack signs `v0:{timestamp}:{rawBody}` with the app's signing secret:
 * X-Slack-Signature = "v0=" + HMAC-SHA256 hex. Verification runs over raw
 * bytes before any parse, constant-time, and rejects timestamps outside the
 * ±300s window (replayed requests never reach the inbox).
 */
export async function verifySlackSignature(
  signingSecret: string,
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  timestampHeader: string | null,
  nowMs: number,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("v0=")) return false;
  const provided = signatureHeader.slice("v0=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  if (!timestampHeader || !/^\d{1,12}$/.test(timestampHeader)) return false;
  const timestampSeconds = Number(timestampHeader);
  const skewSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (skewSeconds > SLACK_SIGNATURE_WINDOW_SECONDS) return false;

  const prefix = new TextEncoder().encode(`v0:${timestampHeader}:`);
  const body = new Uint8Array(rawBody);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, message);
  const bytes = new Uint8Array(sig);
  let expected = "";
  for (let i = 0; i < bytes.length; i++) expected += bytes[i]!.toString(16).padStart(2, "0");
  return timingSafeEqualHex(provided, expected);
}

/**
 * The OAuth v2 authorize URL carrying our signed single-use state (the
 * `team_id ↔ org_id` keystone rides this state, never inference — IH1).
 */
export function buildSlackAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("user_scope", "");
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}

/** Verified grant from `oauth.v2.access` — the team_id inside it is the
 *  provider-verified half of the `team_id ↔ org_id` keystone (design §4.1). */
export interface SlackOauthGrant {
  /** The workspace bot token (xoxb-…) — custody-envelope material ONLY. */
  accessToken: string;
  grantedScopes: string[];
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  botUserId: string | null;
  appId: string | null;
  /** Slack user id of the installing member (provenance, never identity). */
  installedByExternalUser: string | null;
}

/**
 * Exchange the callback's code for a bot token (`oauth.v2.access`). Slack
 * verifies the code AND that redirect_uri matches the authorize request, so a
 * non-ok response means the callback is not a grant we initiated — null, and
 * callers fail closed.
 */
export async function exchangeSlackOauthCode(
  credentials: SlackAppCredentials,
  input: { code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<SlackOauthGrant | null> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  let payload: Record<string, unknown>;
  try {
    const response = await fetchImpl(OAUTH_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) return null;
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (payload.ok !== true) return null;
  const accessToken = payload.access_token;
  const team = payload.team as { id?: unknown; name?: unknown } | null | undefined;
  const teamId = team?.id;
  if (typeof accessToken !== "string" || !accessToken || typeof teamId !== "string" || !teamId) {
    return null;
  }
  // D2: we request bot scopes only — a grant that came back as anything but a
  // bot token is not one we asked for.
  if ((payload.token_type ?? "bot") !== "bot") return null;

  const enterprise = payload.enterprise as { id?: unknown } | null | undefined;
  const authedUser = payload.authed_user as { id?: unknown } | null | undefined;
  return {
    accessToken,
    grantedScopes:
      typeof payload.scope === "string" && payload.scope.length > 0
        ? payload.scope.split(",")
        : [],
    teamId,
    teamName: typeof team?.name === "string" ? team.name : null,
    enterpriseId: typeof enterprise?.id === "string" ? enterprise.id : null,
    botUserId: typeof payload.bot_user_id === "string" ? payload.bot_user_id : null,
    appId: typeof payload.app_id === "string" ? payload.app_id : null,
    installedByExternalUser: typeof authedUser?.id === "string" ? authedUser.id : null,
  };
}

/** Best-effort `auth.revoke` on platform revoke — TTL-less bot tokens die
 *  provider-side too, not just in our custody table. */
export async function revokeSlackToken(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(AUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: unknown; revoked?: unknown };
    return payload.ok === true && payload.revoked === true;
  } catch {
    return false;
  }
}

export function createSlackProvider(
  credentials: SlackAppCredentials,
  fetchImpl?: FetchLike,
): IntegrationProvider {
  const inbound: InboundCapability = {
    async verifySignature(rawBody, headers, nowMs): Promise<boolean> {
      return verifySlackSignature(
        credentials.signingSecret,
        rawBody,
        headers["x-slack-signature"] ?? null,
        headers["x-slack-request-timestamp"] ?? null,
        nowMs,
      );
    },
  };

  return {
    id: "slack",
    displayName: "Slack",
    connectKind: "oauth",
    // "messaging" (listChannels) lands with IH2; the capability list reflects
    // what the adapter object actually exposes today.
    capabilities: ["connect", "inbound"],

    inbound,

    buildAuthorizeUrl(input) {
      return buildSlackAuthorizeUrl({
        clientId: credentials.clientId,
        state: input.state,
        redirectUri: input.redirectUri,
      });
    },
    exchangeOauthCode(input) {
      return exchangeSlackOauthCode(
        credentials,
        { code: input.code, redirectUri: input.redirectUri },
        fetchImpl,
      );
    },
    revokeOauthToken(accessToken) {
      return revokeSlackToken(accessToken, fetchImpl);
    },
  };
}
