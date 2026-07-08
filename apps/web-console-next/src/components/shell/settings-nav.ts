/**
 * Pure navigation model for the workspace Settings surface.
 *
 * Dependency-free (no React, no icons) so the group/link composition is
 * unit-testable and shared by the settings layout's secondary nav rail (desktop)
 * and its horizontal pill bar (mobile). Icon resolution happens in the renderer.
 *
 * Settings is the dedicated "organization administration" surface: the primary
 * sidebar stays product-focused (Projects, Usage), while everything that
 * configures the org — identity, people, billing, and developer integrations —
 * lives here behind `/orgs/[slug]/settings/*`.
 */

export interface SettingsNavLink {
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
  /** short helper copy shown under the label in the rail. */
  description: string;
  /**
   * When true the link is active only on an exact pathname match. Used for the
   * Settings index (General) so it doesn't stay highlighted on every child page.
   */
  exact?: boolean;
}

export interface SettingsNavGroup {
  /** stable id for keys/tests. */
  id: string;
  label: string;
  links: SettingsNavLink[];
}

/**
 * Build the grouped settings navigation for an org. Grouping mirrors how modern
 * consoles (Stripe, Vercel, Linear) split settings: who/what the org is, how
 * it pays, and the developer-facing integration surface.
 */
export function buildSettingsNav(orgSlug: string): SettingsNavGroup[] {
  const base = `/orgs/${orgSlug}/settings`;
  return [
    {
      id: "organization",
      label: "Workspace",
      links: [
        {
          href: base,
          label: "General",
          icon: "Building2",
          description: "Name, slug, and identifiers",
          exact: true,
        },
        {
          // People & Access (saas-settings-ia SI3): Members, Invitations
          // (Pending), and Access consolidated onto one tabbed surface.
          href: `${base}/people`,
          label: "People & Access",
          icon: "Users",
          description: "Members, invitations, roles, and effective access",
        },
        {
          href: `${base}/notifications`,
          label: "Email notifications",
          icon: "Bell",
          description: "Your personal email notification preferences",
        },
      ],
    },
    // The Account groups (Overview, Workspaces, Members, Roles, Billing) are no
    // longer rendered inline here: SI2 promoted them to their own Account
    // doorway (`account-nav.ts` / `buildAccountNav`), reached from the scope
    // switcher's Account chip, so the parent scope is not a subsection of a
    // child workspace's settings.
    {
      // Event-routing surfaces (saas-event-streaming ES6): rules that fan events
      // out to channels, the channels themselves, and the dead-letter ops view.
      // Labelled "Event routing" to disambiguate from a person's own
      // "Email notifications" preferences above (saas-settings-ia SI1).
      id: "notifications",
      label: "Event routing",
      links: [
        {
          href: `${base}/notifications/rules`,
          label: "Rules",
          icon: "BellRing",
          description: "Route events to email or Slack",
        },
        {
          href: `${base}/notifications/channels`,
          label: "Channels",
          icon: "Slack",
          description: "Slack delivery channels",
        },
        {
          href: `${base}/notifications/dead-letters`,
          label: "Dead letters",
          icon: "Inbox",
          description: "Failed deliveries — replay",
        },
      ],
    },
    {
      id: "developer",
      label: "Developer",
      links: [
        {
          href: `${base}/api-keys`,
          label: "API keys",
          icon: "KeyRound",
          description: "Programmatic access tokens",
        },
        // Sessions & devices moved to the personal account area — CLI sessions
        // are per-user, not workspace-scoped (saas-settings-ia SI1).
        {
          href: `${base}/webhooks`,
          label: "Webhooks",
          icon: "Webhook",
          description: "Signed event deliveries",
        },
        // Config (settings, flags, secrets, policies) was promoted to the
        // dedicated top-level "Secrets" surface (`/orgs/:slug/secrets`), so it
        // no longer appears under Settings › Developer.
        {
          href: `${base}/audit`,
          label: "Audit log",
          icon: "ScrollText",
          description: "Security and change history",
        },
      ],
    },
  ];
}

/** Flatten the grouped nav into an ordered link list (used by the mobile bar). */
export function flattenSettingsNav(groups: SettingsNavGroup[]): SettingsNavLink[] {
  return groups.flatMap((g) => g.links);
}

/**
 * Resolve the active settings link for a pathname. The General (index) link
 * matches exactly; every other link matches when the path is the href or a
 * child of it (so `/settings/webhooks/ep_123` keeps Webhooks active).
 */
export function isSettingsLinkActive(link: SettingsNavLink, pathname: string | null): boolean {
  if (!pathname) return false;
  if (link.exact) return pathname === link.href;
  return pathname === link.href || pathname.startsWith(`${link.href}/`);
}
