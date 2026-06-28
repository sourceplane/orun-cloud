"use client";

// The catalog entity page (saas-catalog-portal CP5). The deep-linkable,
// shareable dedicated service page from the design — identity hero, ops strip,
// Overview / Docs / Dependencies / Activity / Scorecard tabs and the ownership
// rail — rendered by the portal `ServicePage` over the same shared org-graph
// cache as the index. The "Open full service page" action on the index drawer
// drills in here.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { ServicePageLoader } from "@/components/catalog/portal/service-page-loader";

export default function CatalogEntityPage() {
  const params = useParams<{ orgSlug: string; entityKey: string }>();
  const slug = params?.orgSlug ?? "";
  const entityKey = params?.entityKey ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <ServicePageLoader orgId={org.id} orgSlug={slug} entityKey={entityKey} />}
    </OrgScope>
  );
}
