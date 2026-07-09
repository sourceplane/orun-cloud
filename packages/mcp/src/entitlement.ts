// MCP6 entitlement seam (design §8, risks D3): `feature.mcp_server`,
// checked at the TRANSPORT layer — nothing in the tool plane (`tools/`,
// `executeTool`) knows about billing. Transports call these helpers
// explicitly: the CLI once at `mcp serve` startup (against the ambient
// default workspace, when set), the remote worker lazily per tool call via
// `createEntitlementGate` (tenancy is per-call there) with a tiny
// once-per-isolate-per-org TTL cache.
//
// D3 DEFAULT POSTURE — GATE OPEN: the product free-vs-paid line is an open
// decision, so `feature.mcp_server` is granted to all plans and a workspace
// with NO explicit entitlement row is treated as GRANTED. Only an explicit
// `enabled: false` row (a plan change or an override) closes the gate — which
// therefore works without a redeploy. The check reads the PUBLIC billing
// entitlements list with the caller's own credential (client-not-service);
// a failed read fails OPEN (mirroring the edge's fail-open posture) so a
// billing outage cannot break agent traffic while the gate's default is open.

import type { OrunCloud } from "@saas/sdk";

import { EntitlementDeniedError } from "./errors.js";
import type { ToolCallGate, McpTool } from "./tool.js";
import { workspaceOf } from "./usage.js";

/** The entitlement key gating MCP server access (design §8, mirrors B11 keys). */
export const MCP_SERVER_ENTITLEMENT_KEY = "feature.mcp_server";

/**
 * Outcome of an MCP-server entitlement check.
 *
 * - `granted` — an explicit enabled row exists.
 * - `not_configured` — no row for the key: GRANTED under the D3 open-gate
 *   default (an org whose rows predate the key is not locked out).
 * - `check_failed` — the entitlements read itself failed (forbidden, network,
 *   …): fail-open, callers may surface a diagnostic.
 * - `disabled` — an explicit `enabled: false` row: the gated experience.
 */
export type McpEntitlementDecision =
  | { allowed: true; reason: "granted" | "not_configured" | "check_failed" }
  | { allowed: false; reason: "disabled" };

/**
 * Check `feature.mcp_server` for a workspace via the public billing
 * entitlements read (the caller's credential; no private billing seam).
 * Never throws.
 */
export async function checkMcpServerEntitlement(
  sdk: OrunCloud,
  workspace: string,
): Promise<McpEntitlementDecision> {
  let entitlements;
  try {
    entitlements = (await sdk.billing.getEntitlements(workspace)).entitlements;
  } catch {
    return { allowed: true, reason: "check_failed" };
  }
  const row = entitlements.find(
    (e) => e.entitlementKey === MCP_SERVER_ENTITLEMENT_KEY,
  );
  if (row === undefined) return { allowed: true, reason: "not_configured" };
  return row.enabled
    ? { allowed: true, reason: "granted" }
    : { allowed: false, reason: "disabled" };
}

/** Cached decision + expiry, keyed by the raw workspace argument. */
export type EntitlementGateCache = Map<
  string,
  { decision: McpEntitlementDecision; expiresAt: number }
>;

/** Tiny TTL: a plan flip takes effect within a minute, without a redeploy. */
export const ENTITLEMENT_CACHE_TTL_MS = 60_000;
/** Hard cap on cache entries — the cache stays tiny by construction. */
export const ENTITLEMENT_CACHE_MAX_ENTRIES = 256;

export interface EntitlementGateOptions {
  /** The per-connection SDK (the caller's credential rides the check). */
  sdk: OrunCloud;
  /**
   * Decision cache. The worker passes a per-isolate Map shared across
   * requests so the first tool call per org per TTL pays the read; omit for
   * an unshared (per-gate) cache.
   */
  cache?: EntitlementGateCache;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Build the per-tool-call entitlement gate for transports whose tenancy is
 * per call (the remote worker). Tool calls without a `workspace` argument
 * pass untouched (whoami/workspaces_list — no tenancy to gate on); a denied
 * workspace throws `EntitlementDeniedError`, which the tool error mapper
 * frames as the platform's `entitlement_required` upgrade-shaped error.
 */
export function createEntitlementGate(options: EntitlementGateOptions): ToolCallGate {
  const cache: EntitlementGateCache = options.cache ?? new Map();
  const ttlMs = options.ttlMs ?? ENTITLEMENT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  return async (_tool: McpTool, input: unknown): Promise<void> => {
    const workspace = workspaceOf(input);
    if (workspace === undefined) return;

    const at = now();
    const cached = cache.get(workspace);
    let decision: McpEntitlementDecision;
    if (cached !== undefined && cached.expiresAt > at) {
      decision = cached.decision;
    } else {
      decision = await checkMcpServerEntitlement(options.sdk, workspace);
      pruneCache(cache, at);
      cache.set(workspace, { decision, expiresAt: at + ttlMs });
    }

    if (!decision.allowed) {
      throw new EntitlementDeniedError(MCP_SERVER_ENTITLEMENT_KEY);
    }
  };
}

/** Drop expired entries; if still at the cap, drop the oldest-inserted. */
function pruneCache(cache: EntitlementGateCache, at: number): void {
  if (cache.size < ENTITLEMENT_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= at) cache.delete(key);
  }
  while (cache.size >= ENTITLEMENT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}
