import { redirect } from "next/navigation";

/**
 * Compatibility redirect (saas-settings-ia SI3). Members, Invitations, and
 * Access consolidated into the People & Access surface; Members is its default
 * tab.
 */
export default function LegacyMembersRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/settings/people`);
}
