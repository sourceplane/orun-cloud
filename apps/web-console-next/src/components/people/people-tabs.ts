/**
 * Pure navigation model for the People & Access surface (saas-settings-ia SI3).
 *
 * Members, Invitations (Pending), and Access were three separate settings nav
 * items answering one question — who can reach this workspace, and how. They
 * collapse into one deep-linkable tabbed surface at `/settings/people`, with the
 * active tab carried in the `?tab=` query param. Dependency-free and unit-tested
 * like the other nav models.
 */

export type PeopleTab = "members" | "pending" | "roles" | "access";

export interface PeopleTabDef {
  key: PeopleTab;
  label: string;
  /** Deep link to this tab. `members` is the bare surface (default tab). */
  href: string;
}

/** The People & Access tabs for an org's workspace-scoped people surface. */
export function buildPeopleTabs(orgSlug: string): PeopleTabDef[] {
  const base = `/orgs/${orgSlug}/settings/people`;
  return [
    { key: "members", label: "Members", href: base },
    { key: "pending", label: "Pending", href: `${base}?tab=pending` },
    { key: "roles", label: "Roles", href: `${base}?tab=roles` },
    { key: "access", label: "Access", href: `${base}?tab=access` },
  ];
}

const TABS: readonly PeopleTab[] = ["members", "pending", "roles", "access"];

/** Resolve the `?tab=` param to a valid tab, defaulting to Members. */
export function resolvePeopleTab(param: string | null | undefined): PeopleTab {
  return (TABS as string[]).includes(param ?? "") ? (param as PeopleTab) : "members";
}
