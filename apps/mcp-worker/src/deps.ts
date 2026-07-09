// Dependency seam for the MCP handler. Production uses the platform fetch to
// reach api-edge; unit tests inject a fetch stub so no network is touched
// (the agents-worker injectedDeps pattern).

import type { EntitlementGateCache } from "@saas/mcp";

export interface McpWorkerDeps {
  /** fetch used by `@saas/sdk` toward API_EDGE_URL. */
  fetch: typeof fetch;
  /**
   * MCP6 entitlement decision cache (per-isolate, tiny TTL — see
   * `@saas/mcp` `createEntitlementGate`). Production shares one Map across
   * requests so the first tool call per org per TTL pays the entitlements
   * read; tests inject a fresh Map for isolation.
   */
  entitlementCache: EntitlementGateCache;
}

// Per-isolate cache, in-memory and fail-open like the concurrency cap
// (design §8) — resets with the isolate, no KV/DO.
const sharedEntitlementCache: EntitlementGateCache = new Map();

export function buildDeps(): McpWorkerDeps {
  return { fetch: globalThis.fetch, entitlementCache: sharedEntitlementCache };
}
