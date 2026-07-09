// MCP6 entitlement seam (design §8, risks D3): `feature.mcp_server` checked
// at the TRANSPORT layer via the public billing entitlements read. D3 default
// posture — the gate ships OPEN: a missing row is granted, only an explicit
// disabled row denies (an upgrade-shaped `entitlement_required` error through
// the standard tool-error mapping); a failed read fails open.

import { describe, expect, it, vi } from "vitest";

import {
  ENTITLEMENT_CACHE_TTL_MS,
  MCP_SERVER_ENTITLEMENT_KEY,
  checkMcpServerEntitlement,
  createEntitlementGate,
} from "../entitlement.js";
import { EntitlementDeniedError, toErrorResult } from "../errors.js";
import { createMcpServer } from "../server.js";
import { getTool } from "../registry.js";

import { connectedClient, errorDetailOf, forbidden, stubSdk } from "./helpers.js";

function entitlementRow(enabled: boolean, key = MCP_SERVER_ENTITLEMENT_KEY) {
  return {
    id: "ent_1",
    orgId: "org_1",
    subscriptionId: null,
    entitlementKey: key,
    valueType: "boolean",
    enabled,
    limitValue: null,
    source: "plan",
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function billingStub(rows: unknown[] | Error) {
  const getEntitlements = vi.fn(() =>
    rows instanceof Error
      ? Promise.reject(rows)
      : Promise.resolve({ entitlements: rows }),
  );
  return { sdk: stubSdk({ billing: { getEntitlements } }), getEntitlements };
}

describe("checkMcpServerEntitlement", () => {
  it("an explicit enabled row is granted", async () => {
    const { sdk, getEntitlements } = billingStub([entitlementRow(true)]);
    await expect(checkMcpServerEntitlement(sdk, "ws_1")).resolves.toEqual({
      allowed: true,
      reason: "granted",
    });
    expect(getEntitlements).toHaveBeenCalledWith("ws_1");
  });

  it("a MISSING row is granted — the D3 open-gate default posture", async () => {
    const { sdk } = billingStub([entitlementRow(true, "feature.custom_domains")]);
    await expect(checkMcpServerEntitlement(sdk, "ws_1")).resolves.toEqual({
      allowed: true,
      reason: "not_configured",
    });
  });

  it("an explicit disabled row denies — the gate closes without a redeploy", async () => {
    const { sdk } = billingStub([entitlementRow(false)]);
    await expect(checkMcpServerEntitlement(sdk, "ws_1")).resolves.toEqual({
      allowed: false,
      reason: "disabled",
    });
  });

  it("a failed entitlements read fails OPEN (never throws)", async () => {
    const { sdk } = billingStub(forbidden());
    await expect(checkMcpServerEntitlement(sdk, "ws_1")).resolves.toEqual({
      allowed: true,
      reason: "check_failed",
    });
  });
});

describe("createEntitlementGate (worker seam: lazy, per-org TTL cache)", () => {
  const anyTool = getTool("quota_check")!;

  it("passes tool calls without a workspace untouched — zero billing reads", async () => {
    const { sdk, getEntitlements } = billingStub([entitlementRow(true)]);
    const gate = createEntitlementGate({ sdk });
    await expect(gate(anyTool, {})).resolves.toBeUndefined();
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  it("first call with a workspace checks once; the second within the TTL is served from cache", async () => {
    const { sdk, getEntitlements } = billingStub([entitlementRow(true)]);
    const cache = new Map();
    const gate = createEntitlementGate({ sdk, cache });
    await gate(anyTool, { workspace: "ws_1" });
    await gate(anyTool, { workspace: "ws_1" });
    expect(getEntitlements).toHaveBeenCalledTimes(1);
    // A different org is its own cache entry.
    await gate(anyTool, { workspace: "ws_2" });
    expect(getEntitlements).toHaveBeenCalledTimes(2);
  });

  it("re-checks after the TTL elapses (~60s: a plan flip needs no redeploy)", async () => {
    const { sdk, getEntitlements } = billingStub([entitlementRow(true)]);
    let at = 0;
    const gate = createEntitlementGate({ sdk, now: () => at });
    await gate(anyTool, { workspace: "ws_1" });
    at += ENTITLEMENT_CACHE_TTL_MS - 1;
    await gate(anyTool, { workspace: "ws_1" });
    expect(getEntitlements).toHaveBeenCalledTimes(1);
    at += 2;
    await gate(anyTool, { workspace: "ws_1" });
    expect(getEntitlements).toHaveBeenCalledTimes(2);
  });

  it("a disabled workspace throws EntitlementDeniedError (cached too)", async () => {
    const { sdk, getEntitlements } = billingStub([entitlementRow(false)]);
    const gate = createEntitlementGate({ sdk });
    await expect(gate(anyTool, { workspace: "ws_1" })).rejects.toBeInstanceOf(
      EntitlementDeniedError,
    );
    await expect(gate(anyTool, { workspace: "ws_1" })).rejects.toBeInstanceOf(
      EntitlementDeniedError,
    );
    expect(getEntitlements).toHaveBeenCalledTimes(1);
  });

  it("a failed read fails open through the gate", async () => {
    const { sdk } = billingStub(forbidden());
    const gate = createEntitlementGate({ sdk });
    await expect(gate(anyTool, { workspace: "ws_1" })).resolves.toBeUndefined();
  });
});

describe("denial error shape (upgrade-shaped, platform pattern)", () => {
  it("toErrorResult maps EntitlementDeniedError to the platform entitlement_required code", () => {
    const result = toErrorResult(new EntitlementDeniedError(MCP_SERVER_ENTITLEMENT_KEY));
    expect(result.isError).toBe(true);
    const detail = errorDetailOf(result);
    expect(detail).toEqual({
      code: "entitlement_required",
      message: "MCP server access is not available on the current plan",
      entitlementKey: "feature.mcp_server",
    });
  });
});

describe("gate over the protocol (createMcpServer wiring)", () => {
  it("granted: the gated tool call proceeds; denied: the platform code surfaces to the agent", async () => {
    const rows = [entitlementRow(true)];
    const getEntitlements = vi.fn(() => Promise.resolve({ entitlements: rows }));
    const checkQuota = vi.fn().mockResolvedValue({
      metric: "state.runs",
      allowed: true,
      limit: 100,
      used: 5,
      remaining: 95,
    });
    const sdk = stubSdk({ billing: { getEntitlements }, metering: { checkQuota } });
    const server = createMcpServer({ sdk, gate: createEntitlementGate({ sdk }) });
    const client = await connectedClient(server);

    const granted = await client.callTool({
      name: "quota_check",
      arguments: { workspace: "ws_1", metric: "state.runs" },
    });
    expect(granted.isError).toBeFalsy();

    // Flip the entitlement off (fresh server/gate = fresh cache) — the gated
    // experience appears without any redeploy of the tool plane.
    rows[0] = entitlementRow(false);
    const gatedServer = createMcpServer({ sdk, gate: createEntitlementGate({ sdk }) });
    const gatedClient = await connectedClient(gatedServer);
    const denied = await gatedClient.callTool({
      name: "quota_check",
      arguments: { workspace: "ws_1", metric: "state.runs" },
    });
    expect(denied.isError).toBe(true);
    const text = (denied.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("entitlement_required");
    expect(text).toContain("feature.mcp_server");
    expect(checkQuota).toHaveBeenCalledTimes(1); // the denied call never reached the handler

    await client.close();
    await gatedClient.close();
  });

  it("whoami (no workspace) is never gated", async () => {
    const getEntitlements = vi.fn(() =>
      Promise.resolve({ entitlements: [entitlementRow(false)] }),
    );
    const sdk = stubSdk({
      billing: { getEntitlements },
      auth: {
        getProfile: vi
          .fn()
          .mockResolvedValue({ user: { id: "usr_1", email: "e@x.test", displayName: null } }),
      },
      workspaces: { list: vi.fn().mockResolvedValue({ organizations: [] }) },
    });
    const server = createMcpServer({ sdk, gate: createEntitlementGate({ sdk }) });
    const client = await connectedClient(server);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(getEntitlements).not.toHaveBeenCalled();
    await client.close();
  });
});
