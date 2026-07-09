// Bindings the mcp-worker declares — vars only, by design. The worker is a
// CLIENT of the public API (design §2): no DB, no KV, no DO, no service
// bindings; its only egress is API_EDGE_URL via `@saas/sdk`.

export interface Env {
  /** Public api-edge base URL — the worker's only egress. Per-env var. */
  API_EDGE_URL?: string;
  /**
   * The OAuth 2.1 authorization-server issuer URL named in the RFC 9728
   * protected-resource metadata (MCP3): the public api-edge origin fronting
   * identity-worker, which serves `/.well-known/oauth-authorization-server`.
   * Per-env var; when unset the metadata route stays 404 (pre-MCP3 posture).
   */
  OAUTH_AUTHORIZATION_SERVER_URL?: string;
  /** Deploy environment name ("dev" | "stage" | "prod" | "local"). */
  ENVIRONMENT: string;
}
