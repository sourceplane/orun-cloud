/**
 * Pure navigation model for the Account settings doorway (saas-settings-ia SI2).
 *
 * The Account is the tenant/billing/governance scope above a workspace set
 * (`parent_org_id ?? id`, resolved server-side). Its settings used to be a group
 * buried inside the workspace Settings rail; SI2 promotes them to their own
 * doorway — a focused surface reached from the scope switcher's Account chip —
 * so the parent scope is no longer rendered as a subsection of one of its
 * children.
 *
 * Relabel & regroup only: the pages keep their `/orgs/[slug]/settings/account/*`
 * (and `/settings/billing`) URLs — every page reads through the current org and
 * resolves up to the account — so nothing 404s. Dependency-free and unit-testable
 * like `settings-nav.ts`, whose `SettingsNavGroup` shape it reuses so the
 * settings layout renders it unchanged.
 */

import type { SettingsNavGroup } from "./settings-nav";

/** Build the Account doorway navigation for the current org's account. */
export function buildAccountNav(orgSlug: string): SettingsNavGroup[] {
  const base = `/orgs/${orgSlug}/settings`;
  return [
    {
      id: "account",
      label: "Account",
      links: [
        {
          href: `${base}/account`,
          label: "Overview",
          icon: "Building2",
          description: "The account above this workspace",
          exact: true,
        },
        {
          href: `${base}/account/workspaces`,
          label: "Workspaces",
          icon: "Boxes",
          description: "All workspaces under the account",
        },
        {
          href: `${base}/account/members`,
          label: "Members",
          icon: "Users",
          description: "Everyone with account-level presence",
        },
        {
          href: `${base}/account/roles`,
          label: "Roles",
          icon: "ShieldCheck",
          description: "Account-wide authority — grant, list, revoke",
        },
        {
          // Billing bills at the account (`effectiveBillingOrgId`); it lives in
          // the account doorway (SI1 folded it out of a standalone group).
          href: `${base}/billing`,
          label: "Billing & plan",
          icon: "Receipt",
          description: "Plan, invoices, payment",
        },
      ],
    },
  ];
}

/**
 * True when a settings pathname belongs to the Account doorway rather than the
 * workspace Settings surface — the account pages and the account-billed Billing
 * page. Drives which rail (and heading) the settings layout renders.
 */
export function isAccountSettingsPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return /^\/orgs\/[^/]+\/settings\/(account|billing)(\/|$)/.test(pathname);
}
