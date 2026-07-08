import { redirect } from "next/navigation";

/**
 * Compatibility redirect (saas-settings-ia SI5). The personal account area moved
 * from `/account` to `/you` to end the collision with the tenant "Account"
 * scope. Old links keep working.
 */
export default function LegacyAccountRedirect() {
  redirect("/you");
}
