// Slack adapter (saas-integration-hub IH1–IH3) — the messaging archetype.
//
// IH0 registers it DORMANT: the adapter compiles, its pure logic (authorize
// URL, v0 request-signature verification) is fixture-testable, and the
// registry returns it only when the per-environment Slack App credentials
// exist (risks D1). No route reaches it until IH1 wires the connect flow.
//
// Custody rule: the bot token this adapter's connect flow obtains lives ONLY
// as a provider_credentials envelope; delivery stays behind the ES
// ChannelProvider seam in notifications-worker (design §4.2).

import type { InboundCapability, IntegrationProvider, SlackAppCredentials } from "./types.js";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

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

export function createSlackProvider(credentials: SlackAppCredentials): IntegrationProvider {
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
  };
}
