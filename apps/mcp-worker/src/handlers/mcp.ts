// POST /mcp — the Streamable HTTP transport, stateless (risk D5: no Durable
// Object, no session store).
//
// Stateless posture, the simplest spec-compliant one:
// - Per POST we instantiate a fresh `createMcpServer` + a stateless
//   `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator:
//   undefined`), so NO `Mcp-Session-Id` is ever issued and any session id a
//   client sends is accepted-and-ignored (the transport performs no session
//   validation in stateless mode).
// - `enableJsonResponse: true`: responses are single `application/json`
//   messages, which the Streamable HTTP spec permits in place of SSE.
// - GET/DELETE never reach this handler — the router answers 405 with
//   `Allow: POST`, which the spec permits for servers that offer no
//   server-initiated stream and no session termination.
// - JSON-RPC parse errors → -32700, handled inside the SDK transport.
//
// Auth: the bearer is OPAQUE here — `sk_` API keys and AG6 agent-session
// tokens work identically because the token is forwarded verbatim to api-edge
// on every tool call, where actor resolution + deny-by-default RBAC live
// (design §2/§3, client-not-service).

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@saas/mcp";
import { OrunCloud } from "@saas/sdk";

import type { McpWorkerDeps } from "../deps.js";
import type { Env } from "../env.js";
import { errorResponse } from "../http.js";

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export async function handleMcpPost(
  request: Request,
  env: Env,
  deps: McpWorkerDeps,
  requestId: string,
): Promise<Response> {
  const token = BEARER_RE.exec(request.headers.get("authorization") ?? "")?.[1];
  if (token === undefined) {
    // Points at the RFC 9728 protected-resource metadata (MCP3), which names
    // the OAuth 2.1 authorization server (see router.ts).
    const origin = new URL(request.url).origin;
    return errorResponse("unauthenticated", "Authentication required", 401, requestId, {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  if (!env.API_EDGE_URL) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const sdk = new OrunCloud({
    baseUrl: env.API_EDGE_URL,
    auth: { kind: "bearer", token },
    fetch: deps.fetch,
  });
  // readOnly: true — the remote transport always serves the read-only toolset.
  // All MCP0 tools are read-only, so this is a no-op today, but it keeps the
  // MCP5 write set off the remote surface until deliberately enabled
  // (design §7 "Read-only mode").
  const server = createMcpServer({ sdk, readOnly: true });
  // No sessionIdGenerator = stateless mode (exactOptionalPropertyTypes forbids
  // the explicit `sessionIdGenerator: undefined` spelling).
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
