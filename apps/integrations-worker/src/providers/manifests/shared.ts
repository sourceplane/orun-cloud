// Shared manifest-module contract + default liveness resolver (IR0).
// Split from index.ts so per-provider manifest files never import the
// aggregate (no import cycle).

import type {
  IntegrationConnectMethod,
  IntegrationManifest,
} from "@saas/contracts/integrations";
import type { Env } from "../../env.js";
import { getConfiguredProvider } from "../registry.js";

/** A manifest plus its environment-liveness resolver. The resolver is
 *  server-side only — never serialized; the descriptor carries the result. */
export interface ManifestModule {
  manifest: IntegrationManifest;
  /** Which of the declared connect methods are ready in this environment. */
  resolveConnect(env: Env): readonly IntegrationConnectMethod[];
}

/** The default resolver for single-method providers: the method is live iff
 *  the provider's env credential set is complete — exactly the
 *  `getConfiguredProvider` gate. Multi-method providers (Cloudflare) supply
 *  their own resolver beside the adapter. */
export function liveWhenConfigured(module: {
  manifest: IntegrationManifest;
}): (env: Env) => readonly IntegrationConnectMethod[] {
  return (env: Env) => {
    const configured = getConfiguredProvider(env, module.manifest.id) != null;
    return module.manifest.connect.map((m) => ({ ...m, live: configured }));
  };
}
