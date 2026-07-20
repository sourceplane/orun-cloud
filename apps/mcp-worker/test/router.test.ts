import { allTools, readOnlyTools } from "@saas/mcp";
import type { EntitlementGateCache } from "@saas/mcp";
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
  return { fetch: stub, entitlementCache: new Map(), authCache: new Map() };
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

  it("dispatches SDK calls through the api-edge service binding when bound (sibling *.workers.dev fetch would bare-404)", async () => {
    const bindingCalls: string[] = [];
    // The binding's fetch answers; the deps fetch THROWS if touched — proving
    // the SDK went through env.API_EDGE, not global/deps fetch.
    const boundStub = apiEdgeStub([]);
    const apiEdge = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bindingCalls.push(typeof input === "string" ? input : input.toString());
        return boundStub.fetch(input, init);
      }) as typeof fetch,
    } as unknown as Fetcher;
    const explodingDeps: McpWorkerDeps = {
      fetch: (async () => {
        throw new Error("deps.fetch must not be used when API_EDGE is bound");
      }) as typeof fetch,
      entitlementCache: new Map(),
      authCache: new Map(),
    };
    const res = await route(
      rpcRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "whoami", arguments: {} } }),
      { ...env, API_EDGE: apiEdge },
      explodingDeps,
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.result?.["isError"]).toBeFalsy();
    expect(bindingCalls.length).toBeGreaterThan(0);
    expect(bindingCalls.every((u) => u.startsWith("https://api.test/"))).toBe(true);
  });

  it("answers a rejected bearer with 401 + the refresh challenge (self-healing), not a silent tool error", async () => {
    // api-edge rejects the bearer (expired/invalid). Without the pre-flight the
    // failure would surface as a JSON-RPC tool error (HTTP 200) the client
    // ignores; the probe promotes it to a real 401 so the client refreshes.
    const rejectingDeps: McpWorkerDeps = {
      fetch: (async () =>
        Response.json(
          { error: { code: "unauthenticated", message: "Authentication failed", details: {}, requestId: "req_stub" } },
          { status: 401 },
        )) as typeof fetch,
      entitlementCache: new Map(),
      authCache: new Map(),
    };
    const res = await route(
      rpcRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "whoami", arguments: {} } }),
      env,
      rejectingDeps,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("a transient (non-401) api-edge failure on the auth probe fails OPEN — the tool call still proceeds", async () => {
    // Only a hard 401 forces re-auth; a 500/timeout must not masquerade as one.
    let firstProbe = true;
    const flakyProbeDeps: McpWorkerDeps = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { pathname } = new URL(new Request(input, init).url);
        // The probe hits /v1/workspaces (the tool-plane auth path); blip the
        // first one only, so the whoami tool's own list call still succeeds.
        if (pathname === "/v1/workspaces" && firstProbe) {
          firstProbe = false;
          return Response.json(
            { error: { code: "internal_error", message: "blip", details: {}, requestId: "req_stub" } },
            { status: 500 },
          );
        }
        return apiEdgeStub([]).fetch(input, init);
      }) as typeof fetch,
      entitlementCache: new Map(),
      authCache: new Map(),
    };
    const res = await route(
      rpcRequest({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "whoami", arguments: {} } }),
      env,
      flakyProbeDeps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.result?.["isError"]).toBeFalsy();
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
      data: {
        ok: boolean;
        service: string;
        name: string;
        toolCount: number;
        checks: { apiEdgeBinding: { bound: boolean } };
      };
    };
    expect(body.data.ok).toBe(true);
    expect(body.data.service).toBe("mcp-worker");
    expect(body.data.name).toBe("orun-cloud");
    expect(body.data.toolCount).toBe(19);
    // env in this suite has no API_EDGE binding → reported unbound.
    expect(body.data.checks.apiEdgeBinding.bound).toBe(false);
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
      entitlementCache: new Map(),
      authCache: new Map(),
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

// ---------------------------------------------------------------------------
// MCP6 — entitlement gate + mcp.tool_call metering (design §8)
// ---------------------------------------------------------------------------

describe("mcp-worker MCP6 (entitlement gate + usage metering)", () => {
  const WS = "org_a1b2";

  interface Mcp6Recorder {
    entitlementReads: number;
    usagePosts: Array<{ org: string; body: Record<string, unknown> }>;
  }

  /**
   * api-edge stub for the MCP6 seams: the public billing entitlements read,
   * the public usage ingest, and one workspace-scoped read tool (quota_check).
   */
  function mcp6Stub(
    rec: Mcp6Recorder,
    opts: {
      mcpServerRow?: "enabled" | "disabled" | "missing";
      failIngest?: boolean;
      cache?: EntitlementGateCache;
    } = {},
  ): McpWorkerDeps {
    const row = opts.mcpServerRow ?? "enabled";
    const stub: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      const envelope = (data: unknown) =>
        Response.json({ data, meta: { requestId: "req_stub", cursor: null } });
      if (pathname === `/v1/organizations/${WS}/billing/entitlements`) {
        rec.entitlementReads++;
        const entitlements =
          row === "missing"
            ? []
            : [
                {
                  id: "ent_1",
                  orgId: WS,
                  subscriptionId: null,
                  entitlementKey: "feature.mcp_server",
                  valueType: "boolean",
                  enabled: row === "enabled",
                  limitValue: null,
                  source: "plan",
                  metadata: null,
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ];
        return envelope({ entitlements });
      }
      if (pathname === `/v1/organizations/${WS}/usage` && request.method === "POST") {
        rec.usagePosts.push({ org: WS, body: (await request.json()) as Record<string, unknown> });
        if (opts.failIngest === true) {
          return Response.json(
            { error: { code: "internal_error", message: "down", details: {}, requestId: "req_stub" } },
            { status: 500 },
          );
        }
        return envelope({ usageRecord: {} });
      }
      if (pathname === `/v1/organizations/${WS}/quotas/check`) {
        return envelope({
          metric: "state.runs",
          allowed: true,
          limit: 100,
          used: 5,
          remaining: 95,
          period: "month",
          enforcement: "soft",
        });
      }
      return Response.json(
        { error: { code: "not_found", message: "nope", details: {}, requestId: "req_stub" } },
        { status: 404 },
      );
    };
    return { fetch: stub, entitlementCache: opts.cache ?? new Map(), authCache: new Map() };
  }

  function quotaCheckCall(id: number): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "quota_check", arguments: { workspace: WS, metric: "state.runs" } },
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("first workspace-carrying tool call checks the entitlement once; the second is served from the shared cache", async () => {
    const rec: Mcp6Recorder = { entitlementReads: 0, usagePosts: [] };
    const cache: EntitlementGateCache = new Map();
    const first = await rpc(quotaCheckCall(11), mcp6Stub(rec, { cache }));
    expect(first.result?.["isError"]).toBeFalsy();
    expect(rec.entitlementReads).toBe(1);
    // Fresh POST/server (stateless worker) but the SAME per-isolate cache:
    // no second entitlements read inside the TTL.
    const second = await rpc(quotaCheckCall(12), mcp6Stub(rec, { cache }));
    expect(second.result?.["isError"]).toBeFalsy();
    expect(rec.entitlementReads).toBe(1);
  });

  it("a workspace with no feature.mcp_server row is GRANTED — the D3 open-gate default", async () => {
    const rec: Mcp6Recorder = { entitlementReads: 0, usagePosts: [] };
    const body = await rpc(quotaCheckCall(13), mcp6Stub(rec, { mcpServerRow: "missing" }));
    expect(body.result?.["isError"]).toBeFalsy();
    expect(rec.entitlementReads).toBe(1);
  });

  it("a disabled entitlement surfaces the platform's upgrade-shaped entitlement_required tool error", async () => {
    const rec: Mcp6Recorder = { entitlementReads: 0, usagePosts: [] };
    const body = await rpc(quotaCheckCall(14), mcp6Stub(rec, { mcpServerRow: "disabled" }));
    expect(body.result?.["isError"]).toBe(true);
    const content = body.result?.["content"] as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("entitlement_required");
    expect(content[0]!.text).toContain("feature.mcp_server");
    // Gated calls never reach the wrapped route and never meter.
    await flush();
    expect(rec.usagePosts).toHaveLength(0);
  });

  it("whoami (no workspace in scope) is neither gated nor metered", async () => {
    const rec: Mcp6Recorder = { entitlementReads: 0, usagePosts: [] };
    const body = await rpc(
      { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "whoami", arguments: {} } },
      (() => {
        // Reuse the orientation stub for whoami's routes but count MCP6 traffic.
        const base = mcp6Stub(rec);
        const orientation = apiEdgeStub([]);
        const fetchImpl: typeof fetch = async (input, init) => {
          const { pathname } = new URL(new Request(input, init).url);
          if (pathname.startsWith("/v1/auth/") || pathname === "/v1/workspaces") {
            return orientation.fetch(input, init);
          }
          return base.fetch(input, init);
        };
        return { fetch: fetchImpl, entitlementCache: base.entitlementCache, authCache: base.authCache };
      })(),
    );
    expect(body.result?.["isError"]).toBeFalsy();
    await flush();
    expect(rec.entitlementReads).toBe(0);
    expect(rec.usagePosts).toHaveLength(0);
  });

  it("a successful tool call emits exactly one mcp.tool_call usage event through the public ingest (transport http)", async () => {
    const rec: Mcp6Recorder = { entitlementReads: 0, usagePosts: [] };
    const body = await rpc(quotaCheckCall(16), mcp6Stub(rec));
    expect(body.result?.["isError"]).toBeFalsy();
    await flush();
    expect(rec.usagePosts).toHaveLength(1);
    const event = rec.usagePosts[0]!;
    expect(event.org).toBe(WS);
    expect(event.body["metric"]).toBe("mcp.tool_call");
    expect(event.body["quantity"]).toBe(1);
    expect(event.body["metadata"]).toEqual({ tool: "quota_check", transport: "http" });
    expect(String(event.body["idempotencyKey"])).toMatch(/^mcp_call_/);
  });

  it("an ingest failure never fails the tool call", async () => {
    const rec: Mcp6Recorder = { entitlementReads: 0, usagePosts: [] };
    const body = await rpc(quotaCheckCall(17), mcp6Stub(rec, { failIngest: true }));
    expect(body.result?.["isError"]).toBeFalsy();
    await flush();
    expect(rec.usagePosts).toHaveLength(1);
  });
});
