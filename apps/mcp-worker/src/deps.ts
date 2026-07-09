// Dependency seam for the MCP handler. Production uses the platform fetch to
// reach api-edge; unit tests inject a fetch stub so no network is touched
// (the agents-worker injectedDeps pattern).

export interface McpWorkerDeps {
  /** fetch used by `@saas/sdk` toward API_EDGE_URL. */
  fetch: typeof fetch;
}

export function buildDeps(): McpWorkerDeps {
  return { fetch: globalThis.fetch };
}
