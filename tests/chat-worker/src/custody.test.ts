// AN4 (saas-agents-native): custody — connection discovery via the public
// surface, the sole-or-default rule, the deterministic secretRef, and the
// null path that becomes the honest error turn.

import { pickAnthropic, anthropicSecretRef, resolveAnthropicKey } from "@chat-worker/custody";
import { providerSecretRef } from "@saas/db/agents";

describe("AN4: custody", () => {
  it("picks the sole verified anthropic connection, or the one named default", () => {
    expect(pickAnthropic([])).toBeNull();
    expect(pickAnthropic([{ provider: "anthropic", name: "main", status: "verified" }])?.name).toBe("main");
    expect(pickAnthropic([{ provider: "anthropic", name: "main", status: "invalid" }])).toBeNull();
    expect(
      pickAnthropic([
        { provider: "anthropic", name: "a", status: "verified" },
        { provider: "anthropic", name: "default", status: "verified" },
      ])?.name,
    ).toBe("default");
    expect(
      pickAnthropic([
        { provider: "anthropic", name: "a", status: "verified" },
        { provider: "anthropic", name: "b", status: "verified" },
      ]),
    ).toBeNull();
    expect(pickAnthropic([{ provider: "daytona", name: "default", status: "verified" }])).toBeNull();
  });

  it("the secretRef convention matches the control plane's providerSecretRef", () => {
    expect(anthropicSecretRef("default")).toBe(providerSecretRef("anthropic", "default"));
  });

  it("resolves the key through discovery + custody; failures resolve null", async () => {
    const key = await resolveAnthropicKey(
      {
        listConnections: async () => [{ provider: "anthropic", name: "default", status: "verified" }],
        resolveKey: async (_org, ref) => (ref === anthropicSecretRef("default") ? "sk-ant-test" : null),
      },
      "org-1",
    );
    expect(key).toBe("sk-ant-test");

    const noConn = await resolveAnthropicKey(
      { listConnections: async () => [], resolveKey: async () => "sk" },
      "org-1",
    );
    expect(noConn).toBeNull();

    const throwing = await resolveAnthropicKey(
      {
        listConnections: async () => {
          throw new Error("api-edge down");
        },
        resolveKey: async () => "sk",
      },
      "org-1",
    );
    expect(throwing).toBeNull();
  });
});
