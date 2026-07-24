"use client";

// Nested per-connection route (saas-integration-registry IR2; unified by IR-U).
// The connection renders in the integration's page chrome: for a provider whose
// archetype has a console detail body (IX2–IX4) that is the tabbed detail page
// focused on this connection; otherwise it falls back to the provider space's
// focused sub-view. The shared ProviderRoute (IX5) makes the same registry-driven
// decision as `/integrations/{provider}`.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ProviderRoute } from "@/components/integrations/detail/provider-route";

export default function NestedConnectionRoute() {
  const params = useParams<{ orgSlug: string; slug: string; connectionId: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const providerId = params?.slug ?? "";
  const connectionId = params?.connectionId ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => (
        <ProviderRoute orgId={org.id} orgSlug={orgSlug} providerId={providerId} focusConnectionId={connectionId} />
      )}
    </OrgScope>
  );
}
