// Protocol conformance — local transport (saas-mcp-server MCP8).
//
// TRANSPORT CHOICE (stated per the plan): this matrix drives `createMcpServer`
// over `InMemoryTransport` — the exact server object `orun-cloud mcp serve`
// connects a `StdioServerTransport` to (packages/cli/src/commands/mcp.ts).
// The repo convention is in-process transports everywhere (packages/mcp's
// InMemoryTransport e2e, tests/mcp-worker's route() smoke); no component
// spawns built CLI artifacts, and building `packages/cli` dist inside a
// verify-lane jest component would invert that. Process-level stdio framing
// stays covered by the CLI's own MCP1 tests + smoke; everything protocol-level
// above the framing is identical by construction and pinned here.

import { allPrompts, allResources, allTools, createMcpServer, readOnlyTools, SERVER_NAME } from "@saas/mcp";

import { billingWorkerEntity, seededSdk, WORKSPACE } from "./fixtures.js";
import { connectRaw, PROTOCOL_VERSION } from "./raw-client.js";

import type { RawMcpClient, RawRpcResponse } from "./raw-client.js";

let client: RawMcpClient;
let initialize: RawRpcResponse;

beforeAll(async () => {
  ({ client, initialize } = await connectRaw(createMcpServer({ sdk: seededSdk() })));
});

afterAll(async () => {
  await client.close();
});

describe("initialize", () => {
  it("negotiates the pinned protocol revision (risk D6: 2025-06-18)", () => {
    expect(initialize.error).toBeUndefined();
    expect(initialize.result?.["protocolVersion"]).toBe(PROTOCOL_VERSION);
  });

  it("advertises tools, resources, and prompts capabilities under serverInfo orun-cloud", () => {
    const capabilities = initialize.result?.["capabilities"] as Record<string, unknown>;
    expect(capabilities["tools"]).toBeDefined();
    expect(capabilities["resources"]).toBeDefined();
    expect(capabilities["prompts"]).toBeDefined();
    const serverInfo = initialize.result?.["serverInfo"] as { name: string };
    expect(serverInfo.name).toBe(SERVER_NAME);
  });
});

describe("tools", () => {
  it("tools/list serves the full 25-tool registry, in registry order", async () => {
    const response = await client.request("tools/list");
    const tools = response.result?.["tools"] as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(allTools.map((t) => t.name));
    expect(tools).toHaveLength(25);
  });

  it("a read-only server advertises exactly the 19 read tools", async () => {
    const { client: roClient } = await connectRaw(
      createMcpServer({ sdk: seededSdk(), readOnly: true }),
    );
    const response = await roClient.request("tools/list");
    const tools = response.result?.["tools"] as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(readOnlyTools.map((t) => t.name));
    expect(tools).toHaveLength(19);
    await roClient.close();
  });

  it("tools/call executes a read tool against the seeded org (structured output + text)", async () => {
    const response = await client.request("tools/call", {
      name: "catalog_get_entity",
      arguments: { workspace: WORKSPACE, entityRef: billingWorkerEntity.entityRef },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as {
      isError?: boolean;
      structuredContent?: { entities: Array<{ owner: string | null }> };
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.entities[0]?.owner).toBe("team-payments");
    expect(result.content[0]?.text).toContain("team-payments");
  });

  it("an unknown tool is an error result, not a crash — the connection keeps serving", async () => {
    const response = await client.request("tools/call", {
      name: "no_such_tool",
      arguments: {},
    });
    // The MCP TS SDK surfaces unknown tools as an isError tool result
    // carrying the InvalidParams code (-32602) in the text.
    const result = response.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("-32602");
    // Liveness: the same connection answers the next request.
    const after = await client.request("tools/list");
    expect(after.error).toBeUndefined();
  });

  it("invalid arguments surface as an error result naming the bad fields, not a crash", async () => {
    const response = await client.request("tools/call", {
      name: "catalog_get_entity",
      arguments: {}, // missing required workspace + entityRef
    });
    const result = response.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("workspace");
    const after = await client.request("tools/list");
    expect(after.error).toBeUndefined();
  });
});

describe("resources", () => {
  it("resources/templates/list serves the 2 MCP4 templates (catalog + runs)", async () => {
    const response = await client.request("resources/templates/list");
    const templates = response.result?.["resourceTemplates"] as Array<{
      uriTemplate: string;
    }>;
    expect(templates).toHaveLength(allResources.length);
    expect(templates).toHaveLength(2);
    const uris = templates.map((t) => t.uriTemplate);
    expect(uris.some((u) => u.startsWith("catalog://"))).toBe(true);
    expect(uris.some((u) => u.startsWith("runs://"))).toBe(true);
  });
});

describe("prompts", () => {
  it("prompts/list serves the 4 MCP4 prompts", async () => {
    const response = await client.request("prompts/list");
    const prompts = response.result?.["prompts"] as Array<{ name: string }>;
    expect(prompts.map((p) => p.name).sort()).toEqual(
      allPrompts.map((p) => p.name).sort(),
    );
    expect(prompts).toHaveLength(4);
  });

  it("prompts/get renders investigate_failed_run referencing registered tools only", async () => {
    const response = await client.request("prompts/get", {
      name: "investigate_failed_run",
      arguments: { workspace: WORKSPACE },
    });
    expect(response.error).toBeUndefined();
    const messages = response.result?.["messages"] as Array<{
      content: { type: string; text: string };
    }>;
    const text = messages[0]!.content.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("runs_get");
    expect(text).toContain("runs_read_logs");
  });
});

describe("malformed JSON-RPC", () => {
  it("an unknown method gets -32601 and the connection survives", async () => {
    const response = await client.request("definitely/not_a_method");
    expect(response.error?.code).toBe(-32601);
    const after = await client.request("tools/list");
    expect(after.error).toBeUndefined();
  });
});
