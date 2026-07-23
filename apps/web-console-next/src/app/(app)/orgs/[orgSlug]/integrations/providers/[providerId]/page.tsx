"use client";

// Redirect stub (saas-integration-registry IR2): the SP2-era provider-space
// route moved to the canonical `/integrations/{provider}`. Bookmarks and
// shipped deep links (`?create=1`, `?connection=`, `?connect=1`) carry
// through — the shipped `settings/integrations` stub precedent.

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";

export default function LegacyProviderSpaceRedirect() {
  const params = useParams<{ orgSlug: string; providerId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgSlug = params?.orgSlug ?? "";
  const providerId = params?.providerId ?? "";

  React.useEffect(() => {
    if (!orgSlug || !providerId) return;
    const qs = searchParams?.toString();
    router.replace(`/orgs/${orgSlug}/integrations/${providerId}${qs ? `?${qs}` : ""}`);
  }, [orgSlug, providerId, searchParams, router]);

  return null;
}
