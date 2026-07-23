// Cloudflare manifest (IR0). Mirrors the adapter in ../cloudflare.ts.
//
// The one multi-method connect: OAuth when the environment has a registered
// client (risks D3 resolved), token-paste always — both require custody
// (SECRET_ENCRYPTION_KEY). Ordered preference: the console renders the first
// LIVE method as primary and the rest beneath (IR3 replaces today's hub
// special-case with exactly this list).

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import { INTEGRATION_ENTITLEMENTS } from "@saas/contracts/integrations";
import type { Env } from "../../env.js";
import type { ManifestModule } from "./shared.js";

const manifest: IntegrationManifest = {
  id: "cloudflare",
  displayName: "Cloudflare",
  category: "infrastructure",
  tagline: "Connect accounts; mint short-lived scoped tokens, never paste keys.",
  connect: [{ kind: "oauth" }, { kind: "token" }],
  multiConnection: true,
  capabilities: ["connect", "credential-broker", "secrets"],
  space: {
    tabs: ["overview", "connections", "secrets", "templates", "activity", "settings"],
    modules: ["accounts"],
    authoring: "custom",
  },
  entitlement: INTEGRATION_ENTITLEMENTS.CLOUDFLARE,
  version: 1,
  status: "live",
};

function resolveConnect(env: Env): readonly IntegrationConnectMethod[] {
  const custody = Boolean(env.SECRET_ENCRYPTION_KEY);
  const oauth = custody && Boolean(env.CLOUDFLARE_OAUTH_CLIENT_ID && env.CLOUDFLARE_OAUTH_CLIENT_SECRET);
  return [
    { kind: "oauth", live: oauth },
    { kind: "token", live: custody },
  ];
}

export const cloudflareManifestModule: ManifestModule = { manifest, resolveConnect };
