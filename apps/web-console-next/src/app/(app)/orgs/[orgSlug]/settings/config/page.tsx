import { redirect } from "next/navigation";

/**
 * Compatibility redirect. Config (settings, feature flags, secrets, policies)
 * was promoted from Settings › Developer to the dedicated top-level Secrets &
 * Config surface; this keeps old links to `/orgs/[slug]/settings/config` working.
 */
export default function LegacyConfigRedirect({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/secrets`);
}
