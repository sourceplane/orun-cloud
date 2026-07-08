import { redirect } from "next/navigation";

/** Compatibility redirect (saas-settings-ia SI5): `/account/security` → `/you/security`. */
export default function LegacyAccountSecurityRedirect() {
  redirect("/you/security");
}
