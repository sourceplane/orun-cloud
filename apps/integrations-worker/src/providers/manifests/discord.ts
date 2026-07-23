// Discord manifest (IR0) — DORMANT (IH10 posture). Roadmap strip only.

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "discord",
  displayName: "Discord",
  category: "messaging",
  tagline: "Channel delivery for Discord servers — on the roadmap.",
  connect: [{ kind: "oauth" }],
  multiConnection: false,
  capabilities: ["connect", "messaging"],
  space: {
    tabs: ["overview", "connections", "activity", "settings"],
    modules: [],
    authoring: "declarative",
  },
  entitlement: "feature.integrations.discord",
  version: 1,
  status: "roadmap",
};

function resolveConnect(): readonly IntegrationConnectMethod[] {
  return manifest.connect.map((m) => ({ ...m, live: false }));
}

export const discordManifestModule: ManifestModule = { manifest, resolveConnect };
