"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { WorkWorkbench } from "@/components/work/work-workbench";

export default function WorkPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <WorkWorkbench orgId={org.id} />}</OrgScope>;
}
