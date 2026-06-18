"use client";

// OV7 — the org-global catalog browser (index). A thin route wrapper around the
// shared 3-panel workbench in "index" mode: selection is a fast `?entity=` peek,
// double-click drills into the dedicated entity page (which renders the same
// workbench). See `components/catalog/catalog-workbench.tsx`.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { CatalogWorkbench } from "@/components/catalog/catalog-workbench";

export default function CatalogPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>{(org) => <CatalogWorkbench orgId={org.id} orgSlug={slug} mode="index" />}</OrgScope>
  );
}
