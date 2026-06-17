import { pickAccountBillingOrg, type AccountOrgLike } from "@/components/billing/account-org";

/**
 * The org slug the always-visible chrome should treat as "current".
 *
 * The URL is authoritative whenever it carries an org. On org-less routes
 * (`/orgs`, `/account`, …) the mobile panels still need a concrete org so the
 * operator is never forced to re-pick one to keep working: fall back to the
 * remembered last-used org, then to the account's default (billing-parent) org.
 * This mirrors the desktop landing redirect ("remember last org, else default")
 * but applies it live to the mobile topbar/bottom-nav rather than only at `/`.
 *
 * A remembered slug that no longer resolves (org archived or access revoked) is
 * dropped once the org list is known, so a stale hint can't pin the chrome to a
 * dead org. Returns null only while nothing is resolvable yet (org list still
 * loading with no hint) or the account genuinely has no orgs — in which case the
 * shell's OnboardingGate takes over. Pure given its inputs so the precedence is
 * unit-testable; callers supply `readLastOrgSlug()` and the shared org list.
 */
export function resolveEffectiveOrgSlug(input: {
  urlSlug: string | null;
  lastOrgSlug: string | null;
  orgs: AccountOrgLike[] | null;
}): string | null {
  const { urlSlug, lastOrgSlug, orgs } = input;
  if (urlSlug) return urlSlug;
  if (lastOrgSlug) {
    // Trust the cached hint until the org list loads (instant chrome), then keep
    // it only while it still points at an accessible org.
    if (!orgs || orgs.some((o) => o.slug === lastOrgSlug)) return lastOrgSlug;
  }
  if (orgs) return pickAccountBillingOrg(orgs)?.slug ?? null;
  return null;
}
