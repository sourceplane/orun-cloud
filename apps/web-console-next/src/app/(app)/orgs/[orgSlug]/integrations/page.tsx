"use client";

// The org-level Integrations hub (promoted out of Settings). A thin route
// wrapper around the shared hub component.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { IntegrationsHub } from "@/components/integrations/integrations-hub";

export default function IntegrationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <IntegrationsHub orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
