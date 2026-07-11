import { redirect } from "next/navigation";

/**
 * Compatibility redirect (orun-work-v5 WV1). The initiative portfolio is
 * now the Work home's Initiatives lens; deep links keep working.
 */
export default function LegacyInitiativesRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/work?lens=initiatives`);
}
