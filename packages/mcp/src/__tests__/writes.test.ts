// The MCP5 write set (design §4/§7): per tool — happy path (right SDK method,
// right args, an Idempotency-Key on the request options), caller-supplied key
// passthrough, and a forbidden mapping. Plus the stable-key semantics: two
// calls auto-generate two DIFFERENT keys; the same supplied key reaches the
// SDK unchanged both times.

import { IDEMPOTENCY_KEY_MAX_LENGTH } from "@saas/contracts/idempotency";
import { describe, expect, it, vi } from "vitest";

import { deriveIdempotencyKey, resolveIdempotencyKey } from "../idempotency.js";

import { dataOf, errorDetailOf, forbidden, runTool, textOf } from "./helpers.js";

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/;

/** The Idempotency-Key the spy received on call `n` (from its options arg). */
function keyOf(spy: ReturnType<typeof vi.fn>, call = 0): string {
  const opts = spy.mock.calls[call]?.at(-1) as { idempotencyKey?: string };
  expect(opts).toBeDefined();
  const key = opts.idempotencyKey;
  expect(key, "an Idempotency-Key must ride every write").toBeTypeOf("string");
  expect(key!.length).toBeGreaterThan(0);
  expect(key!.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
  expect(key).toMatch(ASCII_PRINTABLE_RE);
  return key!;
}

// ---------------------------------------------------------------------------
// project_create
// ---------------------------------------------------------------------------

const project = { id: "prj_1", slug: "api", name: "API" };

describe("project_create", () => {
  it("creates via repos.create with an auto Idempotency-Key", async () => {
    const create = vi.fn().mockResolvedValue({ project });
    const result = await runTool(
      "project_create",
      { workspace: "ws_1", name: "API", slug: "api" },
      { repos: { create } },
    );
    expect(create).toHaveBeenCalledWith(
      "ws_1",
      { name: "API", slug: "api" },
      { idempotencyKey: expect.stringMatching(/^mcp_/) as string },
    );
    keyOf(create);
    expect(dataOf(result)).toEqual({ project });
    expect(textOf(result)).toContain("created project api");
  });

  it("passes a caller-supplied idempotencyKey through verbatim", async () => {
    const create = vi.fn().mockResolvedValue({ project });
    await runTool(
      "project_create",
      { workspace: "ws_1", name: "API", idempotencyKey: "agent-attempt-1" },
      { repos: { create } },
    );
    expect(keyOf(create)).toBe("agent-attempt-1");
  });

  it("auto-generates a DIFFERENT key per call; the same supplied key is stable", async () => {
    const create = vi.fn().mockResolvedValue({ project });
    const stub = { repos: { create } };
    await runTool("project_create", { workspace: "ws_1", name: "API" }, stub);
    await runTool("project_create", { workspace: "ws_1", name: "API" }, stub);
    expect(keyOf(create, 0)).not.toBe(keyOf(create, 1));

    await runTool(
      "project_create",
      { workspace: "ws_1", name: "API", idempotencyKey: "retry-key" },
      stub,
    );
    await runTool(
      "project_create",
      { workspace: "ws_1", name: "API", idempotencyKey: "retry-key" },
      stub,
    );
    expect(keyOf(create, 2)).toBe("retry-key");
    expect(keyOf(create, 3)).toBe("retry-key");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "project_create",
      { workspace: "ws_1", name: "API" },
      { repos: { create: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// environment_create
// ---------------------------------------------------------------------------

const environment = { id: "env_1", projectId: "prj_1", slug: "staging", name: "Staging" };

describe("environment_create", () => {
  it("creates via environments.create with an auto Idempotency-Key", async () => {
    const create = vi.fn().mockResolvedValue({ environment });
    const result = await runTool(
      "environment_create",
      { workspace: "ws_1", project: "prj_1", name: "Staging", slug: "staging" },
      { environments: { create } },
    );
    expect(create).toHaveBeenCalledWith(
      "ws_1",
      "prj_1",
      { name: "Staging", slug: "staging" },
      { idempotencyKey: expect.stringMatching(/^mcp_/) as string },
    );
    keyOf(create);
    expect(dataOf(result)).toEqual({ environment });
  });

  it("passes a caller-supplied idempotencyKey through verbatim", async () => {
    const create = vi.fn().mockResolvedValue({ environment });
    await runTool(
      "environment_create",
      { workspace: "ws_1", project: "prj_1", name: "Staging", idempotencyKey: "env-try-1" },
      { environments: { create } },
    );
    expect(keyOf(create)).toBe("env-try-1");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "environment_create",
      { workspace: "ws_1", project: "prj_1", name: "Staging" },
      { environments: { create: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// flag_set
// ---------------------------------------------------------------------------

const flag = {
  id: "flg_1",
  flagKey: "checkout.new_flow",
  enabled: true,
  value: null,
};

describe("flag_set", () => {
  it("creates a missing flag at the scope, idempotency-keyed", async () => {
    const listFeatureFlags = vi.fn().mockResolvedValue({ featureFlags: [] });
    const createFeatureFlag = vi.fn().mockResolvedValue({ featureFlag: flag });
    const result = await runTool(
      "flag_set",
      { workspace: "ws_1", flagKey: "checkout.new_flow", enabled: true },
      { config: { listFeatureFlags, createFeatureFlag } },
    );
    expect(createFeatureFlag).toHaveBeenCalledWith(
      { kind: "organization", orgId: "ws_1" },
      { flagKey: "checkout.new_flow", enabled: true },
      { idempotencyKey: expect.stringMatching(/^mcp_/) as string },
    );
    keyOf(createFeatureFlag);
    expect(dataOf(result)).toEqual({ featureFlag: flag, action: "created" });
  });

  it("updates an existing flag in place (set semantics), at project+environment scope", async () => {
    const listFeatureFlags = vi.fn().mockResolvedValue({ featureFlags: [flag] });
    const updateFeatureFlag = vi
      .fn()
      .mockResolvedValue({ featureFlag: { ...flag, enabled: false } });
    const result = await runTool(
      "flag_set",
      {
        workspace: "ws_1",
        project: "prj_1",
        environment: "env_1",
        flagKey: "checkout.new_flow",
        enabled: false,
        value: { rollout: 0 },
        idempotencyKey: "flag-try-9",
      },
      { config: { listFeatureFlags, updateFeatureFlag } },
    );
    const scope = {
      kind: "environment",
      orgId: "ws_1",
      projectId: "prj_1",
      environmentId: "env_1",
    };
    expect(listFeatureFlags).toHaveBeenCalledWith(scope);
    expect(updateFeatureFlag).toHaveBeenCalledWith(
      scope,
      "flg_1",
      { enabled: false, value: { rollout: 0 } },
      { idempotencyKey: "flag-try-9" },
    );
    expect(dataOf(result)["action"]).toBe("updated");
  });

  it("rejects a call that sets neither enabled nor value as validation_failed", async () => {
    const result = await runTool(
      "flag_set",
      { workspace: "ws_1", flagKey: "checkout.new_flow" },
      { config: {} },
    );
    expect(errorDetailOf(result)["code"]).toBe("validation_failed");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "flag_set",
      { workspace: "ws_1", flagKey: "checkout.new_flow", enabled: true },
      { config: { listFeatureFlags: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// webhook_create
// ---------------------------------------------------------------------------

const endpoint = { id: "whep_1", url: "https://hooks.example.test/x", projectId: null };

describe("webhook_create", () => {
  it("creates a workspace endpoint plus one subscription per event type", async () => {
    const createEndpoint = vi.fn().mockResolvedValue({ endpoint });
    const createSubscription = vi
      .fn()
      .mockImplementation((_ws: string, body: { eventType: string }) =>
        Promise.resolve({
          subscription: { id: `whs_${body.eventType}`, eventType: body.eventType },
        }),
      );
    const result = await runTool(
      "webhook_create",
      {
        workspace: "ws_1",
        url: "https://hooks.example.test/x",
        name: "CI hook",
        events: ["run.completed", "run.failed"],
      },
      { webhooks: { createEndpoint, createSubscription } },
    );
    expect(createEndpoint).toHaveBeenCalledWith(
      "ws_1",
      { url: "https://hooks.example.test/x", name: "CI hook" },
      { idempotencyKey: expect.stringMatching(/^mcp_/) as string },
    );
    const base = keyOf(createEndpoint);
    // Subscription keys are derived from the endpoint key (deterministic, so a
    // retried call replays every leg) and stay within the 255-char cap.
    expect(createSubscription).toHaveBeenNthCalledWith(
      1,
      "ws_1",
      { endpointId: "whep_1", eventType: "run.completed" },
      { idempotencyKey: `${base}:sub0` },
    );
    expect(createSubscription).toHaveBeenNthCalledWith(
      2,
      "ws_1",
      { endpointId: "whep_1", eventType: "run.failed" },
      { idempotencyKey: `${base}:sub1` },
    );
    expect(dataOf(result)).toEqual({
      endpoint,
      subscriptions: [
        { id: "whs_run.completed", eventType: "run.completed" },
        { id: "whs_run.failed", eventType: "run.failed" },
      ],
    });
  });

  it("uses the project-scoped create when `project` is set, key passthrough intact", async () => {
    const createProjectEndpoint = vi
      .fn()
      .mockResolvedValue({ endpoint: { ...endpoint, projectId: "prj_1" } });
    const result = await runTool(
      "webhook_create",
      {
        workspace: "ws_1",
        project: "prj_1",
        url: "https://hooks.example.test/x",
        idempotencyKey: "hook-try-2",
      },
      { webhooks: { createProjectEndpoint } },
    );
    expect(createProjectEndpoint).toHaveBeenCalledWith(
      "ws_1",
      "prj_1",
      { url: "https://hooks.example.test/x" },
      { idempotencyKey: "hook-try-2" },
    );
    expect(dataOf(result)).toEqual({
      endpoint: { ...endpoint, projectId: "prj_1" },
      subscriptions: [],
    });
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "webhook_create",
      { workspace: "ws_1", url: "https://hooks.example.test/x" },
      { webhooks: { createEndpoint: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// webhook_delivery_replay
// ---------------------------------------------------------------------------

const replayed = { id: "wha_2", endpointId: "whep_1", status: "succeeded", attemptNumber: 1 };

describe("webhook_delivery_replay", () => {
  it("replays via webhooks.replayDelivery with an auto Idempotency-Key", async () => {
    const replayDelivery = vi.fn().mockResolvedValue({ deliveryAttempt: replayed });
    const result = await runTool(
      "webhook_delivery_replay",
      { workspace: "ws_1", delivery: "wha_1" },
      { webhooks: { replayDelivery } },
    );
    expect(replayDelivery).toHaveBeenCalledWith("ws_1", "wha_1", {
      idempotencyKey: expect.stringMatching(/^mcp_/) as string,
    });
    keyOf(replayDelivery);
    expect(dataOf(result)).toEqual({ deliveryAttempt: replayed });
    expect(textOf(result)).toContain("wha_2");
  });

  it("passes a caller-supplied idempotencyKey through verbatim", async () => {
    const replayDelivery = vi.fn().mockResolvedValue({ deliveryAttempt: replayed });
    await runTool(
      "webhook_delivery_replay",
      { workspace: "ws_1", delivery: "wha_1", idempotencyKey: "replay-once" },
      { webhooks: { replayDelivery } },
    );
    expect(keyOf(replayDelivery)).toBe("replay-once");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "webhook_delivery_replay",
      { workspace: "ws_1", delivery: "wha_1" },
      { webhooks: { replayDelivery: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// member_invite
// ---------------------------------------------------------------------------

const invitation = {
  id: "inv_1",
  email: "dev@example.test",
  role: "viewer",
  status: "pending",
  expiresAt: "2026-08-01T00:00:00Z",
};

describe("member_invite", () => {
  it("invites via memberships.createInvitation with an auto Idempotency-Key", async () => {
    const createInvitation = vi.fn().mockResolvedValue({ invitation });
    const result = await runTool(
      "member_invite",
      { workspace: "ws_1", email: "dev@example.test", role: "viewer" },
      { memberships: { createInvitation } },
    );
    expect(createInvitation).toHaveBeenCalledWith(
      "ws_1",
      { email: "dev@example.test", role: "viewer" },
      { idempotencyKey: expect.stringMatching(/^mcp_/) as string },
    );
    keyOf(createInvitation);
    expect(dataOf(result)).toEqual({ invitation });
  });

  it("never returns the one-time accept token, even when the API sends one", async () => {
    const createInvitation = vi.fn().mockResolvedValue({
      invitation,
      delivery: { mode: "token", token: "SECRET-ACCEPT-TOKEN" },
    });
    const result = await runTool(
      "member_invite",
      { workspace: "ws_1", email: "dev@example.test", role: "viewer" },
      { memberships: { createInvitation } },
    );
    expect(dataOf(result)).toEqual({ invitation });
    expect(textOf(result)).not.toContain("SECRET-ACCEPT-TOKEN");
  });

  it("passes a caller-supplied idempotencyKey through verbatim", async () => {
    const createInvitation = vi.fn().mockResolvedValue({ invitation });
    await runTool(
      "member_invite",
      {
        workspace: "ws_1",
        email: "dev@example.test",
        role: "builder",
        idempotencyKey: "invite-try-1",
      },
      { memberships: { createInvitation } },
    );
    expect(keyOf(createInvitation)).toBe("invite-try-1");
  });

  it("maps forbidden", async () => {
    const result = await runTool(
      "member_invite",
      { workspace: "ws_1", email: "dev@example.test", role: "viewer" },
      { memberships: { createInvitation: vi.fn().mockRejectedValue(forbidden()) } },
    );
    expect(errorDetailOf(result)["code"]).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// idempotency helpers
// ---------------------------------------------------------------------------

describe("idempotency helpers", () => {
  it("resolveIdempotencyKey generates unique mcp_-prefixed printable-ASCII keys", () => {
    const a = resolveIdempotencyKey(undefined);
    const b = resolveIdempotencyKey(undefined);
    expect(a).not.toBe(b);
    for (const key of [a, b]) {
      expect(key).toMatch(/^mcp_/);
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
      expect(key).toMatch(ASCII_PRINTABLE_RE);
    }
  });

  it("resolveIdempotencyKey returns the supplied key (trimmed)", () => {
    expect(resolveIdempotencyKey("my-key")).toBe("my-key");
    expect(resolveIdempotencyKey("  my-key  ")).toBe("my-key");
  });

  it("deriveIdempotencyKey stays within the 255-char contract cap", () => {
    const base = "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
    const derived = deriveIdempotencyKey(base, ":sub12");
    expect(derived.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(derived.endsWith(":sub12")).toBe(true);
    // Deterministic: the same base derives the same key (replay-safe retries).
    expect(deriveIdempotencyKey(base, ":sub12")).toBe(derived);
  });
});
