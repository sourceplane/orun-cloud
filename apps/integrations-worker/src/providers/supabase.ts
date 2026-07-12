// Supabase adapter (saas-integration-hub IH6) — the credential-broker
// archetype, OAuth-connected. IH0 registers it DORMANT: connectKind "oauth"
// (PKCE against the Management API — risks D4), the v1 scope-template
// catalog is published, and the broker capability answers `not_implemented`
// until IH6 wires the live token derivation.
//
// Custody rule: the refresh token obtained at connect lives ONLY as a
// provider_credentials envelope; short-lived access tokens are derived on
// demand and never handed out durable.

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import type { CredentialBrokerCapability, IntegrationProvider } from "./types.js";

export const SUPABASE_MAX_TTL_SECONDS = 60 * 60;

/**
 * The v1 template catalog (design §5.3). Where the Management API cannot
 * narrow issuance to a template's declared intent, the description states
 * the effective breadth honestly (risks R5) — the ledger still binds usage
 * to the declared purpose.
 */
export const SUPABASE_SCOPE_TEMPLATES: readonly IntegrationScopeTemplate[] = [
  {
    id: "management-access",
    provider: "supabase",
    version: 1,
    displayName: "Management API access",
    description:
      "A short-lived Management-API access token for the connected Supabase organization. Breadth is the OAuth grant (org-wide); TTL is provider-fixed and reported honestly in the ledger.",
    params: [],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
  },
  {
    id: "db-migrate",
    provider: "supabase",
    version: 1,
    displayName: "Run database migrations",
    description:
      "The credential bundle the migration runner needs for one project (projectRef param required).",
    params: ["projectRef"],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
  },
  {
    id: "functions-deploy",
    provider: "supabase",
    version: 1,
    displayName: "Deploy Edge Functions",
    description: "Deploy Edge Functions to one project (projectRef param required).",
    params: ["projectRef"],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
  },
] as const;

export function createSupabaseProvider(): IntegrationProvider {
  const broker: CredentialBrokerCapability = {
    scopeTemplates() {
      return SUPABASE_SCOPE_TEMPLATES;
    },
    async mintCredential(input) {
      const known = SUPABASE_SCOPE_TEMPLATES.some((t) => t.id === input.template);
      if (!known) return { ok: false, reason: "template_unknown" };
      return { ok: false, reason: "not_implemented", detail: "supabase mint lands in IH6" };
    },
    async revokeCredential(): Promise<boolean> {
      return false;
    },
  };

  return {
    id: "supabase",
    displayName: "Supabase",
    connectKind: "oauth",
    capabilities: ["connect", "credential-broker"],

    broker,
  };
}
