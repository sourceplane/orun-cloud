// Daytona adapter (saas-integration-registry IR5) — the re-homed COMPUTE
// identity, connect kind "apikey". Connect-only: custody stays under the
// reserved agents/providers/* namespace; sandbox provisioning stays on the
// agents plane.
//
// Verification is DELEGATED (design §8): agents-worker's Daytona probe
// exercises the sandbox CREATE path (build a sandbox exactly as provisioning
// would, then reclaim it — the AG12 "verified must predict spawn" fix). That
// is provisioning behavior, not registry metadata, so this adapter does NOT
// re-implement it — `verifyApiKey` returns the `delegated` marker and live
// verification keeps running where the spawn code lives.

import type { IntegrationProvider } from "./types.js";

export function createDaytonaProvider(): IntegrationProvider {
  return {
    id: "daytona",
    displayName: "Daytona",
    connectKind: "apikey",
    capabilities: ["connect"],

    // Delegated: the agents plane owns live verification (create-path probe).
    // `ok: true` here asserts nothing about the key — callers must treat the
    // `delegated` marker as "ask the agents plane".
    async verifyApiKey() {
      return { ok: true, delegated: true };
    },
  };
}
