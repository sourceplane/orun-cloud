// Cloudflare adapter (saas-integration-hub IH5) — the credential-broker
// archetype. IH0 registers it DORMANT: connectKind "token" (the customer
// pastes a parent API token once — risks D3), the v1 scope-template catalog
// is published for contracts/console/tests, and the broker capability
// answers `not_implemented` until IH5 wires the live mint path.
//
// Custody rule: the pasted parent token is the single durable credential and
// lives ONLY as a provider_credentials envelope; everything minted from it
// is short-lived, scoped-down, ledgered, and revocable.

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import type { CredentialBrokerCapability, IntegrationProvider } from "./types.js";

/** Default mint TTL (risks D5): 15 minutes; hard ceiling one hour. */
export const CLOUDFLARE_DEFAULT_TTL_SECONDS = 15 * 60;
export const CLOUDFLARE_MAX_TTL_SECONDS = 60 * 60;

/**
 * The v1 template catalog (design §5.2). Descriptions state the EFFECTIVE
 * breadth honestly (risks R5). Minted tokens are named
 * `orun/{org}/{template}/{mintId}` provider-side so the IH9 orphan sweep can
 * reconcile ledger truth against the Cloudflare account.
 */
export const CLOUDFLARE_SCOPE_TEMPLATES: readonly IntegrationScopeTemplate[] = [
  {
    id: "workers-deploy",
    provider: "cloudflare",
    version: 1,
    displayName: "Deploy Workers",
    description:
      "Edit Workers scripts and KV in the connected account, plus account read. No DNS, no R2, no billing.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "pages-deploy",
    provider: "cloudflare",
    version: 1,
    displayName: "Deploy Pages",
    description: "Edit Pages projects in the connected account, plus account read.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "dns-edit",
    provider: "cloudflare",
    version: 1,
    displayName: "Edit DNS",
    description: "Edit DNS records in the named zones only (zoneIds param required).",
    params: ["zoneIds"],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "r2-data",
    provider: "cloudflare",
    version: 1,
    displayName: "R2 data access",
    description: "Read/write R2 objects in the connected account's buckets.",
    params: ["buckets"],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "account-read",
    provider: "cloudflare",
    version: 1,
    displayName: "Account read",
    description: "Read-only access to account settings, Workers, and zones.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
] as const;

export function createCloudflareProvider(): IntegrationProvider {
  const broker: CredentialBrokerCapability = {
    scopeTemplates() {
      return CLOUDFLARE_SCOPE_TEMPLATES;
    },
    // Live mint (child account-owned tokens with expires_on) lands in IH5;
    // until then every mint parks with a typed reason — never a throw.
    async mintCredential(input) {
      const known = CLOUDFLARE_SCOPE_TEMPLATES.some((t) => t.id === input.template);
      if (!known) return { ok: false, reason: "template_unknown" };
      return { ok: false, reason: "not_implemented", detail: "cloudflare mint lands in IH5" };
    },
    async revokeCredential(): Promise<boolean> {
      return false;
    },
  };

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],

    broker,
  };
}
