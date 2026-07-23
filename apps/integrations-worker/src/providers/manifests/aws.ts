// AWS manifest (IR0) — DORMANT (IH10 posture). Served for fixtures and the
// roadmap strip; never connectable (`getConfiguredProvider` never resolves
// it, and every method reports live: false). IR9 promotes this file to prove
// a provider lights up every plane from a manifest-only change.

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "aws",
  displayName: "AWS",
  category: "infrastructure",
  tagline: "Short-lived STS credentials per run — on the roadmap.",
  connect: [{ kind: "token" }],
  multiConnection: true,
  capabilities: ["connect", "credential-broker", "secrets"],
  space: {
    tabs: ["overview", "connections", "secrets", "templates", "activity", "settings"],
    modules: [],
    authoring: "declarative",
  },
  entitlement: "feature.integrations.aws",
  version: 1,
  status: "roadmap",
};

function resolveConnect(): readonly IntegrationConnectMethod[] {
  return manifest.connect.map((m) => ({ ...m, live: false }));
}

export const awsManifestModule: ManifestModule = { manifest, resolveConnect };
