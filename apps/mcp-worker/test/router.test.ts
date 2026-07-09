import { allTools, readOnlyTools } from "@saas/mcp";
import { describe, expect, it } from "vitest";

import type { McpWorkerDeps } from "../src/deps.js";
import type { Env } from "../src/env.js";
import { MAX_CONCURRENT_REQUESTS, route } from "../src/router.js";

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

function initializeMessage(id = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

/** SDK-envelope fetch stub for api-edge routes the whoami tool calls. */
function apiEdgeStub(
  calls: Array<{ url: string; authorization: string | null; clientSurface: string | null }>,
): McpWorkerDeps {
  const stub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      clientSurface: request.headers.get("x-client-surface"),
    });
    const envelope = (data: unknown) =>
      Response.json({ data, meta: { requestId: "req_stub", cursor: null } });
    if (pathname === "/v1/auth/profile") {
      return envelope({ user: { id: "usr_1", email: "a@b.test", displayName: null } });
    }
    if (pathname === "/v1/workspaces") {
      return envelope({ organizations: [] });
    }
    return Response.json(
      { error: { code: "not_found", message: "nope", details: {}, requestId: "req_stub" } },
      { status: 404 },
    );
  };
  return { fetch: stub };
}

async function rpc(body: unknown, deps?: McpWorkerDeps): Promise<JsonRpcResponse> {
  const res = await route(rpcRequest(body), env, deps ?? apiEdgeStub([]));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as JsonRpcResponse;
}

describe("mcp-worker route", () => {
  it("answers initialize with serverInfo orun-cloud, statelessly (no session id)", async () => {
    const res = await route(rpcRequest(initializeMessage()), env, apiEdgeStub([]));
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as JsonRpcResponse;
    expect((body.result?.["serverInfo"] as { name: string }).name).toBe("orun-cloud");
  });

  it("accepts POST / as the MCP endpoint too", async () => {
    const req = new Request(`${BASE}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer sk_test_token",
      },
      body: JSON.stringify(initializeMessage()),
    });
    const res = await route(req, env, apiEdgeStub([]));
    expect(res.status).toBe(200);
  });

  it("lists exactly the 19 read-only tools — never the MCP5 write set (readOnly remote)", async () => {
    const body = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = body.result?.["tools"] as Array<{ name: string }>;
    expect(tools.length).toBe(19);
    expect(tools.length).toBe(readOnlyTools.length);
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
    // The registry now carries write tools; the remote surface must not.
    for (const tool of allTools) {
      if (tool.annotations.readOnlyHint !== true) {
        expect(names, tool.name).not.toContain(tool.name);
      }
    }
  });

  it("executes whoami via the SDK against a stubbed api-edge, forwarding the bearer verbatim", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      clientSurface: string | null;
    }> = [];
    const body = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
      apiEdgeStub(calls),
    );
    expect(body.result?.["isError"]).toBeFalsy();
    expect(body.result?.["structuredContent"]).toEqual({
      user: { id: "usr_1", email: "a@b.test", displayName: null },
      workspaces: [],
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://api.test/")).toBe(true);
      expect(call.authorization).toBe("Bearer sk_test_token");
      // Provenance (MCP5, design §7): every SDK call from the MCP plane is
      // marked so audit queries can segment agent traffic.
      expect(call.clientSurface).toBe("mcp");
    }
  });

  it("401s without a bearer and points at the protected-resource metadata", async () => {
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(initializeMessage()),
    });
    const res = await route(req, env, apiEdgeStub([]));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("401s a malformed Authorization header", async () => {
    const res = await route(
      rpcRequest(initializeMessage(), { authorization: "Basic abc" }),
      env,
      apiEdgeStub([]),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("405s GET /mcp with Allow: POST", async () => {
    const res = await route(new Request(`${BASE}/mcp`), env, apiEdgeStub([]));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns -32700 on unparseable JSON", async () => {
    const res = await route(rpcRequest("{not json"), env, apiEdgeStub([]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("serves RFC 9728 protected-resource metadata naming the authorization server (MCP3)", async () => {
    const res = await route(
      new Request(`${BASE}/.well-known/oauth-protected-resource`),
      env,
      apiEdgeStub([]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Raw spec-shaped JSON — no platform envelope.
    expect(body).toEqual({
      resource: BASE,
      authorization_servers: ["https://api.test"],
      bearer_methods_supported: ["header"],
    });
  });

  it("normalizes a trailing slash on the configured authorization-server URL", async () => {
    const res = await route(
      new Request(`${BASE}/.well-known/oauth-protected-resource`),
      { ...env, OAUTH_AUTHORIZATION_SERVER_URL: "https://api.test/" },
      apiEdgeStub([]),
    );
    const body = (await res.json()) as { authorization_servers: string[] };
    expect(body.authorization_servers).toEqual(["https://api.test"]);
  });

  it("404s the protected-resource metadata when the issuer var is unset", async () => {
    const res = await route(
      new Request(`${BASE}/.well-known/oauth-protected-resource`),
      { ENVIRONMENT: "test", API_EDGE_URL: "https://api.test" },
      apiEdgeStub([]),
    );
    expect(res.status).toBe(404);
  });

  it("405s non-GET on the protected-resource metadata", async () => {
    const res = await route(
      new Request(`${BASE}/.well-known/oauth-protected-resource`, { method: "POST" }),
      env,
      apiEdgeStub([]),
    );
    expect(res.status).toBe(405);
  });

  it("503s when API_EDGE_URL is not configured", async () => {
    const res = await route(rpcRequest(initializeMessage()), { ENVIRONMENT: "test" }, apiEdgeStub([]));
    expect(res.status).toBe(503);
  });

  it("serves /health with the tool count, no auth required", async () => {
    const res = await route(new Request(`${BASE}/health`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ok: boolean; service: string; name: string; toolCount: number };
    };
    expect(body.data.ok).toBe(true);
    expect(body.data.service).toBe("mcp-worker");
    expect(body.data.name).toBe("orun-cloud");
    expect(body.data.toolCount).toBe(19);
  });

  it("429s with Retry-After past the in-flight cap, then recovers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    const slowDeps: McpWorkerDeps = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        held++;
        await gate;
        return apiEdgeStub([]).fetch(input, init);
      }) as typeof fetch,
    };
    const call = () =>
      route(
        rpcRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "whoami", arguments: {} } }),
        env,
        slowDeps,
      );
    const saturating = Array.from({ length: MAX_CONCURRENT_REQUESTS }, call);
    // Let the saturating calls reach the (gated) SDK fetch before overflowing.
    while (held < MAX_CONCURRENT_REQUESTS) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const overflow = await call();
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("retry-after")).toBe("1");
    release();
    const settled = await Promise.all(saturating);
    for (const res of settled) expect(res.status).toBe(200);
    // Cap releases: a follow-up request is served again.
    const after = await route(rpcRequest(initializeMessage()), env, apiEdgeStub([]));
    expect(after.status).toBe(200);
  });
});
