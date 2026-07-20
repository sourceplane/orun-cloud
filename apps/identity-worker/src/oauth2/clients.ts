// OAuth client resolution (saas-mcp-server MCP11 leg B).
//
// One resolver for every place that needs "who is this client_id?" —
// authorize/complete, token, and the consent client-info read. Resolution
// order is a SECURITY invariant:
//   1. the static vetted allow-list (`OAUTH_PUBLIC_CLIENTS`, D1 Option A) —
//      always first, so a dynamic registration can never shadow a vetted
//      clientId (belt-and-braces: minted dynamic ids live in the `dcr_`
//      namespace and the DB CHECK rejects anything else);
//   2. the `identity.oauth_dynamic_clients` table (D1 → Option B, RFC 7591) —
//      consulted ONLY for `dcr_`-prefixed ids; an expired row (the
//      unused-client GC horizon) is treated as an unknown client.
//
// Redirect matching reuses the same `oauthRedirectUriMatches` helper as the
// static path: exact string match, with the RFC 8252 §7.3 any-port carve-out
// applying only to loopback `http://` URIs. Dynamic registrations can only
// carry https-non-loopback or http-loopback URIs (enforced at register), so
// hosted URIs always match exactly.

import type { IdentityRepository } from "@saas/db/identity";
import {
  findOAuthPublicClient,
  isOAuthDynamicClientId,
  oauthRedirectUriMatches,
} from "@saas/contracts/auth";

/** Unused-client GC horizon: a dynamic client expires 30d after creation,
 *  refreshed on token redemption (D1 Option B "short-lived unused-client GC"). */
export const OAUTH_DYNAMIC_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounded opportunistic GC batch (identity-worker has no scheduled sweep —
 *  expired rows are deleted piggybacked on registration writes). */
export const OAUTH_DYNAMIC_CLIENT_GC_LIMIT = 25;

export interface ResolvedOAuthClient {
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  /** true when resolved from the dynamic table (consent renders "Unverified app"). */
  dynamic: boolean;
}

/** Static allow-list FIRST, then the dynamic table (dcr_ ids only, unexpired). */
export async function resolveOAuthClient(
  repo: IdentityRepository,
  clientId: string,
  now: Date,
): Promise<ResolvedOAuthClient | null> {
  const vetted = findOAuthPublicClient(clientId);
  if (vetted) {
    return { clientId: vetted.clientId, name: vetted.name, redirectUris: vetted.redirectUris, dynamic: false };
  }
  if (!isOAuthDynamicClientId(clientId)) return null;
  const r = await repo.getOAuthDynamicClientByClientId(clientId);
  if (!r.ok) return null;
  // Past the GC horizon ⇒ the registration no longer exists as far as the
  // protocol is concerned (same error as an unknown client_id), even if the
  // opportunistic sweep has not physically deleted the row yet.
  if (r.value.expiresAt.getTime() <= now.getTime()) return null;
  return { clientId: r.value.clientId, name: r.value.clientName, redirectUris: r.value.redirectUris, dynamic: true };
}

export function resolvedRedirectUriAllowed(client: ResolvedOAuthClient, redirectUri: string): boolean {
  return client.redirectUris.some((registered) => oauthRedirectUriMatches(registered, redirectUri));
}
