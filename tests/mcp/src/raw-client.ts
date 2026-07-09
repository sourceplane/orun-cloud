// A raw JSON-RPC driver over `InMemoryTransport` — deliberately NOT the MCP
// SDK `Client`, so the conformance matrix can assert wire-level facts the
// Client abstracts away (negotiated protocolVersion, error codes for unknown
// methods/tools, liveness after a bad request).

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface RawRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RawRpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: RawRpcError;
}

export interface RawMcpClient {
  /** Send a request and await the response with the matching id. */
  request(method: string, params?: unknown): Promise<RawRpcResponse>;
  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * Connect a raw client to a `createMcpServer` instance and complete the
 * initialize handshake (initialize → notifications/initialized), returning
 * both the client and the raw initialize response for assertions.
 */
export async function connectRaw(
  server: McpServer,
): Promise<{ client: RawMcpClient; initialize: RawRpcResponse }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: RawRpcResponse) => void>();
  let nextId = 1;

  clientTransport.onmessage = (message) => {
    const response = message as unknown as RawRpcResponse;
    if (typeof response.id === "number" && pending.has(response.id)) {
      const resolve = pending.get(response.id)!;
      pending.delete(response.id);
      resolve(response);
    }
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  const client: RawMcpClient = {
    request(method, params) {
      const id = nextId++;
      const message = {
        jsonrpc: "2.0" as const,
        id,
        method,
        ...(params !== undefined ? { params } : { params: {} }),
      };
      return new Promise<RawRpcResponse>((resolve, reject) => {
        pending.set(id, resolve);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`rpc ${method} (id ${id}) timed out`));
        }, 5000);
        const settle = pending.get(id)!;
        pending.set(id, (response) => {
          clearTimeout(timer);
          settle(response);
        });
        clientTransport
          .send(message as never)
          .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
      });
    },
    async notify(method, params) {
      await clientTransport.send({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      } as never);
    },
    async close() {
      await clientTransport.close();
    },
  };

  const initialize = await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-conformance", version: "0.0.0" },
  });
  await client.notify("notifications/initialized");
  return { client, initialize };
}
