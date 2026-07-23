// The Integration Manifest registry (saas-integration-registry IR0).
//
// One manifest per provider, declared beside its adapter. This is METADATA
// ONLY — behavior stays on the adapters; a manifest field that would require
// a surface to do provider-specific work is wrong by construction (it should
// be a module or an adapter method). The conformance test
// (tests/integrations-worker/src/manifest-conformance.test.ts) pins every
// manifest to its adapter (capabilities, connect kinds, authoring) so the
// manifest can never drift the way the deleted console catalogs did.
//
// Per-environment connect liveness is resolved by each module (the
// `getConfiguredProvider` gate, REPORTED instead of hidden) and projected
// into `IntegrationDescriptor.connect[].live` by the registry handler.

import type { IntegrationManifest } from "@saas/contracts/integrations";
import { awsManifestModule } from "./aws.js";
import { cloudflareManifestModule } from "./cloudflare.js";
import { discordManifestModule } from "./discord.js";
import { githubManifestModule } from "./github.js";
import type { ManifestModule } from "./shared.js";
import { slackManifestModule } from "./slack.js";
import { supabaseManifestModule } from "./supabase.js";

export type { ManifestModule } from "./shared.js";

/** Registration order = hub display order within categories. */
export const INTEGRATION_MANIFEST_MODULES: readonly ManifestModule[] = [
  githubManifestModule,
  slackManifestModule,
  cloudflareManifestModule,
  supabaseManifestModule,
  awsManifestModule,
  discordManifestModule,
];

export function listIntegrationManifests(): readonly IntegrationManifest[] {
  return INTEGRATION_MANIFEST_MODULES.map((m) => m.manifest);
}

export function getManifestModule(id: string): ManifestModule | null {
  return INTEGRATION_MANIFEST_MODULES.find((m) => m.manifest.id === id) ?? null;
}
