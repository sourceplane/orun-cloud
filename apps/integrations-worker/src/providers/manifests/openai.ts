// OpenAI manifest (IR5). Mirrors the adapter in ../openai.ts. Apikey connect
// is always live (the paste is the credential — no env gate).

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "openai",
  displayName: "OpenAI",
  category: "ai-provider",
  tagline: "Bring your OpenAI key: models for agent sessions and dispatch.",
  connect: [{ kind: "apikey" }],
  multiConnection: true,
  capabilities: ["connect"],
  space: {
    tabs: ["overview", "connections", "activity", "settings"],
    modules: ["models"],
    authoring: "declarative",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.OPENAI,
  version: 1,
  status: "live",
};

function resolveConnect(): readonly IntegrationConnectMethod[] {
  return manifest.connect.map((m) => ({ ...m, live: true }));
}

export const openaiManifestModule: ManifestModule = { manifest, resolveConnect };
