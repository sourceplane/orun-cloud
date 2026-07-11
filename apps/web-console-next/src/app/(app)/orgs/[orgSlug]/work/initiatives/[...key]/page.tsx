"use client";

// Initiative detail. Keys may contain slashes (imported corpora use
// path-like keys), so the segment is a catch-all joined back together.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { InitiativeDetail } from "@/components/work/initiative-detail";

export default function InitiativePage() {
  const params = useParams<{ orgSlug: string; key: string[] }>();
  const slug = params?.orgSlug ?? "";
  const key = (params?.key ?? []).map(decodeURIComponent).join("/");
  return <OrgScope slug={slug}>{(org) => <InitiativeDetail orgId={org.id} initiativeKey={key} />}</OrgScope>;
}
