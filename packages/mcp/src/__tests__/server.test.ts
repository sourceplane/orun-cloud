import { OrunCloud } from "@saas/sdk";
import { describe, expect, it, vi } from "vitest";

import { allTools, readOnlyTools } from "../registry.js";
import {
  CLIENT_SURFACE_HEADER,
  CLIENT_SURFACE_VALUE,
  createMcpServer,
  SERVER_NAME,
} from "../server.js";

import { connectedClient, stubSdk } from "./helpers.js";

describe("createMcpServer", () => {
  it("exposes every registry tool over the protocol, annotations included", async () => {
    const server = createMcpServer({ sdk: stubSdk({}) });
    const client = await connectedClient(server);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      allTools.map((t) => t.name).sort(),
    );
    for (const tool of listed.tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
      expect(tool.description, tool.name).toBeTruthy();
    }
    await client.close();
  });

  it("executes a tool end-to-end through the SDK stub", async () => {
    const sdk = stubSdk({
      auth: { getProfile: vi.fn().mockResolvedValue({ user: { id: "usr_1", email: "e@x.test", displayName: null } }) },
      workspaces: { list: vi.fn().mockResolvedValue({ organizations: [] }) },
    });
    const server = createMcpServer({ sdk });
    const client = await connectedClient(server);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      user: { id: "usr_1", email: "e@x.test", displayName: null },
      workspaces: [],
    });
    await client.close();
  });

  it("readOnly mode hard-excludes the write tools from tools/list (design §7)", async () => {
    const server = createMcpServer({ sdk: stubSdk({}), readOnly: true });
    const client = await connectedClient(server);
    const listed = await client.listTools();
    expect(listed.tools.length).toBe(readOnlyTools.length);
    expect(listed.tools.length).toBe(19);
    const names = listed.tools.map((t) => t.name);
    for (const tool of allTools) {
      if (tool.annotations.readOnlyHint !== true) {
        expect(names, tool.name).not.toContain(tool.name);
      }
    }
    await client.close();
  });

  it("names the server orun-cloud", () => {
    expect(SERVER_NAME).toBe("orun-cloud");
  });
});

describe("provenance (x-client-surface: mcp, design §7)", () => {
  /** A real OrunCloud over a spying fetch, so header assembly is end-to-end. */
  function spiedSdk(respond: (path: string) => unknown) {
    const requests: Array<{ path: string; headers: Headers }> = [];
    const fetchSpy: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ path: new URL(request.url).pathname, headers: request.headers });
      return Response.json({
        data: respond(new URL(request.url).pathname),
        meta: { requestId: "req_stub", cursor: null },
      });
    };
    const sdk = new OrunCloud({
      baseUrl: "https://api.test",
      auth: { kind: "bearer", token: "sk_test" },
      fetch: fetchSpy,
    });
    return { sdk, requests };
  }

  it("stamps the header on every SDK call of a READ tool, protocol-level", async () => {
    const { sdk, requests } = spiedSdk((path) => {
      if (path === "/v1/auth/profile") {
        return { user: { id: "usr_1", email: "e@x.test", displayName: null } };
      }
      return { organizations: [] };
    });
    const client = await connectedClient(createMcpServer({ sdk }));
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(req.headers.get(CLIENT_SURFACE_HEADER), req.path).toBe(CLIENT_SURFACE_VALUE);
    }
    await client.close();
  });

  it("stamps the header on a WRITE tool call, alongside the Idempotency-Key", async () => {
    const { sdk, requests } = spiedSdk(() => ({
      project: { id: "prj_1", slug: "api", name: "API" },
    }));
    const client = await connectedClient(createMcpServer({ sdk }));
    const result = await client.callTool({
      name: "project_create",
      arguments: { workspace: "ws_1", name: "API" },
    });
    expect(result.isError).toBeFalsy();
    expect(requests.length).toBe(1);
    const headers = requests[0]!.headers;
    expect(headers.get(CLIENT_SURFACE_HEADER)).toBe(CLIENT_SURFACE_VALUE);
    expect(headers.get("idempotency-key")).toMatch(/^mcp_/);
    expect(headers.get("authorization")).toBe("Bearer sk_test");
    await client.close();
  });
});
