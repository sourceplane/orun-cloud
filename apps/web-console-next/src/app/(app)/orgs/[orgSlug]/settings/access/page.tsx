import { redirect } from "next/navigation";

/**
 * Compatibility redirect (saas-settings-ia SI3). Effective access became the
 * "Access" tab of the People & Access surface.
 */
export default function LegacyAccessRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/settings/people?tab=access`);
}
