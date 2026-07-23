// Daytona manifest (IR5). Mirrors the adapter in ../daytona.ts — the re-homed
// COMPUTE identity. Apikey connect is always live (the paste is the
// credential — no env gate); live key verification is DELEGATED to the agents
// plane (the sandbox-create probe), see the adapter's verifyApiKey.

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "daytona",
  displayName: "Daytona",
  category: "compute",
  tagline: "Bring your Daytona account: sandbox compute for agent sessions.",
  connect: [{ kind: "apikey" }],
  multiConnection: true,
  capabilities: ["connect"],
  space: {
    tabs: ["overview", "connections", "activity", "settings"],
    modules: ["sandboxes"],
    authoring: "declarative",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.DAYTONA,
  version: 1,
  status: "live",
};

function resolveConnect(): readonly IntegrationConnectMethod[] {
  return manifest.connect.map((m) => ({ ...m, live: true }));
}

export const daytonaManifestModule: ManifestModule = { manifest, resolveConnect };
