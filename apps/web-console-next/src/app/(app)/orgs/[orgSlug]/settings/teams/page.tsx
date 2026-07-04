import { redirect } from "next/navigation";

// Teams was promoted from Settings to a first-class product surface in the main
// sidebar. Preserve deep links by redirecting the old settings path.
export default async function LegacyTeamsRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/orgs/${orgSlug}/teams`);
}
