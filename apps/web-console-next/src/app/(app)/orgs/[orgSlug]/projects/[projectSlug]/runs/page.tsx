import { redirect } from "next/navigation";

// The per-repo runs list is superseded by the org-level Activities feed (which
// spans every repo, filterable by repo/environment/source). Redirect any old
// per-repo runs link there. The run DETAIL route (`./[runId]`) is unaffected and
// is still deep-linked from Activities.
export default function RepoRunsRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/activities`);
}
