/**
 * Pure navigation model for the sidebar and the mobile nav drawer (Task 0127 /
 * U11). Dependency-free (no React, no icons) so the section/link composition is
 * unit-testable and shared by both `sidebar.tsx` (desktop) and `mobile-nav.tsx`
 * (the Sheet drawer on small screens). Icon resolution happens in the renderer.
 */

export interface NavLink {
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
  /** When true the link opens a nested sidebar panel (renderer shows a ›). */
  subPanel?: boolean;
}

export interface NavSection {
  /** stable id for keys/tests. */
  id: string;
  label: string;
  links: NavLink[];
  /**
   * When true the section is the rail's "manage" footer (Usage, Settings) — the
   * renderer pins it to the bottom, separated from the product surfaces above.
   * The split keeps the top of the rail to the day-to-day work surfaces.
   */
  footer?: boolean;
}

export interface NavScope {
  orgSlug?: string | null;
  projectSlug?: string | null;
}

/**
 * Build the sidebar sections for the current URL scope. Org and project
 * sections only appear when their slug is present, matching the URL-driven
 * scope invariant (no local navigation state).
 */
export function buildNavSections(scope: NavScope): NavSection[] {
  const sections: NavSection[] = [];
  const orgSlug = scope.orgSlug ?? null;
  const orgBase = orgSlug ? `/orgs/${orgSlug}` : null;

  // The Workspace/Organizations section is intentionally omitted: the org
  // switcher at the top of the sidebar is the home for org selection (and links
  // to the full list), so a separate "Organizations" nav row would be redundant.
  //
  // Account (Profile / Security activity) is likewise not a nav section — the
  // signed-in identity lives in the account chip at the bottom of the sidebar.

  if (orgBase) {
    // The primary sidebar is product-focused: the day-to-day surfaces an
    // operator works in. Organization administration (members, billing, API
    // keys, webhooks, config, audit, identity) lives behind a single Settings
    // entry, which opens the dedicated `/settings` surface with its own
    // secondary navigation (see `settings-nav.ts`).
    // Product surfaces — the day-to-day work, at the top of the rail.
    sections.push({
      id: "org",
      label: orgSlug ? `Workspace · ${orgSlug}` : "Workspace",
      links: [
        // The Overview is the Workspace landing (the org root), so it is the
        // rail's home row — first, above Catalog.
        { href: orgBase, label: "Overview", icon: "LayoutDashboard" },
        { href: `${orgBase}/catalog`, label: "Catalog", icon: "Boxes" },
        { href: `${orgBase}/activities`, label: "Activities", icon: "Activity" },
        // Teams — the human-scale organizing primitive, promoted out of Settings
        // to a first-class product surface (à la Datadog Teams).
        { href: `${orgBase}/teams`, label: "Teams", icon: "UsersRound" },
        { href: `${orgBase}/projects`, label: "Git Repos", icon: "FolderKanban" },
        // Integrations is a first-class connections hub (GitHub today; Supabase,
        // Cloudflare, Slack on the roadmap), promoted out of Settings.
        { href: `${orgBase}/integrations`, label: "Integrations", icon: "Plug" },
        // Secrets & Config is a dedicated product surface — the secret chain,
        // rotation health, feature flags, settings, and policies at any scope —
        // promoted out of Settings › Developer › Config and the per-repo tabs.
        { href: `${orgBase}/secrets`, label: "Secrets", icon: "KeyRound" },
      ],
    });

    // "Manage" surfaces — pinned to the bottom of the rail (above the account
    // chip). Usage and Settings are visited occasionally, not day-to-day, so
    // they sit out of the way of the product nav rather than interleaved with it.
    sections.push({
      id: "org-manage",
      label: "Manage",
      footer: true,
      links: [
        { href: `${orgBase}/usage`, label: "Usage & quota", icon: "Gauge" },
        // Opens the dedicated settings panel — flagged so the renderer shows a ›.
        { href: `${orgBase}/settings`, label: "Settings", icon: "Settings", subPanel: true },
      ],
    });
  }

  // The per-repo section is intentionally omitted from the sidebar: selecting a
  // repo under "Git Repos" opens a settings-style page whose sections
  // (Environments, Git, CLI, Storage, Config) live in a horizontal tab bar
  // (see `repo-tabs.ts` / the repo layout). Runs moved out to the org-level
  // Activities feed. The sidebar stays a flat, org-scoped product nav.

  return sections;
}

/**
 * Resolve the active link for a pathname: the longest matching `href` prefix
 * wins, so `/orgs/x/projects/y/environments` highlights Environments, not
 * Projects. `/orgs` (exact) only highlights when the path is exactly `/orgs`.
 *
 * The org root `/orgs/:slug` (the Overview home row) is also matched exactly —
 * otherwise, as a prefix of every org sub-route, it would light up on Catalog,
 * Activities, and the rest.
 */
export function isLinkActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/orgs") return pathname === "/orgs";
  if (href === "/account") return pathname === "/account";
  // The org root (`/orgs/<slug>`, no further segment) is an exact match.
  if (/^\/orgs\/[^/]+$/.test(href)) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
