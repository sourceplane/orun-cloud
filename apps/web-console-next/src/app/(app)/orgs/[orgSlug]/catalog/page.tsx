"use client";

// The org-global catalog index — the design-faithful internal-developer-portal
// surface (saas-catalog-portal). A thin route wrapper around `CatalogPortal`:
// header + metric tiles + toolbar + Table/Board/Map views, with a `?entity=`
// peek that double-click drills into the dedicated entity page. The deep entity
// route still renders the existing workbench until it adopts the portal drawer.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { CatalogPortal } from "@/components/catalog/catalog-portal";

export default function CatalogPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <CatalogPortal orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
