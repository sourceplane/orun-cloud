/**
 * The connection providers the Integrations hub presents.
 *
 * Orun is an orchestration plane over external services, so "Integrations" is a
 * first-class hub (not a settings sub-page): you connect the providers Orun
 * coordinates. GitHub and Slack are live (IH1); the rest are on the roadmap
 * and render as non-interactive "Soon" slots so the hub communicates direction
 * honestly, without faking functionality.
 *
 * Dependency-free (no React, no icons) so the catalog is unit-testable; icon
 * names resolve in the renderer.
 */

export type ProviderStatus = "available" | "soon";

export interface IntegrationProvider {
  id: "github" | "supabase" | "cloudflare" | "slack";
  name: string;
  /** One-line description of what connecting this provider unlocks. */
  description: string;
  status: ProviderStatus;
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
    icon: "Github",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Connect a Postgres project for database state and migrations.",
    status: "soon",
    icon: "Database",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Deploy Workers, R2, and DNS as part of your plans.",
    status: "soon",
    icon: "Cloud",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post run and deployment notifications to your channels.",
    status: "available",
    icon: "MessageSquare",
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
