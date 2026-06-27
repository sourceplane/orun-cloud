/**
 * Pure navigation model for a repo's settings surface.
 *
 * Selecting a repo from "Git Repos" opens a settings-style page whose sections
 * — Environments, Git, CLI, Storage, Config — are horizontal tabs (Vercel
 * project-settings pattern), not a sidebar section. These are the per-repo
 * surfaces that used to live in the sidebar's project section; runs moved out to
 * the org-level Activities feed, so they are intentionally not a tab here.
 *
 * Dependency-free (no React, no icons) so the composition is unit-testable and
 * shared by the renderer (icon resolution happens there).
 */

export interface RepoTab {
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
}

/** Build the ordered repo settings tabs for a project scope. */
export function buildRepoTabs(orgSlug: string, projectSlug: string): RepoTab[] {
  const base = `/orgs/${orgSlug}/projects/${projectSlug}`;
  return [
    { href: `${base}/environments`, label: "Environments", icon: "Boxes" },
    { href: `${base}/git`, label: "Git", icon: "GitBranch" },
    { href: `${base}/cli`, label: "CLI", icon: "Terminal" },
    { href: `${base}/storage`, label: "Storage", icon: "HardDrive" },
    { href: `${base}/config`, label: "Config", icon: "SlidersHorizontal" },
  ];
}

/**
 * Resolve the active tab for a pathname: the href or a child of it is active, so
 * `/environments/prod` keeps Environments highlighted.
 */
export function isRepoTabActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Whether a repo subpath is a full-screen drill-in that should render WITHOUT
 * the settings tab chrome — currently the run detail (`…/runs/<id>`), which is
 * reached from the org Activities feed, and the bare `…/runs` redirect.
 */
export function isRepoDetailRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return /\/projects\/[^/]+\/runs(\/|$)/.test(pathname);
}
