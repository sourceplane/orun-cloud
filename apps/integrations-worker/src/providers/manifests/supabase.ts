// Supabase manifest (IR0). Mirrors the adapter in ../supabase.ts. The
// declarative pluggability contrast to Cloudflare's custom authoring (SP2).

import type { IntegrationManifest } from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { ManifestModule } from "./shared.js";
import { liveWhenConfigured } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "supabase",
  displayName: "Supabase",
  category: "infrastructure",
  tagline: "Connect an org: short-lived Management API access per run.",
  connect: [{ kind: "oauth" }],
  multiConnection: false,
  capabilities: ["connect", "credential-broker", "secrets"],
  space: {
    tabs: ["overview", "connections", "secrets", "templates", "activity", "settings"],
    modules: ["projects"],
    authoring: "declarative",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.SUPABASE,
  version: 1,
  status: "live",
};

export const supabaseManifestModule: ManifestModule = {
  manifest,
  resolveConnect: liveWhenConfigured({ manifest }),
};
