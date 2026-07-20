// Bindings the mcp-worker declares. The worker stays a CLIENT of the public
// API (design §2): no DB, no KV, no DO, and no binding to any DOWNSTREAM worker
// — every tool call still re-enters api-edge, where actor resolution and
// deny-by-default RBAC live. The lone exception is a service binding to
// api-edge ITSELF (the public entry): a Worker cannot reach a sibling
// `*.workers.dev` origin over `fetch()` (same-account workers.dev subrequests
// are not routed through the edge and return a bare Cloudflare 404), so the
// binding is how the client-not-service hop is actually made. The bearer is
// still forwarded verbatim and api-edge's rate-limit/audit/RBAC run unchanged —
// only the transport differs from a public URL round-trip.

export interface Env {
  /**
   * Service binding to api-edge (the public entry worker). Present in deployed
   * envs; absent locally (dev loop points API_EDGE_URL at a local api-edge and
   * uses global fetch) and in unit tests (which inject a fetch stub via deps).
   */
  API_EDGE?: Fetcher;
  /** Public api-edge base URL — used to build request URLs (and as the egress
   *  in local dev where the service binding is absent). Per-env var. */
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
