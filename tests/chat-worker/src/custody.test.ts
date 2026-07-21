// DX-Q6 (saas-dispatch): custody — connection discovery via the public
// surface, the provider-agnostic selection rule (sole / preferred / default),
// the deterministic secretRef, and the null path that becomes the honest
// error turn.

import { pickModelConnection, providerSecretRef, resolveDispatchModel } from "@chat-worker/custody";
import { providerSecretRef as dbProviderSecretRef } from "@saas/db/agents";

describe("DX-Q6: custody model selection", () => {
  it("picks the sole verified model connection across any model provider", () => {
    expect(pickModelConnection([])).toBeNull();
    expect(pickModelConnection([{ provider: "anthropic", name: "main", status: "verified" }])?.name).toBe("main");
    expect(pickModelConnection([{ provider: "openrouter", name: "or", status: "verified" }])?.provider).toBe("openrouter");
    expect(pickModelConnection([{ provider: "openai", name: "x", status: "invalid" }])).toBeNull();
    // Daytona is compute, never a model.
    expect(pickModelConnection([{ provider: "daytona", name: "default", status: "verified" }])).toBeNull();
  });

  it("prefers the setting-named connection, else default, else ambiguous->null", () => {
    const rows = [
      { id: "apc_a", provider: "anthropic", name: "a", status: "verified" },
      { id: "apc_or", provider: "openrouter", name: "default", status: "verified" },
    ];
    expect(pickModelConnection(rows, "apc_a")?.provider).toBe("anthropic");
    expect(pickModelConnection(rows)?.provider).toBe("openrouter");
    expect(
      pickModelConnection([
        { id: "apc_1", provider: "openai", name: "one", status: "verified" },
        { id: "apc_2", provider: "openrouter", name: "two", status: "verified" },
      ]),
    ).toBeNull();
    expect(pickModelConnection([{ id: "apc_or", provider: "openrouter", name: "or", status: "verified" }], "apc_gone")?.provider).toBe("openrouter");
  });

  it("the secretRef convention matches the control plane's providerSecretRef, per provider", () => {
    expect(providerSecretRef("anthropic", "default")).toBe(dbProviderSecretRef("anthropic", "default"));
    expect(providerSecretRef("openrouter", "main")).toBe(dbProviderSecretRef("openrouter", "main"));
  });

  it("resolves provider + config + key through discovery + custody", async () => {
    const resolved = await resolveDispatchModel(
      {
        listConnections: async () => [
          { id: "apc_or", provider: "openrouter", name: "default", status: "verified", config: { defaultModel: "anthropic/claude-sonnet-4" } },
        ],
        resolveKey: async (_org, ref) => (ref === providerSecretRef("openrouter", "default") ? "sk-or-test" : null),
      },
      "org-1",
    );
    expect(resolved).toEqual({ provider: "openrouter", config: { defaultModel: "anthropic/claude-sonnet-4" }, key: "sk-or-test" });
  });

  it("honors the preferred connection id and returns null on no-connection / throw", async () => {
    const deps = {
      listConnections: async () => [
        { id: "apc_ant", provider: "anthropic", name: "a", status: "verified" as const },
        { id: "apc_or", provider: "openrouter", name: "b", status: "verified" as const, config: { defaultModel: "x" } },
      ],
      resolveKey: async () => "k",
    };
    expect((await resolveDispatchModel(deps, "org-1", "apc_or"))?.provider).toBe("openrouter");

    const noConn = await resolveDispatchModel(
      { listConnections: async () => [], resolveKey: async () => "k" },
      "org-1",
    );
    expect(noConn).toBeNull();

    const throwing = await resolveDispatchModel(
      { listConnections: async () => { throw new Error("edge down"); }, resolveKey: async () => "k" },
      "org-1",
    );
    expect(throwing).toBeNull();
  });
});
