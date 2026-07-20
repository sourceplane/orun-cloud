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
import { createEntitlementGate, createMcpServer } from "@saas/mcp";
import { OrunCloud, OrunCloudError } from "@saas/sdk";

import type { McpWorkerDeps } from "../deps.js";
import type { Env } from "../env.js";
import { errorResponse } from "../http.js";

const BEARER_RE = /^Bearer\s+(\S+)$/i;

// How long a successful bearer probe is trusted before re-checking api-edge.
const AUTH_PROBE_TTL_MS = 60_000;

/**
 * Pre-flight bearer check (self-healing OAuth). api-edge rejects an
 * expired/invalid bearer with 401, but inside a tool call that surfaces as a
 * JSON-RPC tool ERROR (HTTP 200) — which MCP clients do NOT treat as an auth
 * challenge, so an expired access token would silently break the connection
 * instead of triggering the client's refresh. Probing a cheap authenticated
 * endpoint up front lets the transport answer a hard 401 at the HTTP level with
 * `WWW-Authenticate`, the signal the client needs to refresh and retry.
 *
 * Cached per token (short TTL, per-isolate) so a burst of messages on one
 * connection pays at most one probe. NON-401 failures fail OPEN — a transient
 * api-edge blip must never masquerade as an auth failure and force a needless
 * re-auth (matches the entitlement gate's fail-open posture).
 */
async function bearerRejected(
  sdk: OrunCloud,
  token: string,
  cache: Map<string, number>,
): Promise<boolean> {
  const validUntil = cache.get(token);
  if (validUntil !== undefined && validUntil > Date.now()) return false;
  try {
    await sdk.auth.getProfile();
    cache.set(token, Date.now() + AUTH_PROBE_TTL_MS);
    return false;
  } catch (err) {
    if (err instanceof OrunCloudError && err.status === 401) return true;
    return false; // transient / non-401 → fail open
  }
}

export async function handleMcpPost(
  request: Request,
  env: Env,
  deps: McpWorkerDeps,
  requestId: string,
  executionCtx?: ExecutionContext,
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

  // Reach api-edge through its service binding when bound (all deployed envs):
  // a Worker's global `fetch()` to a sibling `*.workers.dev` origin is not
  // routed through the edge and returns a bare Cloudflare 404, so every tool
  // call would fail. `env.API_EDGE.fetch` dispatches straight to the api-edge
  // worker, which handles the forwarded bearer + RBAC exactly as for a public
  // request. Local dev / unit tests leave the binding unset and fall back to
  // the deps fetch (global fetch → local API_EDGE_URL, or an injected stub).
  const edgeFetch: typeof fetch = env.API_EDGE
    ? (env.API_EDGE.fetch.bind(env.API_EDGE) as typeof fetch)
    : deps.fetch;

  const sdk = new OrunCloud({
    baseUrl: env.API_EDGE_URL,
    auth: { kind: "bearer", token },
    fetch: edgeFetch,
  });
  // readOnly: true — the remote transport serves ONLY the 19-tool read set,
  // hard-excluding the MCP5 write tools from tools/list and execution
  // (design §7 "Read-only mode"). Flipping remote writes on is a DELIBERATE
  // later change (per-connection read-only + stage acceptance first) — do not
  // toggle this casually.
  //
  // MCP6 (design §8):
  // - gate: `feature.mcp_server` checked LAZILY on the first tool call that
  //   carries a `workspace` (tenancy here is per tool call, so there is no
  //   workspace to check at connect time). Decisions ride the per-isolate
  //   TTL cache in deps; the check itself is a public billing entitlements
  //   read on the caller's own credential — still client-not-service. The
  //   D3 default is the OPEN gate: only an explicit disabled row denies.
  // - usage: every successful tool call fire-and-forgets one `mcp.tool_call`
  //   event through the public metering ingest, waitUntil-scheduled so it
  //   outlives the response without ever blocking it.
  // Constructing the server stamps `x-client-surface: mcp` onto the sdk's
  // default headers, so it must happen BEFORE the auth probe below for the
  // probe request to carry the same provenance as every other MCP-plane call.
  const server = createMcpServer({
    sdk,
    readOnly: true,
    gate: createEntitlementGate({ sdk, cache: deps.entitlementCache }),
    usage: {
      enabled: true,
      transport: "http",
      ...(executionCtx !== undefined
        ? { schedule: (task: Promise<void>) => executionCtx.waitUntil(task) }
        : {}),
    },
  });

  // Self-healing auth: a rejected bearer answers 401 + the protected-resource
  // challenge (so the MCP client refreshes), instead of letting an expired
  // token surface as a silent per-tool error.
  if (await bearerRejected(sdk, token, deps.authCache)) {
    const origin = new URL(request.url).origin;
    return errorResponse("unauthenticated", "Authentication failed", 401, requestId, {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  // No sessionIdGenerator = stateless mode (exactOptionalPropertyTypes forbids
  // the explicit `sessionIdGenerator: undefined` spelling).
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
