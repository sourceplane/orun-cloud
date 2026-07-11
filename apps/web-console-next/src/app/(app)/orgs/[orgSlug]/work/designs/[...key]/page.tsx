"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { DesignDetail } from "@/components/work/design-detail";

export default function DesignPage() {
  const params = useParams<{ orgSlug: string; key: string[] }>();
  const slug = params?.orgSlug ?? "";
  const key = (params?.key ?? []).map(decodeURIComponent).join("/");
  return <OrgScope slug={slug}>{(org) => <DesignDetail orgId={org.id} designKey={key} />}</OrgScope>;
}
