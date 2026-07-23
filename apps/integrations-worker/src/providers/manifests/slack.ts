// Slack manifest (IR0). Mirrors the adapter in ../slack.ts.

import type { IntegrationManifest } from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";
import { liveWhenConfigured } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "slack",
  displayName: "Slack",
  category: "messaging",
  tagline: "Connect a workspace: channel delivery, /orun, actionable alerts.",
  connect: [{ kind: "oauth" }],
  multiConnection: false,
  capabilities: ["connect", "inbound", "messaging"],
  space: {
    tabs: ["overview", "connections", "activity", "settings"],
    modules: ["channels"],
    authoring: "declarative",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.SLACK,
  version: 1,
  status: "live",
};

export const slackManifestModule: ManifestModule = {
  manifest,
  resolveConnect: liveWhenConfigured({ manifest }),
};
