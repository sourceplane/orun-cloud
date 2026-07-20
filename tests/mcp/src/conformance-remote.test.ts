// Protocol conformance — remote transport (saas-mcp-server MCP8).
//
// Drives `apps/mcp-worker`'s stateless Streamable-HTTP surface through
// `route()` with an injected api-edge fetch stub serving the same seeded org
// as the local matrix (the tests/mcp-worker injectedDeps pattern) — the same
// protocol matrix as conformance-local plus the transport-only cases: 401
// challenge, malformed bearer, verbatim bearer forwarding, -32700 on
// unparseable JSON.

import { readOnlyTools } from "@saas/mcp";
import type { McpWorkerDeps } from "@mcp-worker/deps";
import type { Env } from "@mcp-worker/env";
import { route } from "@mcp-worker/router";

import {
  billingWorkerEntity,
  catalogEntities,
  organization,
  user,
  WORKSPACE,
} from "./fixtures.js";
import { PROTOCOL_VERSION } from "./raw-client.js";

const env: Env = {
  ENVIRONMENT: "test",
  API_EDGE_URL: "https://api.test",
  OAUTH_AUTHORIZATION_SERVER_URL: "https://api.test",
};
const BASE = "https://mcp-worker.test";
const BEARER = "Bearer sk_conformance_token";

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface RecordedCall {
  path: string;
  authorization: string | null;
  clientSurface: string | null;
}

/** api-edge fetch stub serving the seeded org (+ the MCP6 seams, granted). */
function seededApiEdge(calls: RecordedCall[] = []): McpWorkerDeps {
  const stub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({
      path: pathname,
      authorization: request.headers.get("authorization"),
      clientSurface: request.headers.get("x-client-surface"),
    });
    const envelope = (data: unknown) =>
      Response.json({ data, meta: { requestId: "req_stub", cursor: null } });
    if (pathname === "/v1/auth/profile") return envelope({ user });
    if (pathname === "/v1/workspaces") return envelope({ organizations: [organization] });
    if (pathname === `/v1/organizations/${WORKSPACE}/catalog/entities`) {
      return envelope({ entities: catalogEntities, nextCursor: null });
    }
    if (pathname === `/v1/organizations/${WORKSPACE}/billing/entitlements`) {
      // MCP6 open-gate default: no feature.mcp_server row → granted.
      return envelope({ entitlements: [] });
    }
    if (pathname === `/v1/organizations/${WORKSPACE}/usage` && request.method === "POST") {
      return envelope({ usageRecord: {} });
    }
    return Response.json(
      { error: { code: "not_found", message: "nope", details: {}, requestId: "req_stub" } },
      { status: 404 },
    );
  };
  return { fetch: stub, entitlementCache: new Map(), authCache: new Map() };
}

function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: BEARER,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rpc(body: unknown, deps?: McpWorkerDeps): Promise<JsonRpcResponse> {
  const res = await route(rpcRequest(body), env, deps ?? seededApiEdge());
  expect(res.status).toBe(200);
  return (await res.json()) as JsonRpcResponse;
}

const initializeMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-conformance", version: "0.0.0" },
  },
};

describe("initialize", () => {
  it("negotiates the pinned protocol revision with tools/resources/prompts capabilities, statelessly", async () => {
    const res = await route(rpcRequest(initializeMessage), env, seededApiEdge());
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.result?.["protocolVersion"]).toBe(PROTOCOL_VERSION);
    const capabilities = body.result?.["capabilities"] as Record<string, unknown>;
    expect(capabilities["tools"]).toBeDefined();
    expect(capabilities["resources"]).toBeDefined();
    expect(capabilities["prompts"]).toBeDefined();
    expect((body.result?.["serverInfo"] as { name: string }).name).toBe("orun-cloud");
  });
});

describe("tools", () => {
  it("tools/list serves exactly the 19-tool read-only roster (remote stays readOnly)", async () => {
    const body = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = body.result?.["tools"] as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(readOnlyTools.map((t) => t.name));
    expect(tools).toHaveLength(19);
  });

  it("tools/call executes against the seeded org, forwarding the bearer verbatim with mcp provenance", async () => {
    const calls: RecordedCall[] = [];
    const body = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "catalog_get_entity",
          arguments: { workspace: WORKSPACE, entityRef: billingWorkerEntity.entityRef },
        },
      },
      seededApiEdge(calls),
    );
    const result = body.result as {
      isError?: boolean;
      structuredContent?: { entities: Array<{ owner: string | null }> };
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.entities[0]?.owner).toBe("team-payments");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.authorization).toBe(BEARER);
      expect(call.clientSurface).toBe("mcp");
    }
  });

  it("an unknown tool is a JSON-RPC error, not a crash — the next request is served", async () => {
    const body = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    });
    expect(body.error ?? (body.result as { isError?: boolean }).isError).toBeTruthy();
    const after = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    expect(after.error).toBeUndefined();
  });
});

describe("resources + prompts", () => {
  it("resources/templates/list serves the 2 MCP4 templates", async () => {
    const body = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/templates/list",
      params: {},
    });
    const templates = body.result?.["resourceTemplates"] as Array<{ uriTemplate: string }>;
    expect(templates).toHaveLength(2);
    const uris = templates.map((t) => t.uriTemplate);
    expect(uris.some((u) => u.startsWith("catalog://"))).toBe(true);
    expect(uris.some((u) => u.startsWith("runs://"))).toBe(true);
  });

  it("prompts/list + prompts/get work over the remote transport", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 7, method: "prompts/list", params: {} });
    const prompts = list.result?.["prompts"] as Array<{ name: string }>;
    expect(prompts).toHaveLength(4);
    const get = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "prompts/get",
      params: { name: "investigate_failed_run", arguments: { workspace: WORKSPACE } },
    });
    expect(get.error).toBeUndefined();
    const messages = get.result?.["messages"] as Array<{ content: { text: string } }>;
    expect(messages[0]!.content.text).toContain("runs_get");
  });
});

describe("transport auth + framing", () => {
  it("401s without a bearer, challenging with the RFC 9728 resource metadata", async () => {
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeMessage),
    });
    const res = await route(req, env, seededApiEdge());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
    );
  });

  it("401s a malformed Authorization scheme", async () => {
    const res = await route(
      rpcRequest(initializeMessage, { authorization: "Basic abc" }),
      env,
      seededApiEdge(),
    );
    expect(res.status).toBe(401);
  });

  it("returns -32700 on unparseable JSON", async () => {
    const res = await route(rpcRequest("{not json"), env, seededApiEdge());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});
