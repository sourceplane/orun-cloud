"use client";

// The per-provider integration space route (saas-secrets-platform SP2,
// design addendum SP-A2). A thin wrapper around the shared space component,
// mirroring the hub and connection-detail routes beside it. The static
// `providers` segment wins over the sibling `[connectionId]` dynamic segment.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ProviderSpace } from "@/components/integrations/provider-space";

export default function ProviderSpacePage() {
  const params = useParams<{ orgSlug: string; providerId: string }>();
  const slug = params?.orgSlug ?? "";
  const providerId = params?.providerId ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <ProviderSpace orgId={org.id} orgSlug={slug} providerId={providerId} />}
    </OrgScope>
  );
}
