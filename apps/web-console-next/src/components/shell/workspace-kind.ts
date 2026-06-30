import type { PublicOrganization } from "@saas/contracts/membership";

/**
 * The Account-vs-Workspace badge label for an org in the switcher (WID4/WID5).
 *
 * `kind` is the server-derived role (`account` when the org is a root/parent,
 * else `workspace`); `isAccountRoot` is the boolean form of the same fact. We
 * return null when the org carries neither field (older payloads predating WID4)
 * so the badge is simply omitted rather than guessed.
 */
export function workspaceKindBadge(
  org: Pick<PublicOrganization, "kind" | "isAccountRoot">,
): "Account" | "Workspace" | null {
  if (org.kind === undefined && org.isAccountRoot === undefined) return null;
  const isAccount = org.kind === "account" || org.isAccountRoot === true;
  return isAccount ? "Account" : "Workspace";
}

/**
 * The display name of the **Account** a child workspace belongs to
 * (saas-integration-tenancy IT9), resolved from the org list the user can
 * already see — `accountId` (the parent's `ws_…`, WID4) matched against each
 * org's `workspaceRef`. Returns null for an Account root / standalone org, when
 * the fields are absent (pre-WID4 payloads), or when the account is not in the
 * visible set. No new endpoint — pure, client-side resolution.
 */
export function accountNameFor(
  org: Pick<PublicOrganization, "workspaceRef" | "accountId">,
  allOrgs: ReadonlyArray<Pick<PublicOrganization, "name" | "workspaceRef">>,
): string | null {
  // Account root / standalone: accountId === own workspaceRef (or unset).
  if (!org.accountId || !org.workspaceRef || org.accountId === org.workspaceRef) return null;
  const account = allOrgs.find((o) => o.workspaceRef === org.accountId);
  return account?.name ?? null;
}
