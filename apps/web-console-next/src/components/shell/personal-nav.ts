/**
 * Pure navigation model for the personal ("You") account area — the actor-scoped
 * settings that belong to the signed-in human, independent of any workspace or
 * account (saas-settings-ia SI2).
 *
 * Dependency-free (no React, no icons) so it is unit-testable and shared by the
 * account sub-nav tabs and the identity-chip menu. Icon resolution and active
 * state happen in the renderers.
 *
 * These routes carry no `orgId`: Profile and Security read the authenticated
 * actor; Sessions & devices lists the user's per-user CLI logins. This is the
 * third scope alongside Account and Workspace — the one doorway reached from the
 * identity chip rather than the scope switcher.
 */

export interface PersonalNavLink {
  key: "profile" | "security" | "sessions";
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
}

/** Build the personal-area navigation (Profile, Security, Sessions & devices). */
export function buildPersonalNav(): PersonalNavLink[] {
  return [
    { key: "profile", href: "/you", label: "Profile", icon: "User2" },
    { key: "security", href: "/you/security", label: "Security activity", icon: "ShieldCheck" },
    { key: "sessions", href: "/you/sessions", label: "Sessions & devices", icon: "Terminal" },
  ];
}
