/**
 * The connection providers the Integrations hub presents.
 *
 * Orun is an orchestration plane over external services, so "Integrations" is a
 * first-class hub (not a settings sub-page): you connect the providers Orun
 * coordinates. GitHub, Slack, Cloudflare, and Supabase are live (IH1/IH5/IH6);
 * genuinely-future providers (Discord, AWS) render as non-interactive "Soon"
 * slots so the hub communicates direction honestly, without faking
 * functionality.
 *
 * Dependency-free (no React, no icons) so the catalog is unit-testable; icon
 * names resolve in the renderer.
 */

export type ProviderStatus = "available" | "soon";

/** Marketplace grouping (design §6): what kind of surface the provider is. */
export type ProviderArchetype = "source-control" | "messaging" | "infrastructure";

/**
 * How the connect flow starts (design §2):
 *   - `install` → provider app install page in a popup, poll until active
 *   - `oauth`   → provider authorize URL in a popup, poll until active
 *   - `token`   → paste a scoped parent token; verified server-side, no poll
 */
export type ProviderConnectKind = "install" | "oauth" | "token";

/**
 * Console-local provider id: the contracts' `IntegrationProviderId` plus
 * display-only roadmap ghosts (discord/aws) that no API ever returns.
 */
export type ProviderId = "github" | "supabase" | "cloudflare" | "slack" | "discord" | "aws";

export interface IntegrationProvider {
  id: ProviderId;
  name: string;
  /** One-line description of what connecting this provider unlocks. */
  description: string;
  status: ProviderStatus;
  archetype: ProviderArchetype;
  connectKind: ProviderConnectKind;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
}

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    id: "github",
    name: "GitHub",
    description:
      "React to pushes and pull requests, link repositories to repos, and act on GitHub without storing credentials.",
    status: "available",
    archetype: "source-control",
    connectKind: "install",
    icon: "Github",
  },
  {
    id: "supabase",
    name: "Supabase",
    description:
      "Connect your Supabase organization over OAuth; plans mint short-lived Management API access tokens on demand.",
    status: "available",
    archetype: "infrastructure",
    connectKind: "oauth",
    icon: "Database",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description:
      "Connect your Cloudflare account over OAuth; plans mint short-lived, scoped child tokens for Workers, Pages, DNS, and R2 on demand.",
    status: "available",
    archetype: "infrastructure",
    connectKind: "oauth",
    icon: "Cloud",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post run and deployment notifications to your channels.",
    status: "available",
    archetype: "messaging",
    connectKind: "oauth",
    icon: "MessageSquare",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Post run and deployment notifications to your Discord servers.",
    status: "soon",
    archetype: "messaging",
    connectKind: "oauth",
    icon: "MessageCircle",
  },
  {
    id: "aws",
    name: "AWS",
    description: "Broker short-lived, scoped AWS credentials for plan steps.",
    status: "soon",
    archetype: "infrastructure",
    connectKind: "token",
    icon: "Server",
  },
];

/** Providers that are not yet connectable (rendered as muted "Soon" slots). */
export function roadmapProviders(): IntegrationProvider[] {
  return INTEGRATION_PROVIDERS.filter((p) => p.status === "soon");
}

/** Providers the hub can start a connect flow for. */
export function availableProviders(): IntegrationProvider[] {
  return INTEGRATION_PROVIDERS.filter((p) => p.status === "available");
}

/** Registry lookup by id; null for ids the catalog does not know. */
export function providerById(id: string): IntegrationProvider | null {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id) ?? null;
}
