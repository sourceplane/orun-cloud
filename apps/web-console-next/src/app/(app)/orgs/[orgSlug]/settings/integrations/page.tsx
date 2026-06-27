import { redirect } from "next/navigation";

// Integrations was promoted out of Settings into a first-class org-level
// Connections hub. Redirect the old settings location to it.
export default function SettingsIntegrationsRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/integrations`);
}
