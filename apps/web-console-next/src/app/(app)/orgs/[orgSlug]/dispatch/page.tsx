// saas-dispatch DX3: the org ROOT is the Dispatch landing; this route stays
// as a stable alias for deep links and redirects home (no duplicate surface).
import { redirect } from "next/navigation";

export default async function DispatchAliasPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/orgs/${orgSlug}`);
}
