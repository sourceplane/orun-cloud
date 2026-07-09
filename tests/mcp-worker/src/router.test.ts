// Verify-lane smoke for apps/mcp-worker (saas-mcp-server MCP2): the stateless
// Streamable HTTP surface driven through route() with an injected api-edge
// fetch stub — no network. The fuller unit suite lives in
// apps/mcp-worker/test/ (vitest); this component puts the protocol smoke in
// the quick-check lane like tests/agents-worker does for its worker.

import { allTools } from "@saas/mcp";
import type { McpWorkerDeps } from "@mcp-worker/deps";
import type { Env } from "@mcp-worker/env";
import { route } from "@mcp-worker/router";

const env: Env = {
  ENVIRONMENT: "test",
  API_EDGE_URL: "https://api.test",
  OAUTH_AUTHORIZATION_SERVER_URL: "https://api.test",
};
const BASE = "https://mcp-worker.test";

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer sk_test_token",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  },
};

const stubDeps: McpWorkerDeps = {
  fetch: (async () =>
    Response.json({ data: {}, meta: { requestId: "req_stub", cursor: null } })) as typeof fetch,
};

describe("mcp-worker route (smoke)", () => {
  it("answers initialize with serverInfo orun-cloud and no session id", async () => {
    const res = await route(rpcRequest(initialize), env, stubDeps);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as JsonRpcResponse;
    expect((body.result?.["serverInfo"] as { name: string }).name).toBe("orun-cloud");
  });

  it("lists the full 19-tool read-only roster", async () => {
    const res = await route(
      rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      env,
      stubDeps,
    );
    const body = (await res.json()) as JsonRpcResponse;
    const tools = body.result?.["tools"] as Array<{ name: string }>;
    expect(tools.length).toBe(19);
    expect(tools.length).toBe(allTools.length);
  });

  it("401s without a bearer, challenging with resource metadata", async () => {
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(initialize),
    });
    const res = await route(req, env, stubDeps);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  });

  it("405s GET /mcp with Allow: POST", async () => {
    const res = await route(new Request(`${BASE}/mcp`), env, stubDeps);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns -32700 on unparseable JSON", async () => {
    const res = await route(rpcRequest("{not json"), env, stubDeps);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("serves the RFC 9728 protected-resource metadata the 401 challenge points at (MCP3)", async () => {
    const res = await route(new Request(`${BASE}/.well-known/oauth-protected-resource`), env, stubDeps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      resource: BASE,
      authorization_servers: ["https://api.test"],
      bearer_methods_supported: ["header"],
    });
  });

  it("serves /health with the tool count", async () => {
    const res = await route(new Request(`${BASE}/health`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean; toolCount: number } };
    expect(body.data.ok).toBe(true);
    expect(body.data.toolCount).toBe(19);
  });
});
