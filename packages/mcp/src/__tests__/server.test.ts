import { describe, expect, it, vi } from "vitest";

import { allTools } from "../registry.js";
import { createMcpServer, SERVER_NAME } from "../server.js";

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
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
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

  it("readOnly mode keeps the full MCP0 set (all tools are read-only)", async () => {
    const server = createMcpServer({ sdk: stubSdk({}), readOnly: true });
    const client = await connectedClient(server);
    const listed = await client.listTools();
    expect(listed.tools.length).toBe(allTools.length);
    await client.close();
  });

  it("names the server orun-cloud", () => {
    expect(SERVER_NAME).toBe("orun-cloud");
  });
});
