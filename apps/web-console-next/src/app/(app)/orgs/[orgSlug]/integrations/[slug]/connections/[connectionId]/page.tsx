"use client";

// Nested per-connection route (saas-integration-registry IR2; unified by
// IR-U): the connection is NOT a separate page — it renders inside the
// provider space as a focused sub-view of the Connections tab, sharing the
// integration header and tab bar. One page, one chrome.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ProviderSpace } from "@/components/integrations/provider-space";

export default function NestedConnectionRoute() {
  const params = useParams<{ orgSlug: string; slug: string; connectionId: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const providerId = params?.slug ?? "";
  const connectionId = params?.connectionId ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => (
        <ProviderSpace
          orgId={org.id}
          orgSlug={orgSlug}
          providerId={providerId}
          focusConnectionId={connectionId}
        />
      )}
    </OrgScope>
  );
}
