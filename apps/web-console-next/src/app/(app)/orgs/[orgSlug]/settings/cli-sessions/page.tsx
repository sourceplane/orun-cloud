import { redirect } from "next/navigation";

/**
 * Compatibility redirect (saas-settings-ia SI1). CLI sessions are per-user, not
 * workspace-scoped, so "Sessions & devices" moved from Settings › Developer to
 * the personal account area. Keeps old `/orgs/[slug]/settings/cli-sessions`
 * links working.
 */
export default function LegacyCliSessionsRedirect() {
  redirect(`/account/sessions`);
}
