// MCP6 metering (design §8): successful tool calls fire-and-forget exactly one
// `mcp.tool_call` usage event through the SDK's PUBLIC metering ingest
// (`recordUsage` — the caller's credential, client-not-service); failures,
// disabled/omitted usage, and workspace-less tools emit nothing; an ingest
// outage never blocks or fails the tool call.

import type { CheckQuotaResponse } from "@saas/contracts/metering";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMITS, executeTool, getTool } from "../registry.js";
import { createMcpServer } from "../server.js";
import { MCP_TOOL_CALL_METRIC, workspaceOf } from "../usage.js";
import type { McpUsageOptions } from "../usage.js";

import { connectedClient, forbidden, stubSdk, textOf } from "./helpers.js";

const QUOTA: CheckQuotaResponse = {
  metric: "state.runs",
  allowed: true,
  limit: 100,
  used: 5,
  remaining: 95,
  period: "month",
  enforcement: "soft",
} as unknown as CheckQuotaResponse;

interface RecordedUsage {
  orgId: string;
  body: {
    metric: string;
    quantity?: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown> | null;
  };
}

function meteringStub(opts: { failIngest?: boolean; hangIngest?: boolean } = {}) {
  const recorded: RecordedUsage[] = [];
  const stub = {
    metering: {
      checkQuota: vi.fn().mockResolvedValue(QUOTA),
      recordUsage: vi.fn((orgId: string, body: RecordedUsage["body"]) => {
        recorded.push({ orgId, body });
        if (opts.hangIngest === true) return new Promise(() => undefined);
        if (opts.failIngest === true) return Promise.reject(forbidden());
        return Promise.resolve({ usageRecord: {} });
      }),
    },
  };
  return { stub, recorded };
}

function usageOptions(over: Partial<McpUsageOptions> = {}): {
  usage: McpUsageOptions;
  tasks: Promise<void>[];
  debugLines: string[];
} {
  const tasks: Promise<void>[] = [];
  const debugLines: string[] = [];
  return {
    usage: {
      enabled: true,
      transport: "stdio",
      schedule: (task) => tasks.push(task),
      debug: (message) => debugLines.push(message),
      ...over,
    },
    tasks,
    debugLines,
  };
}

async function callQuotaCheck(
  stub: Record<string, unknown>,
  usage?: McpUsageOptions,
  input: unknown = { workspace: "ws_1", metric: "state.runs" },
) {
  const tool = getTool("quota_check");
  if (tool === undefined) throw new Error("quota_check not registered");
  return executeTool(tool, input, { sdk: stubSdk(stub), limits: DEFAULT_LIMITS }, usage);
}

describe("workspaceOf", () => {
  it("extracts a non-empty workspace string, otherwise undefined", () => {
    expect(workspaceOf({ workspace: "ws_1" })).toBe("ws_1");
    expect(workspaceOf({ workspace: "" })).toBeUndefined();
    expect(workspaceOf({ workspace: 7 })).toBeUndefined();
    expect(workspaceOf({})).toBeUndefined();
    expect(workspaceOf(null)).toBeUndefined();
    expect(workspaceOf([])).toBeUndefined();
    expect(workspaceOf("ws_1")).toBeUndefined();
  });
});

describe("mcp.tool_call usage emission (MCP6)", () => {
  it("a successful tool call with usage enabled emits exactly one ingest with the pinned shape", async () => {
    const { stub, recorded } = meteringStub();
    const { usage, tasks } = usageOptions();
    const result = await callQuotaCheck(stub, usage);
    expect(result.isError).toBeFalsy();

    expect(recorded).toHaveLength(1);
    const event = recorded[0]!;
    // Attribution: the workspace argument the tool was called with, verbatim
    // (the edge resolver accepts ws_ | slug | org_ like every other call).
    expect(event.orgId).toBe("ws_1");
    expect(event.body.metric).toBe(MCP_TOOL_CALL_METRIC);
    expect(event.body.metric).toBe("mcp.tool_call");
    expect(event.body.quantity).toBe(1);
    // Dimensions ride the existing bounded metadata field — no contract change.
    expect(event.body.metadata).toEqual({ tool: "quota_check", transport: "stdio" });
    expect(event.body.idempotencyKey).toMatch(/^mcp_call_[0-9a-f-]{36}$/);
    await Promise.all(tasks);
  });

  it("stamps the transport dimension the transport declared (http)", async () => {
    const { stub, recorded } = meteringStub();
    const { usage } = usageOptions({ transport: "http" });
    await callQuotaCheck(stub, usage);
    expect(recorded[0]!.body.metadata).toEqual({ tool: "quota_check", transport: "http" });
  });

  it("uses a fresh idempotency key per logical call — every call counts once", async () => {
    const { stub, recorded } = meteringStub();
    const { usage } = usageOptions();
    await callQuotaCheck(stub, usage);
    await callQuotaCheck(stub, usage);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.body.idempotencyKey).not.toBe(recorded[1]!.body.idempotencyKey);
  });

  it("a FAILED tool call emits nothing", async () => {
    const { recorded } = meteringStub();
    const { usage } = usageOptions();
    const stub = {
      metering: {
        checkQuota: vi.fn().mockRejectedValue(forbidden()),
        recordUsage: vi.fn((orgId: string, body: RecordedUsage["body"]) => {
          recorded.push({ orgId, body });
          return Promise.resolve({ usageRecord: {} });
        }),
      },
    };
    const result = await callQuotaCheck(stub, usage);
    expect(result.isError).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("an ingest failure never fails the tool call (swallowed with a debug note)", async () => {
    const { stub, recorded } = meteringStub({ failIngest: true });
    const { usage, tasks, debugLines } = usageOptions();
    const result = await callQuotaCheck(stub, usage);
    expect(result.isError).toBeFalsy();
    expect(recorded).toHaveLength(1);
    await Promise.all(tasks); // the swallowed rejection resolves the task
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain("mcp.tool_call usage ingest failed");
    expect(debugLines[0]).toContain("quota_check");
  });

  it("a broken metering client (no recordUsage at all) never fails the tool call", async () => {
    const { usage, debugLines } = usageOptions();
    const stub = { metering: { checkQuota: vi.fn().mockResolvedValue(QUOTA) } };
    const result = await callQuotaCheck(stub, usage);
    expect(result.isError).toBeFalsy();
    expect(debugLines).toHaveLength(1);
  });

  it("never awaits the ingest on the tool-call path (a hung ingest does not block)", async () => {
    const { stub, recorded } = meteringStub({ hangIngest: true });
    const { usage } = usageOptions();
    const result = await callQuotaCheck(stub, usage);
    expect(result.isError).toBeFalsy(); // resolved while the ingest still hangs
    expect(recorded).toHaveLength(1);
  });

  it("hands the detached task to the transport's scheduler (waitUntil seam)", async () => {
    const { stub } = meteringStub();
    const { usage, tasks } = usageOptions();
    await callQuotaCheck(stub, usage);
    expect(tasks).toHaveLength(1);
    await expect(tasks[0]).resolves.toBeUndefined();
  });

  it("usage OFF by default: no `usage` option emits nothing", async () => {
    const { stub, recorded } = meteringStub();
    const result = await callQuotaCheck(stub, undefined);
    expect(result.isError).toBeFalsy();
    expect(recorded).toHaveLength(0);
  });

  it("`enabled: false` emits nothing", async () => {
    const { stub, recorded } = meteringStub();
    const { usage } = usageOptions({ enabled: false });
    await callQuotaCheck(stub, usage);
    expect(recorded).toHaveLength(0);
  });

  it("tools without a workspace in scope emit nothing (whoami — never guess tenancy)", async () => {
    const { recorded } = meteringStub();
    const recordUsage = vi.fn((orgId: string, body: RecordedUsage["body"]) => {
      recorded.push({ orgId, body });
      return Promise.resolve({ usageRecord: {} });
    });
    const stub = {
      auth: {
        getProfile: vi
          .fn()
          .mockResolvedValue({ user: { id: "usr_1", email: "e@x.test", displayName: null } }),
      },
      workspaces: { list: vi.fn().mockResolvedValue({ organizations: [] }) },
      metering: { recordUsage },
    };
    const tool = getTool("whoami")!;
    const { usage } = usageOptions();
    const result = await executeTool(tool, {}, { sdk: stubSdk(stub), limits: DEFAULT_LIMITS }, usage);
    expect(result.isError).toBeFalsy();
    expect(recorded).toHaveLength(0);
  });
});

describe("usage emission over the protocol (createMcpServer wiring)", () => {
  it("a tools/call through a usage-enabled server emits one event; ambient workspace default attributes it", async () => {
    const { stub, recorded } = meteringStub();
    const { usage, tasks } = usageOptions();
    const server = createMcpServer({
      sdk: stubSdk(stub),
      defaultWorkspace: "org_ambient",
      usage,
    });
    const client = await connectedClient(server);
    const result = await client.callTool({
      name: "quota_check",
      arguments: { metric: "state.runs" }, // workspace filled by the ambient default
    });
    expect(result.isError).toBeFalsy();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.orgId).toBe("org_ambient");
    expect(recorded[0]!.body.metadata).toEqual({ tool: "quota_check", transport: "stdio" });
    await Promise.all(tasks);
    await client.close();
  });

  it("a server without the usage option emits nothing (tests/`mcp tools` stay silent)", async () => {
    const { stub, recorded } = meteringStub();
    const server = createMcpServer({ sdk: stubSdk(stub) });
    const client = await connectedClient(server);
    const result = await client.callTool({
      name: "quota_check",
      arguments: { workspace: "ws_1", metric: "state.runs" },
    });
    expect(result.isError).toBeFalsy();
    expect(recorded).toHaveLength(0);
    await client.close();
  });
});

describe("dogfood: the ingested metric round-trips through usage_summary (design §8)", () => {
  it("an emitted mcp.tool_call event is queryable by the usage_summary tool under the same metric key", async () => {
    const { stub, recorded } = meteringStub();
    const { usage, tasks } = usageOptions();
    await callQuotaCheck(stub, usage);
    await Promise.all(tasks);
    expect(recorded).toHaveLength(1);
    const ingested = recorded[0]!;

    // Stubbed summary read keyed on what was actually ingested — pins that the
    // ingest shape and the summary read agree on the metric key.
    const getUsageSummary = vi.fn().mockResolvedValue({
      metric: ingested.body.metric,
      totalQuantity: ingested.body.quantity ?? 1,
      totalRecords: 1,
      buckets: [],
    });
    const tool = getTool("usage_summary")!;
    const result = await executeTool(
      tool,
      { workspace: ingested.orgId, metric: MCP_TOOL_CALL_METRIC },
      { sdk: stubSdk({ metering: { getUsageSummary } }), limits: DEFAULT_LIMITS },
    );
    expect(result.isError).toBeFalsy();
    expect(getUsageSummary).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({ metric: "mcp.tool_call" }),
    );
    expect(textOf(result)).toContain("mcp.tool_call: 1 across 1 record(s)");
  });
});
