"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkHome } from "@/components/work/work-home";

export default function WorkPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <WorkHome orgId={org.id} />}</OrgScope>;
}
