// Ambient `workspace` defaulting (MCP1, design §3): a transport that carries
// CLI context may pre-fill `workspace`, but only when the tool's schema has a
// `workspace` field and the caller omitted it — explicit input always wins.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { getTool } from "../registry.js";
import { applyWorkspaceDefault, createMcpServer } from "../server.js";

import { stubSdk } from "./helpers.js";

function mustGetTool(name: string) {
  const tool = getTool(name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return tool;
}

async function connectedClient(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("applyWorkspaceDefault", () => {
  const scoped = mustGetTool("projects_list");
  const unscoped = mustGetTool("whoami");

  it("fills workspace when the caller omitted it", () => {
    expect(applyWorkspaceDefault(scoped, {}, "ws_ctx")).toEqual({ workspace: "ws_ctx" });
    expect(applyWorkspaceDefault(scoped, undefined, "ws_ctx")).toEqual({ workspace: "ws_ctx" });
  });

  it("explicit caller input wins over the default", () => {
    const input = { workspace: "ws_explicit" };
    expect(applyWorkspaceDefault(scoped, input, "ws_ctx")).toBe(input);
  });

  it("leaves tools without a workspace field untouched", () => {
    const input = {};
    expect(applyWorkspaceDefault(unscoped, input, "ws_ctx")).toBe(input);
  });

  it("is a pass-through when no default is configured", () => {
    const input = {};
    expect(applyWorkspaceDefault(scoped, input, undefined)).toBe(input);
  });
});

describe("createMcpServer defaultWorkspace", () => {
  it("defaults workspace over the protocol when the caller omits it", async () => {
    const list = vi.fn().mockResolvedValue({ projects: [] });
    const server = createMcpServer({
      sdk: stubSdk({ repos: { list } }),
      defaultWorkspace: "ws_ctx",
    });
    const client = await connectedClient(server);
    const result = await client.callTool({ name: "projects_list", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(list).toHaveBeenCalledWith("ws_ctx");
    await client.close();
  });

  it("explicit workspace argument overrides the default", async () => {
    const list = vi.fn().mockResolvedValue({ projects: [] });
    const server = createMcpServer({
      sdk: stubSdk({ repos: { list } }),
      defaultWorkspace: "ws_ctx",
    });
    const client = await connectedClient(server);
    const result = await client.callTool({
      name: "projects_list",
      arguments: { workspace: "ws_explicit" },
    });
    expect(result.isError).toBeFalsy();
    expect(list).toHaveBeenCalledWith("ws_explicit");
    await client.close();
  });

  it("tools without a workspace argument are unaffected", async () => {
    const getProfile = vi
      .fn()
      .mockResolvedValue({ user: { id: "usr_1", email: "e@x.test", displayName: null } });
    const server = createMcpServer({
      sdk: stubSdk({
        auth: { getProfile },
        workspaces: { list: vi.fn().mockResolvedValue({ organizations: [] }) },
      }),
      defaultWorkspace: "ws_ctx",
    });
    const client = await connectedClient(server);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(getProfile).toHaveBeenCalled();
    await client.close();
  });

  it("without a default, an omitted workspace still fails validation", async () => {
    const server = createMcpServer({ sdk: stubSdk({}) });
    const client = await connectedClient(server);
    const result = await client.callTool({ name: "projects_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/workspace/i);
    await client.close();
  });
});
