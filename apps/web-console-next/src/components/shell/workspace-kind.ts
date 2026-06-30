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
