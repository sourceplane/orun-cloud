// Anthropic manifest (IR5). Mirrors the adapter in ../anthropic.ts — the
// re-homed AI-provider identity. The apikey method is ALWAYS live: the paste
// is the credential, so there is no per-environment platform secret to gate
// on. Named keys map onto multiConnection.

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "anthropic",
  displayName: "Anthropic",
  category: "ai-provider",
  tagline: "Bring your Anthropic key: models for agent sessions and dispatch.",
  connect: [{ kind: "apikey" }],
  multiConnection: true,
  capabilities: ["connect"],
  space: {
    tabs: ["overview", "connections", "activity", "settings"],
    modules: ["models"],
    authoring: "declarative",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.ANTHROPIC,
  version: 1,
  status: "live",
};

/** Apikey connect needs no env credential — live everywhere, always. */
function resolveConnect(): readonly IntegrationConnectMethod[] {
  return manifest.connect.map((m) => ({ ...m, live: true }));
}

export const anthropicManifestModule: ManifestModule = { manifest, resolveConnect };
