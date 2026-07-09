// config_read / secrets_list

import { describe, expect, it, vi } from "vitest";

import { dataOf, errorDetailOf, forbidden, runTool, textOf } from "./helpers.js";

const setting = { id: "set_1", key: "region", value: "eu", scopeKind: "organization" };
const flag = { id: "flg_1", flagKey: "beta", enabled: true, scopeKind: "organization" };
const secretMeta = { id: "sec_1", secretKey: "DATABASE_URL", version: 3, status: "active" };

describe("config_read", () => {
  it("reads settings + feature flags at organization scope by default", async () => {
    const listSettings = vi.fn().mockResolvedValue({ settings: [setting] });
    const listFeatureFlags = vi.fn().mockResolvedValue({ featureFlags: [flag] });
    const result = await runTool(
      "config_read",
      { workspace: "ws_1" },
      { config: { listSettings, listFeatureFlags } },
    );
    expect(listSettings).toHaveBeenCalledWith({ kind: "organization", orgId: "ws_1" });
    expect(listFeatureFlags).toHaveBeenCalledWith({ kind: "organization", orgId: "ws_1" });
    expect(dataOf(result)).toEqual({
      scope: "organization",
      settings: [setting],
      featureFlags: [flag],
    });
  });

  it("builds the environment scope from project + environment", async () => {
    const listSettings = vi.fn().mockResolvedValue({ settings: [] });
    const listFeatureFlags = vi.fn().mockResolvedValue({ featureFlags: [] });
    await runTool(
      "config_read",
      { workspace: "ws_1", project: "prj_a", environment: "env_1" },
      { config: { listSettings, listFeatureFlags } },
    );
    expect(listSettings).toHaveBeenCalledWith({
      kind: "environment",
      orgId: "ws_1",
      projectId: "prj_a",
      environmentId: "env_1",
    });
  });

  it("rejects environment without project as validation_failed", async () => {
    const result = await runTool(
      "config_read",
      { workspace: "ws_1", environment: "env_1" },
      { config: {} },
    );
    expect(errorDetailOf(result)["code"]).toBe("validation_failed");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "config_read",
      { workspace: "ws_1" },
      {
        config: {
          listSettings: vi.fn().mockRejectedValue(forbidden()),
          listFeatureFlags: vi.fn().mockResolvedValue({ featureFlags: [] }),
        },
      },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

describe("secrets_list", () => {
  it("lists secret metadata only", async () => {
    const listSecretMetadata = vi.fn().mockResolvedValue({ secrets: [secretMeta] });
    const result = await runTool(
      "secrets_list",
      { workspace: "ws_1", project: "prj_a" },
      { config: { listSecretMetadata } },
    );
    expect(listSecretMetadata).toHaveBeenCalledWith({
      kind: "project",
      orgId: "ws_1",
      projectId: "prj_a",
    });
    expect(dataOf(result)).toEqual({ secrets: [secretMeta] });
    expect(textOf(result)).toContain("values are never readable");
  });

  it("refuses to return a row that unexpectedly carries value material", async () => {
    const listSecretMetadata = vi
      .fn()
      .mockResolvedValue({ secrets: [{ ...secretMeta, value: "hunter2" }] });
    const result = await runTool(
      "secrets_list",
      { workspace: "ws_1" },
      { config: { listSecretMetadata } },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("hunter2");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "secrets_list",
      { workspace: "ws_1" },
      { config: { listSecretMetadata: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});
