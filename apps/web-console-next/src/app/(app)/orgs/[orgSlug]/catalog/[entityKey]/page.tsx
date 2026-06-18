"use client";

// The catalog entity page (saas-service-catalog). A deep-linkable, shareable
// view of one component — rendered by the SAME 3-panel workbench as the index
// (in "entity" mode) so drilling in keeps the list · detail layout instead of
// collapsing to a single column. The path key is the focused selection; the
// detail panel carries the Overview/Dependencies tabs.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { CatalogWorkbench } from "@/components/catalog/catalog-workbench";

export default function CatalogEntityPage() {
  const params = useParams<{ orgSlug: string; entityKey: string }>();
  const slug = params?.orgSlug ?? "";
  const entityKey = params?.entityKey ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <CatalogWorkbench orgId={org.id} orgSlug={slug} mode="entity" entityKey={entityKey} />}
    </OrgScope>
  );
}
