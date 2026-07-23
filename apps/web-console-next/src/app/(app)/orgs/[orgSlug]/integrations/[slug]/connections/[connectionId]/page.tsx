"use client";

// Nested per-connection detail (saas-integration-registry IR2): a connection
// lives UNDER its integration's canonical space. Thin wrapper around the
// shared detail component; the back affordance points at the space, not the
// hub.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ConnectionDetail } from "@/components/integrations/connection-detail";

export default function NestedConnectionDetailPage() {
  const params = useParams<{ orgSlug: string; slug: string; connectionId: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const providerId = params?.slug ?? "";
  const connectionId = params?.connectionId ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => (
        <ConnectionDetail
          orgId={org.id}
          orgSlug={orgSlug}
          connectionId={connectionId}
          backHref={`/orgs/${orgSlug}/integrations/${providerId}`}
          backLabel={providerId}
        />
      )}
    </OrgScope>
  );
}
