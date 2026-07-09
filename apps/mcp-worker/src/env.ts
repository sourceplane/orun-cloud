// Bindings the mcp-worker declares — vars only, by design. The worker is a
// CLIENT of the public API (design §2): no DB, no KV, no DO, no service
// bindings; its only egress is API_EDGE_URL via `@saas/sdk`.

export interface Env {
  /** Public api-edge base URL — the worker's only egress. Per-env var. */
  API_EDGE_URL?: string;
  /** Deploy environment name ("dev" | "stage" | "prod" | "local"). */
  ENVIRONMENT: string;
}
