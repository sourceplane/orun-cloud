import { redirect } from "next/navigation";

/**
 * Compatibility redirect (saas-settings-ia SI3). Invitations became the
 * "Pending" tab of the People & Access surface — an invite is a member who
 * hasn't accepted yet.
 */
export default function LegacyInvitationsRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/settings/people?tab=pending`);
}
