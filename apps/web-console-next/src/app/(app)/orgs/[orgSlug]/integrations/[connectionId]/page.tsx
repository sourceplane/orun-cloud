"use client";

// Per-connection detail route (saas-integration-hub IH8). A thin wrapper
// around the shared detail component, mirroring the hub route above it.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ConnectionDetail } from "@/components/integrations/connection-detail";

export default function ConnectionDetailPage() {
  const params = useParams<{ orgSlug: string; connectionId: string }>();
  const slug = params?.orgSlug ?? "";
  const connectionId = params?.connectionId ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <ConnectionDetail orgId={org.id} orgSlug={slug} connectionId={connectionId} />}
    </OrgScope>
  );
}
