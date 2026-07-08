import { redirect } from "next/navigation";

/** Compatibility redirect (saas-settings-ia SI5): `/account/sessions` → `/you/sessions`. */
export default function LegacyAccountSessionsRedirect() {
  redirect("/you/sessions");
}
