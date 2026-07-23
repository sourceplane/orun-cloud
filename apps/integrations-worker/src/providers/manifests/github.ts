// GitHub manifest (IR0). Mirrors the adapter in ../github.ts — the
// conformance test pins capabilities/connect/authoring to code reality.

import type { IntegrationManifest } from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";
import { liveWhenConfigured } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "github",
  displayName: "GitHub",
  category: "source-control",
  tagline: "Install the GitHub App: repo links, scm.* events, scoped tokens.",
  connect: [{ kind: "install" }],
  multiConnection: false,
  capabilities: ["connect", "inbound", "scm"],
  space: {
    tabs: ["overview", "connections", "activity", "settings"],
    modules: ["repositories"],
    authoring: "declarative",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.GITHUB,
  version: 1,
  status: "live",
};

export const githubManifestModule: ManifestModule = {
  manifest,
  resolveConnect: liveWhenConfigured({ manifest }),
};
