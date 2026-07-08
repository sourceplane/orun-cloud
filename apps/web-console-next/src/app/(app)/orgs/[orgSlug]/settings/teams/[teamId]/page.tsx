import { redirect } from "next/navigation";

// Teams was promoted from Settings to a first-class product surface. Preserve
// deep links to a specific team by redirecting the old settings path.
export default async function LegacyTeamRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>;
}) {
  const { orgSlug, teamId } = await params;
  redirect(`/orgs/${orgSlug}/teams/${teamId}`);
}
